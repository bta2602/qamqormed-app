import { endpoint, authenticate, requireRole, confirmPassword, pagination, text, email, iin,
    validatePassword, passwordHash, fail, json } from '../lib/security.mjs';
import { revealRecord } from '../lib/data-crypto.mjs';

const optional = (value, field, max) => value == null || value === '' ? '' : text(value, field, max);
const targetId = value => {
    if (!Number.isSafeInteger(value) || value <= 0) fail(400, 'Некорректный аккаунт');
    return value;
};

export default endpoint('POST', async ({ sql, request, data }) => {
    const admin = await authenticate(sql, request);
    requireRole(admin, 'admin');
    if (data.action === 'get_all') {
        const { page, pageSize, offset } = pagination(data);
        const query = optional(data.query, 'query', 100);
        const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
        const users = await sql`SELECT id, name, email, role, is_active, spec, city, exp, bio, img FROM users
            WHERE name ILIKE ${pattern} OR email ILIKE ${pattern} ORDER BY id LIMIT ${pageSize} OFFSET ${offset}`;
        const [count] = await sql`SELECT count(*)::int AS total FROM users WHERE name ILIKE ${pattern} OR email ILIKE ${pattern}`;
        const [appointments] = await sql`SELECT count(*)::int AS total FROM appointments`;
        return json({ users, total: count.total, totalAppointments: appointments.total, page, pageSize });
    }
    if (data.action === 'audit') {
        const { page, pageSize, offset } = pagination(data);
        const events = await sql`SELECT id, actor_id, action, resource_type, resource_id, created_at
            FROM security_audit ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}`;
        const [count] = await sql`SELECT count(*)::int AS total FROM security_audit`;
        return json({ events, total: count.total, page, pageSize });
    }
    if (data.action === 'recovery_requests') {
        const { page, pageSize, offset } = pagination(data);
        const requests = await sql`SELECT r.id, r.created_at, r.expires_at, u.id AS user_id, u.name, u.email
            FROM password_recovery_requests r JOIN users u ON u.id = r.user_id
            WHERE r.status = 'pending' AND r.expires_at > now() AND r.session_version = u.session_version
                AND u.role = 'patient' AND u.is_active = true ORDER BY r.created_at, r.id LIMIT ${pageSize} OFFSET ${offset}`;
        const [count] = await sql`SELECT count(*)::int AS total FROM password_recovery_requests r JOIN users u ON u.id = r.user_id
            WHERE r.status = 'pending' AND r.expires_at > now() AND r.session_version = u.session_version
                AND u.role = 'patient' AND u.is_active = true`;
        return json({ requests, total: count.total, page, pageSize });
    }
    if (!['create', 'update', 'set_active', 'medical_record', 'review_recovery'].includes(data.action)) fail(400, 'Недоступное действие');
    await confirmPassword(sql, admin, data.currentPassword);
    if (data.action === 'review_recovery') {
        if (!/^[a-f0-9-]{36}$/i.test(data.requestId ?? '') || typeof data.approve !== 'boolean' ||
            data.acknowledgeRisk !== true) fail(400, 'Подтвердите проверку запроса и риск восстановления');
        const rows = await sql`WITH reviewed AS (
            UPDATE password_recovery_requests r SET status = ${data.approve ? 'approved' : 'rejected'},
                reviewed_by = ${admin.id}, reviewed_at = now(),
                expires_at = LEAST(expires_at, now() + interval '15 minutes')
            FROM users u WHERE r.id::text = ${data.requestId} AND r.user_id = u.id
                AND r.status = 'pending' AND r.expires_at > now() AND r.session_version = u.session_version
                AND u.role = 'patient' AND u.is_active = true RETURNING r.user_id
        ), audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${admin.id}, ${data.approve ? 'recovery_approved' : 'recovery_rejected'}, 'user', user_id FROM reviewed)
        SELECT user_id FROM reviewed`;
        if (!rows.length) fail(409, 'Запрос недоступен или уже обработан');
        return json({ message: 'Решение сохранено' });
    }

    if (data.action === 'medical_record') {
        const id = targetId(data.targetId);
        if (!['care_review', 'patient_request', 'security_review'].includes(data.reason)) fail(400, 'Укажите причину доступа');
        const [patient] = await sql`SELECT id, name, iin FROM users WHERE id = ${id} AND role = 'patient'`;
        if (!patient) fail(404, 'Пациент не найден');
        // Fail closed: record the sensitive read before returning any medical information.
        await sql`INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            VALUES (${admin.id}, ${'medical_read:' + data.reason}, 'patient', ${id})`;
        const appointments = await sql`SELECT a.id, a.patient_iin, a.doctor_iin, a.date, a.time, a.type, a.message,
            a.status, a.diagnosis, a.notes, a.treatment, d.name AS doctor_name FROM appointments a
            LEFT JOIN users d ON d.iin = a.doctor_iin WHERE a.patient_iin = ${patient.iin} ORDER BY a.date DESC, a.id DESC`;
        const analyses = await sql`SELECT id, patient_iin, doctor_email, type, date, results, overall_status, created_at
            FROM analyses WHERE patient_iin = ${patient.iin} ORDER BY created_at DESC, id DESC`;
        const prescriptions = await sql`SELECT p.*, d.name AS doctor_name, u.name AS patient_name, u.iin AS patient_iin,
            s.start_at, s.timezone, CASE WHEN p.status = 'active' THEN s.reminders_enabled ELSE false END AS reminders_enabled
            FROM prescriptions p JOIN users d ON d.id = p.doctor_id JOIN users u ON u.id = p.patient_id
            LEFT JOIN prescription_schedules s ON s.prescription_id = p.id WHERE p.patient_id = ${id}
            ORDER BY p.created_at DESC, p.id DESC`;
        return json({ patient, appointments: appointments.map(row => revealRecord('appointments', row)),
            analyses: analyses.map(row => revealRecord('analyses', row)), prescriptions: prescriptions.map(row => revealRecord('prescriptions', row)) });
    }
    if (data.action === 'set_active') {
        const id = targetId(data.targetId);
        if (id === admin.id || typeof data.active !== 'boolean') fail(400, 'Недопустимое изменение аккаунта');
        const rows = await sql`WITH updated AS (
            UPDATE users SET is_active = ${data.active} WHERE id = ${id} AND role <> 'admin'
                AND is_active IS DISTINCT FROM ${data.active} RETURNING id
        ), revoked AS (DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM updated)),
        audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${admin.id}, ${data.active ? 'account_enabled' : 'account_disabled'}, 'user', id FROM updated)
        SELECT id FROM updated`;
        if (!rows.length) fail(409, 'Аккаунт недоступен или уже изменён');
        return json({ message: data.active ? 'Аккаунт включён' : 'Аккаунт заблокирован' });
    }
    const name = text(data.name, 'name', 100), address = email(data.email), role = data.role;
    // Administrator creation is an explicit operator action, never self-registration.
    if (!['doctor', 'patient'].includes(role)) fail(400, 'Используйте отдельный аккаунт пациента или врача');
    const spec = optional(data.spec, 'spec', 100), city = optional(data.city, 'city', 100);
    const exp = optional(data.exp, 'exp', 50), bio = optional(data.bio, 'bio', 5000), img = optional(data.img, 'img', 2048);
    if (role === 'doctor' && (!spec || !city)) fail(400, 'Укажите специальность и город врача');
    if (img) {
        let url;
        try { url = new URL(img); } catch { fail(400, 'Некорректный адрес фото'); }
        if (url.protocol !== 'https:' || url.username || url.password) fail(400, 'Фото должно использовать HTTPS');
    }
    if (data.action === 'create') {
        const identifier = iin(data.iin), hash = await passwordHash(validatePassword(data.password));
        const rows = await sql`WITH created AS (
            INSERT INTO users(name, email, password, iin, role, spec, city, exp, bio, img)
            VALUES (${name}, ${address}, ${hash}, ${identifier}, ${role}, ${spec}, ${city}, ${exp}, ${bio}, ${img}) RETURNING id
        ), audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${admin.id}, 'account_created', 'user', id FROM created) SELECT id FROM created`;
        return json({ id: rows[0].id, message: 'Аккаунт создан' });
    }
    const id = targetId(data.targetId);
    if (id === admin.id) fail(400, 'Измените свой профиль в личном кабинете');
    const rows = await sql`WITH updated AS (
        UPDATE users SET name = ${name}, email = ${address}, spec = ${spec}, city = ${city}, exp = ${exp},
            bio = ${bio}, img = ${img}, session_version = session_version + 1 WHERE id = ${id} AND role = ${role} RETURNING id
    ), revoked AS (DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM updated)),
    audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
        SELECT ${admin.id}, 'account_updated', 'user', id FROM updated) SELECT id FROM updated`;
    if (!rows.length) fail(409, 'Аккаунт недоступен; смена роли существующего аккаунта запрещена');
    return json({ message: 'Данные сохранены' });
});
