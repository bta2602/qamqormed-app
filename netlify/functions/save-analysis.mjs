import { endpoint, authenticate, requirePatientAccess, text, validateAnalysis, json } from '../lib/security.mjs';
export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    await requirePatientAccess(sql, user, data.patientIIN);
    const type = text(data.type, 'type', 100);
    const date = text(data.date, 'date', 20);
    validateAnalysis(data);
    const rows = await sql`INSERT INTO analyses(patient_iin, doctor_email, type, date, results, overall_status)
        VALUES (${data.patientIIN}, ${user.role === 'doctor' ? user.email : null}, ${type}, ${date}, ${JSON.stringify(data.results)}, ${data.overallStatus}) RETURNING id`;
    return json({ message: 'Анализ сохранён', id: rows[0].id });
});
