import { endpoint, authenticate, requireRole, requirePatientAccess, text, validateAnalysis, json } from '../lib/security.mjs';
import { protectRecord, reserveId } from '../lib/data-crypto.mjs';
export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    requireRole(user, 'doctor');
    await requirePatientAccess(sql, user, data.patientIIN);
    const type = text(data.type, 'type', 100);
    const date = text(data.date, 'date', 20);
    validateAnalysis(data);
    const secured = protectRecord('analyses', { id: await reserveId(sql, 'analyses'), type, results: data.results });
    const rows = await sql`WITH created AS (INSERT INTO analyses(id, patient_iin, doctor_email, doctor_id, type, date, results, overall_status)
        VALUES (${secured.id}, ${data.patientIIN}, ${user.email}, ${user.id}, ${secured.type}, ${date}, ${JSON.stringify(secured.results)}, ${data.overallStatus}) RETURNING id),
        audited AS (INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
            SELECT ${user.id}, 'analysis_created', 'analysis', id FROM created) SELECT id FROM created`;
    return json({ message: 'Анализ сохранён', id: rows[0].id });
});
