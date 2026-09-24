import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { checkSchema, requiredVersion, runSchemaCheck } from '../scripts/check-schema.mjs';

const migration = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8');

async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, email TEXT, password VARCHAR(100), iin VARCHAR(12), role TEXT);
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, doctor_id INTEGER NOT NULL, patient_iin VARCHAR(12), date TEXT, time TEXT, status TEXT);`);
    const sql = (strings, ...params) => ({ text: strings.reduce((a, s, i) => a + (i ? '$' + i : '') + s, ''), params });
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
    const before = (await db.query('SELECT * FROM qamqormed_schema_migrations')).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].version, requiredVersion);
    await db.exec(migration);
    await checkSchema(sql);
    assert.deepEqual((await db.query('SELECT * FROM qamqormed_schema_migrations')).rows, before);
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
    assert.equal(await runSchemaCheck({ env: { NETLIFY_DATABASE_URL: secret },
        connect: () => { throw new Error(secret); }, error: text => output.push(text) }), 1);
    assert.doesNotMatch(output.join(), new RegExp(secret));
    assert.match(output.join(), /Deployment blocked/);
});

test('the command permits deployment only after a successful schema check', async t => {
    const { db, sql } = await fixture(t);
    await db.exec(migration);
    const output = [];
    assert.equal(await runSchemaCheck({ env: { NETLIFY_DATABASE_URL: 'synthetic' },
        connect: () => sql, log: text => output.push(text), error: text => assert.fail(text) }), 0);
    assert.match(output.join(), /Database schema ready/);
});
