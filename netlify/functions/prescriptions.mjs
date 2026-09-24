import { endpoint, authenticate, requireRole, requirePatientAccess, text, fail, json } from '../lib/security.mjs';

export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    if (data.action === 'get') {
        const prescriptions = await sql`SELECT p.*, d.name AS doctor_name, u.name AS patient_name,
            u.iin AS patient_iin, s.start_at, s.timezone,
            CASE WHEN p.status = 'active' THEN s.reminders_enabled ELSE false END AS reminders_enabled FROM prescriptions p
            JOIN users d ON d.id = p.doctor_id JOIN users u ON u.id = p.patient_id
            LEFT JOIN prescription_schedules s ON s.prescription_id = p.id
            WHERE p.patient_id = ${user.id} OR (p.doctor_id = ${user.id} AND ${user.role} = 'doctor')
            ORDER BY p.created_at DESC`;
        return json({ prescriptions });
    }
    if (data.action === 'create') {
        requireRole(user, 'doctor');
        await requirePatientAccess(sql, user, data.patientIin);
        const medicine = text(data.medicine, 'medicine');
        const dosage = text(data.dosage, 'dosage');
        const instructions = typeof data.instructions === 'string' ? data.instructions.trim() : '';
        if (instructions.length > 2000) fail(400, 'Инструкция слишком длинная');
        if (![4, 6, 8, 12, 24].includes(data.intervalHours)) fail(400, 'Некорректный интервал');
        if (!Number.isInteger(data.durationDays) || data.durationDays < 1 || data.durationDays > 365) fail(400, 'Некорректная длительность');
        const rows = await sql`INSERT INTO prescriptions(doctor_id, patient_id, medicine, dosage, instructions, interval_hours, duration_days)
            SELECT ${user.id}, id, ${medicine}, ${dosage}, ${instructions}, ${data.intervalHours}, ${data.durationDays}
            FROM users WHERE iin = ${data.patientIin} AND role = 'patient' RETURNING id`;
        if (!rows.length) fail(404, 'Пациент не найден');
        return json({ id: Number(rows[0].id), message: 'Назначение сохранено' });
    }
    const id = Number(data.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Некорректный номер назначения');
    if (data.action === 'revoke') {
        requireRole(user, 'doctor');
        const rows = await sql`WITH revoked AS (
            UPDATE prescriptions SET status = 'revoked', revoked_at = now()
            WHERE id = ${id} AND doctor_id = ${user.id} AND status = 'active' RETURNING id
        ), disabled AS (
            UPDATE prescription_schedules SET reminders_enabled = false, updated_at = now()
            WHERE prescription_id IN (SELECT id FROM revoked)
        ) SELECT id FROM revoked`;
        if (!rows.length) fail(404, 'Назначение недоступно');
        return json({ message: 'Назначение отменено' });
    }
    if (data.action === 'schedule') {
        requireRole(user, 'patient');
        const timestamp = typeof data.startAt === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(data.startAt);
        const canonical = timestamp ? timestamp[1] + '.' + (timestamp[2] ?? '').padEnd(3, '0').slice(0, 3) + 'Z' : '';
        const start = new Date(canonical);
        const zone = text(data.timezone, 'timezone', 80);
        if (!Number.isFinite(+start) || start.toISOString() !== canonical ||
            Math.abs(+start - Date.now()) > 366 * 86400000 || typeof data.enabled !== 'boolean') fail(400, 'Некорректное расписание');
        try { new Intl.DateTimeFormat('ru', { timeZone: zone }); } catch { fail(400, 'Некорректный часовой пояс'); }
        const rows = await sql`INSERT INTO prescription_schedules(prescription_id, start_at, timezone, reminders_enabled)
            SELECT id, ${start.toISOString()}, ${zone}, ${data.enabled} FROM prescriptions
            WHERE id = ${id} AND patient_id = ${user.id} AND status = 'active'
            ON CONFLICT(prescription_id) DO UPDATE SET start_at = EXCLUDED.start_at, timezone = EXCLUDED.timezone,
                reminders_enabled = EXCLUDED.reminders_enabled, updated_at = now()
            RETURNING prescription_id`;
        if (!rows.length) fail(404, 'Назначение недоступно');
        return json({ message: 'Расписание сохранено' });
    }
    fail(400, 'Неизвестное действие');
});
