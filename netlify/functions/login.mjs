import { endpoint, email, passwordMatches, passwordHash, createSession, throttle, fail } from '../lib/security.mjs';

export default endpoint('POST', async ({ data, sql, context }) => {
    const address = email(data.email);
    if (typeof data.password !== 'string' || data.password.length > 128) fail(400, 'Некорректный пароль');
    await throttle(sql, 'login:ip:' + (context.ip ?? 'unknown'), 60);
    await throttle(sql, 'login:email:' + address);
    const users = await sql`SELECT * FROM users WHERE lower(email) = ${address}`;
    const user = users[0];
    if (!user) { await passwordHash(data.password); fail(401, 'Неверная почта или пароль'); }
    if (!await passwordMatches(data.password, user.password)) fail(401, 'Неверная почта или пароль');
    if (!user.password.startsWith('scrypt$')) {
        const upgraded = await passwordHash(data.password);
        const changed = await sql`UPDATE users SET password = ${upgraded} WHERE id = ${user.id} AND password = ${user.password} RETURNING id`;
        if (!changed.length) fail(401, 'Повторите вход');
    }
    return createSession(sql, user);
});
