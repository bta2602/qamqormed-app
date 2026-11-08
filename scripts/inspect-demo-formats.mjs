import { operatorDatabase } from './lib/operator-client.mjs';
import { email, iin, validateAnalysis } from '../netlify/lib/security.mjs';

// Aggregate-only inspection. Never print identifiers or clinical values.
try {
    const { sql, host } = await operatorDatabase('staging');
    const counts = { invalidEmail: 0, invalidIin: 0, invalidAnalysis: 0, analysisArrays: 0,
        analysisObjects: 0, analysisOther: 0, invalidDate: 0, invalidTime: 0 };
    const users = await sql`SELECT email, iin FROM users`;
    for (const user of users) {
        try { email(user.email); } catch { counts.invalidEmail++; }
        try { iin(user.iin); } catch { counts.invalidIin++; }
    }
    const analyses = await sql`SELECT type, date, results, overall_status FROM analyses`;
    const shapes = { dates: {}, statuses: {}, results: {} };
    function dateShape(value) {
        if (value instanceof Date) return 'Date';
        if (typeof value !== 'string') return typeof value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'iso_date';
        if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'iso_timestamp';
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return 'dotted_date';
        return 'other';
    }
    function increment(map, key) { map[key] = (map[key] ?? 0) + 1; }
    for (const row of analyses) {
        if (Array.isArray(row.results)) counts.analysisArrays++;
        else if (row.results && typeof row.results === 'object') counts.analysisObjects++;
        else counts.analysisOther++;
        try { validateAnalysis({ ...row, overallStatus: row.overall_status }); }
        catch { counts.invalidAnalysis++; }
        increment(shapes.dates, dateShape(row.date));
        increment(shapes.statuses, ['normal','warning','danger'].includes(row.overall_status) ? row.overall_status : 'other');
        for (const result of row.results ?? []) {
            const shape = ['name','value','min','max'].map(key => key + ':' + typeof result?.[key]).join(',');
            increment(shapes.results, shape);
        }
    }
    const appointments = await sql`SELECT date, time FROM appointments`;
    for (const row of appointments) {
        const date = new Date(String(row.date) + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(+date) ||
            date.toISOString().slice(0, 10) !== row.date) counts.invalidDate++;
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)) counts.invalidTime++;
        increment(shapes.dates, 'appointment_' + dateShape(row.date));
    }
    console.log(JSON.stringify({ check: 'demo_formats', host, status: 'inspected', counts, shapes }));
} catch {
    console.log(JSON.stringify({ check: 'demo_formats', status: 'failed', reason: 'Details redacted' }));
    process.exitCode = 1;
}
