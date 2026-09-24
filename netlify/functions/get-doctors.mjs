import { endpoint, json } from '../lib/security.mjs';
export default endpoint('GET', async ({ sql }) => {
    // Keep the legacy response key, but expose a random public identifier, never a government IIN.
    const doctors = await sql`SELECT id, name, public_id::text AS iin, spec, img, city, exp, bio, rating FROM users WHERE role = 'doctor' ORDER BY name`;
    return json({ doctors });
});
