import { pathToFileURL } from 'node:url';
import { dataKeyring, protectField, revealField } from '../netlify/lib/data-crypto.mjs';

const tables = Object.freeze({
    appointments: ['message', 'diagnosis', 'notes', 'treatment'],
    analyses: ['type', 'results'],
    prescriptions: ['medicine', 'dosage', 'instructions'],
    chat_messages: ['text'],
    users: ['blood_type'],
});

export async function encryptBatch(sql, table, rows, { env = process.env, apply = false } = {}) {
    const fields = tables[table];
    if (!fields || rows.length > 200) throw new Error('Invalid migration batch');
    const keyring = dataKeyring(env);
    const changes = [];
    for (const row of rows) {
        if (!/^[1-9][0-9]*$/.test(String(row.id))) throw new Error('Invalid row identity');
        const values = [];
        let changed = false;
        for (const field of fields) {
            const value = row[field];
            const decoded = revealField(value, table, row.id, field, { ...env, QAMQOR_ALLOW_LEGACY_PLAINTEXT: 'true' });
            const envelope = field === 'results' ? value?._encrypted : value;
            const current = value == null || (typeof envelope === 'string' && envelope.startsWith('qmenc1.' + keyring.active + '.'));
            const next = current ? value : protectField(decoded, table, row.id, field, env);
            // Verify before creating any update. Key loss or corrupt ciphertext fails closed.
            if (JSON.stringify(revealField(next, table, row.id, field, env)) !== JSON.stringify(decoded)) throw new Error('Encryption verification failed');
            changed ||= !current;
            values.push(next);
        }
        if (changed) changes.push({ row, values });
    }
    if (!apply || changes.length === 0) return changes.length;
    const statements = [sql.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)];
    if (table === 'appointments') {
        // Only the maintenance transaction may transform immutable history; the trigger is restored before commit.
        statements.push(sql.query("SELECT CAST(CASE WHEN count(*) = 1 THEN '1' ELSE 'missing-trigger' END AS integer) FROM pg_trigger WHERE tgrelid = 'appointments'::regclass AND tgname = 'qamqor_completed_record' AND tgenabled = 'O'"));
        statements.push(sql.query('ALTER TABLE appointments DISABLE TRIGGER qamqor_completed_record'));
    }
    for (const { row, values } of changes) {
        const params = [row.id, ...values.map((v, i) => fields[i] === 'results' && v != null ? JSON.stringify(v) : v),
            ...fields.map(field => field === 'results' && row[field] != null ? JSON.stringify(row[field]) : row[field])];
        const set = fields.map((field, i) => `${field} = $${i + 2}${field === 'results' ? '::jsonb' : ''}`).join(', ');
        const unchanged = fields.map((field, i) => `${field} IS NOT DISTINCT FROM $${i + fields.length + 2}${field === 'results' ? '::jsonb' : ''}`).join(' AND ');
        statements.push(sql.query(`WITH changed AS (UPDATE ${table} SET ${set} WHERE id = $1 AND ${unchanged} RETURNING id)
            SELECT CAST(CASE WHEN count(*) = 1 THEN '1' ELSE 'concurrent-change' END AS integer) AS updated FROM changed`, params));
    }
    if (table === 'appointments') statements.push(sql.query('ALTER TABLE appointments ENABLE TRIGGER qamqor_completed_record'));
    await sql.transaction(statements, { isolationLevel: 'Serializable', fetchOptions: { signal: AbortSignal.timeout(60000) } });
    return changes.length;
}

export async function runEncryption(sql, { env = process.env, apply = false, output = console.log } = {}) {
    dataKeyring(env);
    const [receipt] = await sql`SELECT version FROM qamqormed_schema_migrations WHERE version = '20261109_encrypted_field_capacity'`;
    if (!receipt) throw new Error('Apply schema migration on the test database first');
    for (const [table, fields] of Object.entries(tables)) {
        let cursor = '0', inspected = 0, changed = 0;
        while (true) {
            const rows = await sql.query(`SELECT id, ${fields.join(', ')} FROM ${table} WHERE id > $1 ORDER BY id LIMIT 200`, [cursor]);
            if (!rows.length) break;
            changed += await encryptBatch(sql, table, rows, { env, apply });
            inspected += rows.length;
            cursor = String(rows.at(-1).id);
        }
        output(`${table}: inspected=${inspected}, ${apply ? 'encrypted' : 'would_encrypt'}=${changed}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const url = new URL(process.env.NETLIFY_DATABASE_URL ?? '');
        const hostIndex = process.argv.indexOf('--confirm-host');
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || hostIndex < 0 || process.argv[hostIndex + 1] !== url.hostname) throw new Error('Confirm target');
        const apply = process.argv.includes('--apply');
        if (apply && (!process.argv.includes('--maintenance-confirmed') || !process.argv.includes('--backup-confirmed'))) throw new Error('Confirm maintenance and backup');
        const { neon } = await import('@netlify/neon');
        await runEncryption(neon(process.env.NETLIFY_DATABASE_URL), { apply });
        console.log(apply ? 'Encryption batches completed. Verify restore and strict reads before reopening access.' : 'Dry run only. No rows changed.');
    } catch {
        console.error('Encryption stopped. Check target, key configuration, schema and maintenance prerequisites. Values are not logged. Earlier committed batches remain encrypted; keep their keys and rerun safely.');
        process.exitCode = 1;
    }
}
