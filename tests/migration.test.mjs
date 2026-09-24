import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8');
async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, email TEXT, password VARCHAR(100), iin VARCHAR(12), role TEXT);
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, doctor_id INTEGER NOT NULL, patient_iin VARCHAR(12), date TEXT, time TEXT, status TEXT);
        INSERT INTO users(email, password, iin, role) VALUES ('doctor@example.invalid', 'LegacyTest12', '000000000001', 'doctor');`);
    return db;
}

test('migration preserves and backfills legacy appointments and is rerunnable', async t => {
    const db = await fixture(t);
    await db.exec(`INSERT INTO appointments(doctor_id, patient_iin, date, time, status) VALUES (1, '000000000002', '2026-10-01', '10:00', 'upcoming')`);
    await db.exec(migration);
    const first = (await db.query('SELECT public_id, password FROM users')).rows[0];
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT public_id, password FROM users')).rows[0], first);
    assert.equal((await db.query('SELECT doctor_iin FROM appointments')).rows[0].doctor_iin, '000000000001');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM appointments')).rows[0].n, 1);
    assert.equal((await db.query('SELECT session_version FROM users')).rows[0].session_version, 1);
});

test('case-insensitive email duplicates abort the entire migration without deleting data', async t => {
    const db = await fixture(t);
    await db.exec(`INSERT INTO users(email, password, iin, role) VALUES ('DOCTOR@example.invalid', 'LegacyTest34', '000000000003', 'patient')`);
    await assert.rejects(db.exec(migration), error => error.code === '23505');
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
    assert.equal((await db.query("SELECT to_regclass('auth_sessions') AS table_name")).rows[0].table_name, null);
});

test('duplicate legacy upcoming slots abort migration and roll back appointment backfill', async t => {
    const db = await fixture(t);
    await db.exec(`INSERT INTO appointments(doctor_id, patient_iin, date, time, status) VALUES
        (1, '000000000002', '2026-10-01', '10:00', 'upcoming'), (1, '000000000003', '2026-10-01', '10:00', 'upcoming')`);
    await assert.rejects(db.exec(migration), error => error.code === '23505');
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM appointments')).rows[0].n, 2);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'appointments' AND column_name = 'doctor_iin'")).rows[0].n, 0);
});

test('ambiguous or orphaned legacy doctor mappings stop migration without guessing', async t => {
    const db = await fixture(t);
    await db.exec(`INSERT INTO appointments(doctor_id, patient_iin, date, time, status) VALUES (999, '000000000002', '2026-10-01', '10:00', 'upcoming')`);
    await assert.rejects(db.exec(migration), /Conflicting or orphaned/);
    await db.exec('ROLLBACK');
    await db.exec(`ALTER TABLE appointments ADD COLUMN doctor_iin VARCHAR(12);
        UPDATE appointments SET doctor_id = 1, doctor_iin = '000000000009'`);
    await assert.rejects(db.exec(migration), /Conflicting or orphaned/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT doctor_iin FROM appointments')).rows[0].doctor_iin, '000000000009');
});

test('documented SQL preflight runs read-only before and after migration', async t => {
    const db = await fixture(t);
    const guide = await readFile(new URL('../DEPLOYMENT-2026-09.md', import.meta.url), 'utf8');
    const preflight = /```sql\r?\n([\s\S]*?)```/.exec(guide)?.[1];
    assert.ok(preflight);
    const before = (await db.query('SELECT * FROM users')).rows;
    await db.exec(preflight);
    assert.deepEqual((await db.query('SELECT * FROM users')).rows, before);
    await db.exec(migration);
    const after = (await db.query('SELECT * FROM users')).rows;
    await db.exec(preflight);
    assert.deepEqual((await db.query('SELECT * FROM users')).rows, after);
});
