import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { neon } from '@netlify/neon';

const scrypt = promisify(scryptCallback);
export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const digest = value => createHash('sha256').update(value).digest('hex');
export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...headers,
    } });
}
export function endpoint(method, operation, { database = true } = {}) {
    return async (request, context = {}) => {
        if (request.method !== method) return json({ error: 'Метод не поддерживается' }, 405, { Allow: method });
        try {
            const origin = request.headers.get('Origin');
            if (origin && origin !== new URL(request.url).origin) fail(403, 'Недопустимый источник запроса');
            let data = {};
            if (method !== 'GET') {
                if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'Требуется JSON');
                const raw = await request.text();
                if (Buffer.byteLength(raw) > 65536) fail(413, 'Запрос слишком большой');
                try { data = JSON.parse(raw); } catch { fail(400, 'Некорректный JSON'); }
                if (!data || Array.isArray(data) || typeof data !== 'object') fail(400, 'Некорректный запрос');
            }
            const sql = database ? (context.testSql ?? neon()) : undefined;
            return await operation({ request, context, sql, data });
        } catch (error) {
            if (error instanceof HttpError) return json({ error: error.message }, error.status);
            if (error.code === '23505') return json({ error: 'Запись уже существует или время уже занято' }, 409);
            if (error.code === '23503') return json({ error: 'Запись связана с другими данными' }, 409);
            // Do not disclose SQL, credentials, patient identifiers or database internals.
            console.error('API request failed', error.code ?? error.name);
            return json({ error: 'Сервис временно недоступен' }, 503);
        }
    };
}
export function text(value, field, max = 160) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Некорректное поле: ' + field);
    return value.trim();
}
export function iin(value) {
    if (typeof value !== 'string' || !/^\d{12}$/.test(value)) fail(400, 'Некорректный ИИН');
    return value;
}
export function email(value) {
    const result = text(value, 'email', 100).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Некорректная почта');
    return result;
}
export function validatePassword(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || (value.match(/\d/g) ?? []).length < 2 || !/[A-ZА-ЯӘҒҚҢӨҰҮҺІ]/.test(value))
        fail(400, 'Пароль: от 8 до 128 символов, две цифры и заглавная буква');
    return value;
}
export async function passwordHash(password) {
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return 'scrypt$' + salt + '$' + key.toString('hex');
}
export async function passwordMatches(password, stored) {
    if (typeof password !== 'string' || password.length > 128 || typeof stored !== 'string') return false;
    if (stored.startsWith('scrypt$')) {
        const [, salt, hex, extra] = stored.split('$');
        if (extra !== undefined || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
        const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        return timingSafeEqual(key, Buffer.from(hex, 'hex'));
    }
    // One-time upgrade path for existing plaintext accounts. Never write new plaintext passwords.
    return timingSafeEqual(Buffer.from(digest(password)), Buffer.from(digest(stored)));
}
export function publicUser(user) {
    const { id, name, email, iin, role, spec, img, city, exp, bio, rating, blood_type } = user;
    return { id, name, email, iin, role, spec, img, city, exp, bio, rating, blood_type };
}
export function sessionToken(request) {
    const authorization = request.headers.get('Authorization');
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-qamqor='))?.slice(14) ?? '';
}
export async function authenticate(sql, request) {
    const token = sessionToken(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Войдите в аккаунт заново');
    const rows = await sql`SELECT u.id, u.name, u.email, u.iin, u.role, u.spec, u.img, u.city, u.exp, u.bio, u.rating, u.blood_type, u.session_version
        FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${digest(token)} AND s.expires_at > now()
        AND s.session_version = u.session_version`;
    if (!rows.length) fail(401, 'Сессия истекла');
    return rows[0];
}
export async function createSession(sql, user) {
    const token = randomBytes(32).toString('base64url');
    // Bind issuance to the credentials verified by login, even if they change while login is in flight.
    const rows = await sql`INSERT INTO auth_sessions(token_hash, user_id, session_version, expires_at)
        SELECT ${digest(token)}, id, session_version, now() + interval '30 days' FROM users
        WHERE id = ${user.id} AND session_version = ${user.session_version} RETURNING user_id`;
    if (!rows.length) fail(401, 'Повторите вход');
    return json({ user: publicUser(user), token }, 200, {
        'Set-Cookie': '__Host-qamqor=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000',
    });
}
export async function throttle(sql, bucket, limit = 10) {
    const rows = await sql`INSERT INTO auth_throttle(bucket) VALUES (${digest(bucket)}) ON CONFLICT (bucket) DO UPDATE
        SET hits = CASE WHEN auth_throttle.window_start < now() - interval '15 minutes' THEN 1 ELSE auth_throttle.hits + 1 END,
        window_start = CASE WHEN auth_throttle.window_start < now() - interval '15 minutes' THEN now() ELSE auth_throttle.window_start END
        RETURNING hits`;
    if (rows[0].hits > limit) fail(429, 'Слишком много попыток. Повторите через 15 минут');
}
export function requireRole(user, ...roles) {
    if (!roles.includes(user.role)) fail(403, 'Недостаточно прав');
}
export async function requirePatientAccess(sql, user, patientIin) {
    iin(patientIin);
    if (user.iin === patientIin && user.role === 'patient') return;
    requireRole(user, 'doctor');
    const rows = await sql`SELECT id FROM appointments WHERE doctor_iin = ${user.iin} AND patient_iin = ${patientIin}
        AND status IN ('upcoming', 'completed') LIMIT 1`;
    if (!rows.length) fail(403, 'Пациент не записан к этому врачу');
}

export function validateAnalysis(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Некорректный анализ');
    text(value.type, 'type', 100);
    text(value.date, 'date', 20);
    if (!Array.isArray(value.results) || value.results.length > 50 ||
        !value.results.every(r => r && typeof r === 'object' && typeof r.name === 'string' && r.name.trim() && r.name.length <= 100 &&
            ['value', 'min', 'max'].every(k => Number.isFinite(r[k])) && r.min <= r.max))
        fail(400, 'Некорректные результаты');
    if (!['normal', 'warning', 'danger'].includes(value.overallStatus)) fail(400, 'Некорректный статус');
}
