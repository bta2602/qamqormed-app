import { endpoint, authenticate, requireRole, text, email, iin, validatePassword, passwordHash, fail, json } from '../lib/security.mjs';

export default endpoint('POST', async ({ sql, request, data }) => {
    const admin = await authenticate(sql, request);
    requireRole(admin, 'admin');
    if (data.action === 'get_all') {
        const users = await sql`SELECT name, email, iin, role, blood_type, spec, city, exp, bio, img, rating FROM users ORDER BY role, name`;
        const [count] = await sql`SELECT count(*) AS total FROM appointments`;
        return json({ users, totalAppointments: count.total });
    }
    if (data.action === 'delete') {
        const target = iin(data.targetIin);
        if (target === admin.iin) fail(400, 'Нельзя удалить собственный аккаунт');
        // Legacy clinical tables reference IIN/email without foreign keys. Keep their identity attached.
        const rows = await sql`DELETE FROM users u WHERE u.iin = ${target}
            AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_iin = u.iin OR a.doctor_iin = u.iin)
            AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.patient_iin = u.iin OR a.doctor_email = u.email)
            AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.sender = u.iin OR m.receiver = u.iin)
            RETURNING id`;
        if (!rows.length) fail(409, 'Аккаунт недоступен или связан с медицинскими данными');
        return json({ message: 'Аккаунт удалён' });
    }
    const name = text(data.name, 'name', 100);
    const address = email(data.email);
    const role = data.role;
    if (!['admin', 'doctor', 'patient'].includes(role)) fail(400, 'Некорректная роль');
    const optional = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    const spec = optional(data.spec, 100), city = optional(data.city, 100), exp = optional(data.exp, 50);
    const bio = optional(data.bio, 5000), blood = optional(data.bloodType, 40), img = optional(data.img, 2048);
    if (img && !img.startsWith('https://')) fail(400, 'Фото должно использовать HTTPS');
    const rating = Number(data.rating ?? 0);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) fail(400, 'Некорректный рейтинг');
    if (data.action === 'create') {
        const identifier = iin(data.iin);
        const hash = await passwordHash(validatePassword(data.password));
        await sql`INSERT INTO users(name, email, password, iin, role, blood_type, spec, city, exp, bio, img, rating)
            VALUES (${name}, ${address}, ${hash}, ${identifier}, ${role}, ${blood}, ${spec}, ${city}, ${exp}, ${bio}, ${img}, ${rating})`;
        return json({ message: 'Аккаунт создан' });
    }
    if (data.action === 'update') {
        const target = iin(data.targetIin);
        if (target === admin.iin && role !== 'admin') fail(400, 'Нельзя снять собственные права');
        await sql`WITH updated AS (
            UPDATE users SET name = ${name}, email = ${address}, role = ${role}, blood_type = ${blood},
            spec = ${spec}, city = ${city}, exp = ${exp}, bio = ${bio}, img = ${img}, rating = ${rating},
            session_version = session_version + CASE WHEN id = ${admin.id} THEN 0 ELSE 1 END
            WHERE iin = ${target} RETURNING id
        ) DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM updated) AND user_id <> ${admin.id}`;
        return json({ message: 'Данные сохранены' });
    }
    fail(400, 'Неизвестное действие');
});
