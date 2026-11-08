import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { checkSchema, requiredVersion, runSchemaCheck } from '../scripts/check-schema.mjs';
import { protectField, revealField } from '../netlify/lib/data-crypto.mjs';

const migration = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../migrations/20260924_roles_audit.sql', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../migrations/20260925_data_protection.sql', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../migrations/20261109_encrypted_field_capacity.sql', import.meta.url), 'utf8');
const keyEnv = { QAMQOR_DATA_KEY_ID: 'test', QAMQOR_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }) };

async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, email TEXT, password VARCHAR(100), iin VARCHAR(12), role TEXT);
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, doctor_id INTEGER NOT NULL, patient_iin VARCHAR(12), date TEXT, time TEXT, type TEXT, status TEXT, message TEXT);
        CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), type TEXT, results JSONB, created_at TIMESTAMPTZ);`);
    const sql = (strings, ...params) => {
        const text = strings.reduce((a, s, i) => a + (i ? '$' + i : '') + s, '');
        return { text, params, then: (resolve, reject) => db.query(text, params).then(r => r.rows).then(resolve, reject) };
    };
    sql.transaction = async (queries, options) => {
        assert.equal(options.readOnly, true);
        assert.equal(options.isolationLevel, 'RepeatableRead');
        assert.ok(options.fetchOptions.signal instanceof AbortSignal);
        await db.exec('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
            const rows = [];
            for (const query of queries) {
                assert.match(query.text.trim(), /^SELECT\b/i);
                rows.push((await db.query(query.text, query.params)).rows);
            }
            await db.exec('COMMIT');
            return rows;
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
    };
    return { db, sql };
}

test('deployment gate rejects an unmigrated database without altering it', async t => {
    const { db, sql } = await fixture(t);
    await assert.rejects(checkSchema(sql));
    assert.equal((await db.query("SELECT to_regclass('auth_sessions') AS name")).rows[0].name, null);
});

test('successful migration writes one receipt, is rerunnable, and passes the read-only gate', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    const before = (await db.query('SELECT * FROM qamqormed_schema_migrations WHERE version = $1', [requiredVersion])).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].version, requiredVersion);
    await db.exec(migration);
    await checkSchema(sql);
    assert.deepEqual((await db.query('SELECT * FROM qamqormed_schema_migrations WHERE version = $1', [requiredVersion])).rows, before);
});

test('a missing receipt or critical index prevents deployment even when tables exist', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    await db.exec('DELETE FROM qamqormed_schema_migrations');
    await assert.rejects(checkSchema(sql), /missing/);
    await db.query('INSERT INTO qamqormed_schema_migrations(version) VALUES ($1)', [requiredVersion]);
    await db.exec('DROP INDEX appointments_unique_upcoming_slot');
    await assert.rejects(checkSchema(sql), /missing/);
});

test('schema drift is rejected even if the migration receipt remains', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    await db.exec('ALTER TABLE prescriptions DROP COLUMN dosage');
    await assert.rejects(checkSchema(sql));
});

test('legacy diagnosis capacity is widened without changing the value and stores authenticated ciphertext', async t => {
    const { db, sql } = await fixture(t);
    await db.exec('ALTER TABLE appointments ADD COLUMN diagnosis VARCHAR(255)');
    await db.exec("INSERT INTO users(email, iin, role) VALUES ('doctor@example.invalid', '000000000001', 'doctor')");
    const diagnosis = 'Synthetic diagnosis '.repeat(12);
    await db.query("INSERT INTO appointments(doctor_id, diagnosis, status) VALUES (1, $1, 'completed')", [diagnosis]);
    await db.exec(migration);
    assert.equal((await db.query('SELECT diagnosis FROM appointments')).rows[0].diagnosis, diagnosis);
    await checkSchema(sql);
    const encrypted = protectField(diagnosis, 'appointments', 2, 'diagnosis', keyEnv);
    assert.ok(encrypted.length > 255);
    await db.query('INSERT INTO appointments(id, diagnosis) VALUES (2, $1)', [encrypted]);
    const stored = (await db.query('SELECT diagnosis FROM appointments WHERE id = 2')).rows[0].diagnosis;
    assert.equal(revealField(stored, 'appointments', 2, 'diagnosis', keyEnv), diagnosis);
    await assert.rejects(db.query("UPDATE appointments SET diagnosis = 'changed' WHERE id = 1"), /versioned amendment/);
});

test('bounded encrypted columns prevent deployment even with all migration receipts', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    await db.exec('ALTER TABLE appointments ALTER COLUMN diagnosis TYPE VARCHAR(255)');
    await assert.rejects(checkSchema(sql));
});

test('disabled security triggers prevent deployment despite a success receipt', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    await db.exec('ALTER TABLE users DISABLE TRIGGER qamqor_identity_change');
    await assert.rejects(checkSchema(sql));
});

test('unknown legacy roles abort the new migration instead of granting guessed permissions', async t => {
    const { db } = await fixture(t);
    const old = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8');
    const next = await readFile(new URL('../migrations/20260924_roles_audit.sql', import.meta.url), 'utf8');
    await db.exec(old);
    await db.exec("INSERT INTO users(email, role) VALUES ('fixture@example.invalid', 'manager')");
    await assert.rejects(db.exec(next), /users_role_allowlist/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT version FROM qamqormed_schema_migrations WHERE version = $1', [requiredVersion])).rows.length, 0);
});

test('patient booking conflicts abort migration without cancelling or deleting appointments', async t => {
    const { db } = await fixture(t);
    const old = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8');
    const next = await readFile(new URL('../migrations/20260924_roles_audit.sql', import.meta.url), 'utf8');
    await db.exec(old);
    await db.exec("INSERT INTO appointments(patient_iin, doctor_iin, date, time, status) VALUES ('900000000001', '900000000002', '2026-10-01', '10:00', 'upcoming'), ('900000000001', '900000000003', '2026-10-01', '10:00', 'upcoming')");
    await assert.rejects(db.exec(next), /appointments_unique_patient_slot/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM appointments WHERE status = 'upcoming'")).rows[0].n, 2);
    assert.equal((await db.query('SELECT version FROM qamqormed_schema_migrations WHERE version = $1', [requiredVersion])).rows.length, 0);
});

test('failed migration cannot leave a success receipt', async t => {
    const { db } = await fixture(t);
    await db.exec("INSERT INTO users(email) VALUES ('same@example.invalid'), ('SAME@example.invalid')");
    await assert.rejects(db.exec(migration));
    await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT to_regclass('qamqormed_schema_migrations') AS name")).rows[0].name, null);
});

test('missing credentials block the build without connecting', async () => {
    const output = [];
    assert.equal(await runSchemaCheck({ env: {}, connect: () => assert.fail('must not connect'), error: text => output.push(text) }), 1);
    assert.match(output.join(), /NETLIFY_DATABASE_URL/);
});

test('connection errors are redacted and fail closed', async () => {
    const output = [];
    const secret = 'synthetic-secret-not-real';
    assert.equal(await runSchemaCheck({ env: { ...keyEnv, NETLIFY_DATABASE_URL: secret },
        connect: () => { throw new Error(secret); }, error: text => output.push(text) }), 1);
    assert.doesNotMatch(output.join(), new RegExp(secret));
    assert.match(output.join(), /Deployment blocked/);
});

test('the command permits deployment only after a successful schema check', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    const output = [];
    assert.equal(await runSchemaCheck({ env: { ...keyEnv, NETLIFY_DATABASE_URL: 'synthetic' },
        connect: () => sql, log: text => output.push(text), error: text => assert.fail(text) }), 0);
    assert.match(output.join(), /Database schema ready/);
});

test('missing encryption keys and legacy read mode stop publication before connecting', async () => {
    for (const env of [{ NETLIFY_DATABASE_URL: 'synthetic' },
        { ...keyEnv, NETLIFY_DATABASE_URL: 'synthetic', QAMQOR_ALLOW_LEGACY_PLAINTEXT: 'true' }]) {
        assert.equal(await runSchemaCheck({ env, connect: () => assert.fail('must not connect'), error: () => {} }), 1);
    }
});

test('schema receipts cannot bypass the plaintext backfill gate', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    await db.exec("INSERT INTO users(email, role, blood_type) VALUES ('fixture@example.invalid', 'patient', 'synthetic clinical value')");
    const output = [];
    assert.equal(await runSchemaCheck({ env: { ...keyEnv, NETLIFY_DATABASE_URL: 'synthetic' },
        connect: () => sql, error: text => output.push(text) }), 1);
    assert.match(output.join(), /Deployment blocked/);
    assert.doesNotMatch(output.join(), /synthetic clinical value/);
    assert.equal((await db.query('SELECT blood_type FROM users')).rows[0].blood_type, 'synthetic clinical value');
});

test('active plaintext, missing and malformed passwords block publication without leaking values', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    for (const password of ['synthetic-legacy-password', null, 'scrypt$invalid$hash']) {
        await db.exec('DELETE FROM users');
        await db.query("INSERT INTO users(email, role, password) VALUES ('fixture@example.invalid', 'doctor', $1)", [password]);
        const output = [];
        assert.equal(await runSchemaCheck({ env: { ...keyEnv, NETLIFY_DATABASE_URL: 'synthetic' },
            connect: () => sql, error: text => output.push(text) }), 1);
        assert.match(output.join(), /active password hashes/);
        if (password) assert.equal(output.join().includes(password), false);
    }
    await db.query('UPDATE users SET password = $1', ['scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)]);
    assert.equal(await runSchemaCheck({ env: { ...keyEnv, NETLIFY_DATABASE_URL: 'synthetic' },
        connect: () => sql, log: () => {}, error: text => assert.fail(text) }), 0);
});
