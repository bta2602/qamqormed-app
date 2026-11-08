import { randomBytes } from 'node:crypto';
import { endpoint, email, iin, digest, throttle, json, fail, validatePassword, passwordHash } from '../lib/security.mjs';

const cookieName = '__Host-qamqor-recovery=';
function tokenFrom(request) {
    const token = request.headers.get('X-Recovery-Token') ?? request.headers.get('Cookie')?.split(';')
        .map(value => value.trim()).find(value => value.startsWith(cookieName))?.slice(cookieName.length) ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Создайте новый запрос на восстановление');
    return token;
}

export default endpoint('POST', async ({ sql, data, request, context }) => {
    if (data.action === 'request') {
        const address = email(data.email), identifier = iin(data.iin);
        await throttle(sql, 'recovery:ip:' + (context.ip ?? 'unknown'), 10);
        await throttle(sql, 'recovery:identity:' + address + ':' + identifier, 3);
        const token = randomBytes(32).toString('base64url');
        // Identical response for absent, inactive and privileged accounts; no account enumeration.
        await sql`INSERT INTO password_recovery_requests(token_hash, user_id, session_version)
            SELECT ${digest(token)}, id, session_version FROM users u
            WHERE lower(email) = ${address} AND iin = ${identifier} AND role = 'patient' AND is_active = true
            AND (SELECT count(*) FROM password_recovery_requests r WHERE r.user_id = u.id
                AND r.status IN ('pending', 'approved') AND r.expires_at > now()) < 3`;
        return json({ status: 'pending', recoveryToken: token }, 202, {
            'Set-Cookie': cookieName + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400',
        });
    }
    if (!['status', 'complete'].includes(data.action)) fail(400, 'Недоступное действие');
    const token = tokenFrom(request);
    await throttle(sql, 'recovery:poll-ip:' + (context.ip ?? 'unknown'), 120);
    await throttle(sql, 'recovery:token:' + digest(token), 60);
    if (data.action === 'status') {
        const [row] = await sql`SELECT r.status, r.expires_at, u.session_version = r.session_version AS current
            FROM password_recovery_requests r JOIN users u ON u.id = r.user_id
            WHERE r.token_hash = ${digest(token)} AND u.role = 'patient' AND u.is_active = true`;
        const status = !row ? 'pending' : !row.current || new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.status;
        return json({ status });
    }
    const hash = await passwordHash(validatePassword(data.newPassword));
    const rows = await sql`WITH authorized AS (
        SELECT r.id, r.user_id FROM password_recovery_requests r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ${digest(token)} AND r.status = 'approved' AND r.expires_at > now()
            AND r.session_version = u.session_version AND u.role = 'patient' AND u.is_active = true
        FOR UPDATE OF u, r
    ), updated AS (
        UPDATE users u SET password = ${hash} FROM authorized a WHERE u.id = a.user_id RETURNING u.id
    ), consumed AS (
        UPDATE password_recovery_requests SET status = 'consumed', consumed_at = now()
        WHERE id IN (SELECT id FROM authorized) AND user_id IN (SELECT id FROM updated) RETURNING user_id
    ), revoked_sessions AS (
        DELETE FROM auth_sessions WHERE user_id IN (SELECT user_id FROM consumed)
    ), revoked_requests AS (
        UPDATE password_recovery_requests SET status = 'rejected'
        WHERE user_id IN (SELECT user_id FROM consumed) AND id NOT IN (SELECT id FROM authorized)
            AND status IN ('pending', 'approved')
    ), audited AS (
        INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
        SELECT user_id, 'password_recovered', 'user', user_id FROM consumed
    ) SELECT user_id FROM consumed`;
    if (!rows.length) fail(409, 'Запрос не одобрен, уже использован или истёк');
    const headers = new Headers();
    headers.append('Set-Cookie', cookieName + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    headers.append('Set-Cookie', '__Host-qamqor=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    // Preserve both Set-Cookie headers; do not issue a normal session through the recovery route.
    const response = json({ status: 'consumed' });
    for (const value of headers.getSetCookie()) response.headers.append('Set-Cookie', value);
    return response;
});
