import { endpoint, authenticate, requireRole, json, fail } from '../lib/security.mjs';
export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    requireRole(user, 'doctor');
    if (data.doctor_iin && data.doctor_iin !== user.iin) fail(403, 'Недостаточно прав');
    const appointments = await sql`SELECT a.*, u.name AS patient_name FROM appointments a
        JOIN users u ON a.patient_iin = u.iin WHERE a.doctor_iin = ${user.iin} ORDER BY a.date, a.time`;
    return json({ appointments });
});
