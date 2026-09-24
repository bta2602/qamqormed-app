import { endpoint, sessionToken, digest, json } from '../lib/security.mjs';
export default endpoint('POST', async ({ sql, request }) => {
    await sql`DELETE FROM auth_sessions WHERE token_hash = ${digest(sessionToken(request))}`;
    return json({ message: 'Сессия завершена' }, 200, {
        'Set-Cookie': '__Host-qamqor=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    });
});
