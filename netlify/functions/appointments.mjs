import { endpoint, authenticate, requireRole, text, validateAnalysis, fail, json } from '../lib/security.mjs';

export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    if (data.action === 'book') {
        requireRole(user, 'patient');
        if (data.patientIin !== user.iin) fail(403, 'Недостаточно прав');
        if (!/^[a-f0-9-]{36}$/i.test(data.doctorIin ?? '')) fail(400, 'Некорректный идентификатор врача');
        const [doctor] = await sql`SELECT id, iin FROM users WHERE public_id::text = ${data.doctorIin} AND role = 'doctor'`;
        if (!doctor) fail(404, 'Врач не найден');
        const doctorIin = doctor.iin;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time ?? '')) fail(400, 'Некорректная дата');
        const parsed = new Date(data.date + 'T00:00:00Z');
        if (Number.isNaN(+parsed) || parsed.toISOString().slice(0, 10) !== data.date) fail(400, 'Некорректная дата');
        const localNow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Almaty', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
        if (data.date + ' ' + data.time <= localNow) fail(400, 'Выберите будущее время');
        const type = text(data.type, 'type', 30);
        if (!['В клинике', 'Онлайн', 'clinic', 'online'].includes(type)) fail(400, 'Некорректный формат');
        const message = typeof data.message === 'string' ? data.message.slice(0, 2000) : '';
        const rows = await sql`INSERT INTO appointments(patient_iin, doctor_iin, date, time, type, message, status)
            VALUES (${user.iin}, ${doctorIin}, ${data.date}, ${data.time}, ${type}, ${message}, 'upcoming') RETURNING id`;
        return json({ id: rows[0].id, message: 'Запись создана' });
    }
    if (data.action === 'get') {
        if (data.patientIin !== user.iin) fail(403, 'Недостаточно прав');
        return json({ appointments: await sql`SELECT a.*, d.public_id::text AS doctor_iin FROM appointments a
            LEFT JOIN users d ON d.iin = a.doctor_iin WHERE a.patient_iin = ${user.iin} ORDER BY a.date, a.time` });
    }
    if (data.action === 'get_all_for_doctor') {
        requireRole(user, 'doctor');
        if (data.doctorIin !== user.iin) fail(403, 'Недостаточно прав');
        return json({ appointments: await sql`SELECT a.*, d.public_id::text AS doctor_iin, u.name AS patient_name FROM appointments a
            LEFT JOIN users u ON a.patient_iin = u.iin LEFT JOIN users d ON d.iin = a.doctor_iin
            WHERE a.doctor_iin = ${user.iin} ORDER BY a.date, a.time` });
    }
    const id = Number(data.appointmentId);
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Некорректный номер записи');
    if (data.action === 'cancel') {
        const rows = await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${id}
            AND status = 'upcoming' AND (patient_iin = ${user.iin} OR (doctor_iin = ${user.iin} AND ${user.role} = 'doctor')) RETURNING id`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Запись отменена' });
    }
    if (data.action === 'add_treatment') {
        requireRole(user, 'doctor');
        const treatment = text(data.treatment, 'treatment', 5000);
        const rows = await sql`UPDATE appointments SET treatment = ${treatment}
            WHERE id = ${id} AND doctor_iin = ${user.iin} AND status IN ('upcoming', 'completed') RETURNING id`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Лечение сохранено' });
    }
    if (data.action === 'complete') {
        requireRole(user, 'doctor');
        const treatment = typeof data.treatment === 'string' ? data.treatment.slice(0, 5000) : '';
        const diagnosis = typeof data.diagnosis === 'string' ? data.diagnosis.slice(0, 2000) : '';
        const notes = typeof data.notes === 'string' ? data.notes.slice(0, 5000) : '';
        const a = data.analysis;
        if (a != null) validateAnalysis(a);
        const rows = a ? await sql`WITH updated AS (
            UPDATE appointments SET status = 'completed', treatment = ${treatment}, diagnosis = ${diagnosis}, notes = ${notes}
            WHERE id = ${id} AND doctor_iin = ${user.iin} AND status = 'upcoming' RETURNING id, patient_iin
        ), saved AS (
            INSERT INTO analyses(patient_iin, doctor_email, type, date, results, overall_status)
            SELECT patient_iin, ${user.email}, ${a.type}, ${a.date ?? ''}, ${JSON.stringify(a.results)}, ${a.overallStatus ?? 'normal'} FROM updated
        ) SELECT id FROM updated` : await sql`UPDATE appointments SET status = 'completed', treatment = ${treatment},
            diagnosis = ${diagnosis}, notes = ${notes} WHERE id = ${id} AND doctor_iin = ${user.iin} AND status = 'upcoming' RETURNING id`;
        if (!rows.length) fail(409, 'Запись недоступна или уже изменена');
        return json({ message: 'Приём завершён' });
    }
    fail(400, 'Неизвестное действие');
});
