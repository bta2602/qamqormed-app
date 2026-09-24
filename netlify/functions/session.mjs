import { endpoint, authenticate, publicUser, json } from '../lib/security.mjs';
export default endpoint('GET', async ({ sql, request }) => json({ user: publicUser(await authenticate(sql, request)) }));
