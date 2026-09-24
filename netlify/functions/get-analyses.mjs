import { endpoint, authenticate, requirePatientAccess, json } from '../lib/security.mjs';
export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    await requirePatientAccess(sql, user, data.iin);
    const analyses = await sql`SELECT * FROM analyses WHERE patient_iin = ${data.iin} ORDER BY created_at DESC`;
    return json({ analyses });
});
