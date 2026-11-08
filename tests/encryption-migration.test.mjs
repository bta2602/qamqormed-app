import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { encryptBatch } from '../scripts/encrypt-clinical-data.mjs';
import { revealRecord } from '../netlify/lib/data-crypto.mjs';

async function fixture(t) {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec(`CREATE TABLE appointments(id SERIAL PRIMARY KEY, message TEXT, diagnosis TEXT, notes TEXT, treatment TEXT);
        INSERT INTO appointments(message, diagnosis, notes, treatment) VALUES ('Message fixture', 'Diagnosis fixture', '', NULL);
        CREATE FUNCTION keep_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable'; END $$;
        CREATE TRIGGER qamqor_completed_record BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION keep_record();`);
    const sql = { query: (text, params = []) => ({ text, params }), transaction: async statements => {
        await db.exec('BEGIN');
        try {
            for (const item of statements) await db.query(item.text, item.params);
            await db.exec('COMMIT');
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    } };
    const env = { QAMQOR_DATA_KEY_ID: 'test', QAMQOR_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }) };
    return { db, sql, env, rows: (await db.query('SELECT * FROM appointments')).rows };
}
test('dry run changes nothing; apply preserves contents and restores immutable-history trigger', async t => {
    const { db, sql, env, rows } = await fixture(t);
    assert.equal(await encryptBatch(sql, 'appointments', rows, { env }), 1);
    assert.deepEqual((await db.query('SELECT * FROM appointments')).rows, rows);
    assert.equal(await encryptBatch(sql, 'appointments', rows, { env, apply: true }), 1);
    const encrypted = (await db.query('SELECT * FROM appointments')).rows;
    assert.deepEqual(revealRecord('appointments', encrypted[0], env), rows[0]);
    assert.equal(JSON.stringify(encrypted).includes('Diagnosis fixture'), false);
    assert.equal(await encryptBatch(sql, 'appointments', encrypted, { env, apply: true }), 0);
    await assert.rejects(db.exec("UPDATE appointments SET diagnosis = 'Changed'"), /Immutable/);
});
test('a stale snapshot rolls back encryption and the temporary trigger change', async t => {
    const { db, sql, env, rows } = await fixture(t);
    rows[0].diagnosis = 'Stale fixture';
    await assert.rejects(encryptBatch(sql, 'appointments', rows, { env, apply: true }), /concurrent-change/);
    assert.equal((await db.query('SELECT diagnosis FROM appointments')).rows[0].diagnosis, 'Diagnosis fixture');
    await assert.rejects(db.exec("UPDATE appointments SET diagnosis = 'Changed'"), /Immutable/);
});
test('wrong keys never damage or replace already encrypted values', async t => {
    const { db, sql, env, rows } = await fixture(t);
    await encryptBatch(sql, 'appointments', rows, { env, apply: true });
    const encrypted = (await db.query('SELECT * FROM appointments')).rows;
    const wrong = { ...env, QAMQOR_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }) };
    await assert.rejects(encryptBatch(sql, 'appointments', encrypted, { env: wrong, apply: true }));
    assert.deepEqual((await db.query('SELECT * FROM appointments')).rows, encrypted);
});
