import { endpoint, authenticate, requireRole, text, validateAnalysis, throttle, fail, json } from '../lib/security.mjs';
import { protectField, protectRecord, revealRecord, reserveId } from '../lib/data-crypto.mjs';

export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    if (data.action === 'book') {
        requireRole(user, 'patient');
        await throttle(sql, 'book:' + user.id, 20);
        if (data.patientIin !== user.iin) fail(403, 'Недостаточно прав');
        if (!/^[a-f0-9-]{36}$/i.test(data.doctorIin ?? '')) fail(400, 'Некорректный идентификатор врача');
        const [doctor] = await sql`SELECT id, iin FROM users WHERE public_id::text = ${data.doctorIin} AND role = 'doctor' AND is_active = true`;
        if (!doctor) fail(404, 'Врач не найден');
        const doctorIin = doctor.iin;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time ?? '')) fail(400, 'Некорректная дата');
        const parsed = new Date(data.date + 'T00:00:00Z');
        if (Number.isNaN(+parsed) || parsed.toISOString().slice(0, 10) !== data.date) fail(400, 'Некорректная дата');
        const localNow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
        if (data.date + ' ' + data.time <= localNow) fail(400, 'Выберите будущее время');
        if (!['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'].includes(data.time)) fail(400, 'Выберите время из сетки записи');
        if (+parsed > Date.now() + 180 * 86400000) fail(400, 'Запись доступна на ближайшие 180 дней');
        const type = text(data.type, 'type', 30);
        if (!['В клинике', 'Онлайн', 'clinic', 'online'].includes(type)) fail(400, 'Некорректный формат');
        const message = typeof data.message === 'string' ? data.message.slice(0, 2000) : '';
        const secured = protectRecord('appointments', { id: await reserveId(sql, 'appointments'), message });
        const rows = await sql`WITH created AS (INSERT INTO appointments(id, patient_iin, doctor_iin, date, time, type, message, status)
            VALUES (${secured.id}, ${user.iin}, ${doctorIin}, ${data.date}, ${data.time}, ${type}, ${secured.message}, 'upcoming') RETURNING id),
            audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT ${user.id}, 'appointment_booked', 'appointment', id FROM created) SELECT id FROM created`;
        return json({ id: rows[0].id, message: 'Запись создана' });
    }
    if (data.action === 'get') {
        requireRole(user, 'patient');
        if (data.patientIin !== user.iin) fail(403, 'Недостаточно прав');
        const rows = await sql`SELECT a.*, d.public_id::text AS doctor_iin FROM appointments a
            LEFT JOIN users d ON d.iin = a.doctor_iin WHERE a.patient_iin = ${user.iin} ORDER BY a.date, a.time`;
        return json({ appointments: rows.map(row => revealRecord('appointments', row)) });
    }
    if (data.action === 'get_all_for_doctor') {
        requireRole(user, 'doctor');
        if (data.doctorIin !== user.iin) fail(403, 'Недостаточно прав');
        const rows = await sql`SELECT a.*, u.name AS patient_name FROM appointments a
            LEFT JOIN users u ON a.patient_iin = u.iin
            WHERE a.doctor_iin = ${user.iin} ORDER BY a.date, a.time`;
        return json({ appointments: rows.map(row => revealRecord('appointments', row)) });
    }
    const id = Number(data.appointmentId);
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Некорректный номер записи');
    if (data.action === 'cancel') {
        requireRole(user, 'patient', 'doctor');
        const rows = await sql`WITH updated AS (UPDATE appointments SET status = 'cancelled' WHERE id = ${id}
            AND status = 'upcoming' AND (patient_iin = ${user.iin} OR (doctor_iin = ${user.iin} AND ${user.role} = 'doctor')) RETURNING id),
            audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT ${user.id}, 'appointment_cancelled', 'appointment', id FROM updated) SELECT id FROM updated`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Запись отменена' });
    }
    if (data.action === 'add_treatment') {
        requireRole(user, 'doctor');
        const treatment = protectField(text(data.treatment, 'treatment', 5000), 'appointments', id, 'treatment');
        const rows = await sql`WITH updated AS (UPDATE appointments SET treatment = ${treatment}
            WHERE id = ${id} AND doctor_iin = ${user.iin} AND status = 'upcoming' RETURNING id),
            audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT ${user.id}, 'treatment_updated', 'appointment', id FROM updated) SELECT id FROM updated`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Лечение сохранено' });
    }
    if (data.action === 'complete') {
        requireRole(user, 'doctor');
        const treatment = protectField(typeof data.treatment === 'string' ? data.treatment.slice(0, 5000) : '', 'appointments', id, 'treatment');
        const diagnosis = protectField(typeof data.diagnosis === 'string' ? data.diagnosis.slice(0, 2000) : '', 'appointments', id, 'diagnosis');
        const notes = protectField(typeof data.notes === 'string' ? data.notes.slice(0, 5000) : '', 'appointments', id, 'notes');
        const a = data.analysis;
        if (a != null) validateAnalysis(a);
        const securedAnalysis = a ? protectRecord('analyses', { id: await reserveId(sql, 'analyses'), type: a.type, results: a.results }) : null;
        const rows = a ? await sql`WITH updated AS (
            UPDATE appointments SET status = 'completed', treatment = ${treatment}, diagnosis = ${diagnosis}, notes = ${notes}
            WHERE id = ${id} AND doctor_iin = ${user.iin} AND status = 'upcoming' RETURNING id, patient_iin
        ), saved AS (
            INSERT INTO analyses(id, patient_iin, doctor_email, doctor_id, type, date, results, overall_status)
            SELECT ${securedAnalysis.id}, patient_iin, ${user.email}, ${user.id}, ${securedAnalysis.type}, ${a.date ?? ''}, ${JSON.stringify(securedAnalysis.results)}, ${a.overallStatus ?? 'normal'} FROM updated
        ), audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${user.id}, 'appointment_completed', 'appointment', id FROM updated)
        SELECT id FROM updated` : await sql`WITH updated AS (UPDATE appointments SET status = 'completed', treatment = ${treatment},
            diagnosis = ${diagnosis}, notes = ${notes} WHERE id = ${id} AND doctor_iin = ${user.iin} AND status = 'upcoming' RETURNING id),
            audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT ${user.id}, 'appointment_completed', 'appointment', id FROM updated) SELECT id FROM updated`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Приём завершён' });
    }
    fail(400, 'Неизвестное действие');
});
