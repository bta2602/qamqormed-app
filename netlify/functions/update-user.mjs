import { endpoint, authenticate, confirmPassword, email, text, fail, json, passwordMatches, validatePassword, passwordHash, digest, sessionToken, throttle } from '../lib/security.mjs';
import { protectField } from '../lib/data-crypto.mjs';

export default endpoint('POST', async ({ data, sql, request }) => {
    const user = await authenticate(sql, request);
    if (data.iin && data.iin !== user.iin) fail(403, 'Недостаточно прав');
    if (data.action === 'update_profile') {
        const address = email(data.email);
        const bloodType = protectField(text(data.bloodType, 'bloodType', 40), 'users', user.id, 'blood_type');
        if (address !== user.email.toLowerCase()) await confirmPassword(sql, user, data.currentPassword);
        const changed = await sql`WITH updated AS (
            UPDATE users SET email = ${address}, blood_type = ${bloodType}
                WHERE id = ${user.id} AND session_version = ${user.session_version} AND is_active = true RETURNING id
        ), audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${user.id}, 'profile_updated', 'user', id FROM updated) SELECT id FROM updated`;
        if (!changed.length) fail(409, 'Профиль уже изменён, повторите вход');
        return json({ message: 'Данные сохранены' });
    }
    if (data.action === 'change_password') {
        await throttle(sql, 'password:' + user.id);
        const [stored] = await sql`SELECT password FROM users WHERE id = ${user.id}`;
        if (!stored || !await passwordMatches(data.oldPassword, stored.password)) fail(400, 'Неверный старый пароль');
        const hash = await passwordHash(validatePassword(data.newPassword));
        const changed = await sql`WITH updated AS (
            UPDATE users SET password = ${hash}, session_version = session_version + 1
            WHERE id = ${user.id} AND password = ${stored.password} AND session_version = ${user.session_version}
            RETURNING id, session_version
        ), revoked AS (
            DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM updated) AND token_hash <> ${digest(sessionToken(request))}
        ), retained AS (
            UPDATE auth_sessions s SET session_version = u.session_version FROM updated u
            WHERE s.user_id = u.id AND s.token_hash = ${digest(sessionToken(request))}
        ), audited AS (
            INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT ${user.id}, 'password_changed', 'user', id FROM updated
        ) SELECT id FROM updated`;
        if (!changed.length) fail(409, 'Пароль уже изменён, повторите вход');
        return json({ message: 'Пароль изменён' });
    }
    fail(400, 'Неизвестное действие');
});
