import { endpoint, text, email, iin, validatePassword, passwordHash, createSession, throttle } from '../lib/security.mjs';

export default endpoint('POST', async ({ data, sql, context }) => {
    await throttle(sql, 'register:' + (context.ip ?? 'unknown'), 10);
    const name = text(data.name, 'name', 100);
    const address = email(data.email);
    const identifier = iin(data.iin);
    const hash = await passwordHash(validatePassword(data.password));
    const users = await sql`INSERT INTO users(name, email, password, iin, role)
        VALUES (${name}, ${address}, ${hash}, ${identifier}, 'patient') RETURNING id, name, email, iin, role, blood_type, session_version`;
    return createSession(sql, users[0]);
});
