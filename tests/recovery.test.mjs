import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import './test-crypto-env.mjs';
import recovery from '../netlify/functions/password-recovery.mjs';
import admin from '../netlify/functions/admin.mjs';
import login from '../netlify/functions/login.mjs';
import session from '../netlify/functions/session.mjs';
import { passwordHash, createSession, digest } from '../netlify/lib/security.mjs';

let db, sql, accounts;
const password = 'FixtureSecret12';
async function call(handler, data, { actor, token, cookie, method = 'POST' } = {}) {
    const response = await handler(new Request('https://fixture.invalid/.netlify/functions/test', {
        method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: 'Bearer ' + actor } : {}),
            ...(token ? { 'X-Recovery-Token': token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    }), { testSql: sql, ip: '192.0.2.55' });
    return { status: response.status, body: await response.json(), headers: response.headers };
}
before(async () => {
    db = new PGlite();
    sql = (parts, ...params) => db.query(parts.reduce((text, part, i) => text + (i ? '$' + i : '') + part, ''), params).then(r => r.rows);
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, iin VARCHAR(12) UNIQUE, role TEXT);
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_iin VARCHAR(12), date TEXT, time TEXT, type TEXT, message TEXT, status TEXT);
        CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_email TEXT, type TEXT, date TEXT, results JSONB, overall_status TEXT, created_at TIMESTAMPTZ);`);
    for (const file of ['20260924_sessions_prescriptions', '20260924_roles_audit', '20260925_data_protection', '20261109_encrypted_field_capacity']) await db.exec(await readFile(new URL('../migrations/' + file + '.sql', import.meta.url), 'utf8'));
    accounts = {};
    for (const [i, role] of ['patient', 'doctor', 'admin'].entries()) {
        const [user] = await sql`INSERT INTO users(name, email, password, iin, role) VALUES (${role}, ${role + '@example.invalid'}, ${await passwordHash(password)}, ${'80000000000' + i}, ${role}) RETURNING *`;
        accounts[role] = { ...user, token: (await (await createSession(sql, user)).json()).token };
    }
});
beforeEach(async () => { await db.exec('DELETE FROM auth_throttle; DELETE FROM password_recovery_requests'); });
after(async () => { await db.close(); });
const request = () => call(recovery, { action: 'request', email: accounts.patient.email, iin: accounts.patient.iin });
async function approve(token, approve = true) {
    const [row] = await sql`SELECT id FROM password_recovery_requests WHERE token_hash = ${digest(token)}`;
    return call(admin, { action: 'review_recovery', requestId: row.id, approve, acknowledgeRisk: true, currentPassword: password }, { actor: accounts.admin.token });
}
test('request response cannot enumerate accounts or reset privileged roles', async () => {
    for (const role of ['patient', 'doctor', 'admin', 'missing']) {
        const result = await call(recovery, { action: 'request', email: role + '@example.invalid', iin: accounts[role]?.iin ?? '800000000009' });
        assert.equal(result.status, 202); assert.equal(result.body.status, 'pending');
        assert.match(result.body.recoveryToken, /^[A-Za-z0-9_-]{43}$/);
        assert.match(result.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
        const rows = await sql`SELECT * FROM password_recovery_requests WHERE token_hash = ${digest(result.body.recoveryToken)}`;
        assert.equal(rows.length, role === 'patient' ? 1 : 0);
        assert.equal(JSON.stringify(rows).includes(result.body.recoveryToken), false);
    }
});
test('email/IIN and a normal session never substitute for the request capability', async () => {
    const result = await request();
    assert.equal((await call(recovery, { action: 'status' }, { actor: accounts.patient.token })).status, 401);
    assert.equal((await call(session, {}, { actor: result.body.recoveryToken, method: 'GET' })).status, 401);
    assert.equal((await call(recovery, { action: 'complete', email: accounts.patient.email, iin: accounts.patient.iin, newPassword: 'NewFixtureSecret34' })).status, 401);
    assert.equal((await call(recovery, { action: 'status' }, { cookie: result.headers.get('set-cookie').split(';')[0] })).body.status, 'pending');
});
test('only admin with confirmed password can review; list never contains token hashes or IIN', async () => {
    const result = await request();
    const [row] = await sql`SELECT id FROM password_recovery_requests WHERE token_hash = ${digest(result.body.recoveryToken)}`;
    const data = { action: 'review_recovery', requestId: row.id, approve: true, acknowledgeRisk: true, currentPassword: password };
    for (const role of ['patient', 'doctor']) assert.equal((await call(admin, data, { actor: accounts[role].token })).status, 403);
    assert.equal((await call(admin, { ...data, currentPassword: 'Wrong' }, { actor: accounts.admin.token })).status, 403);
    assert.equal((await call(admin, { ...data, acknowledgeRisk: false }, { actor: accounts.admin.token })).status, 400);
    const list = (await call(admin, { action: 'recovery_requests' }, { actor: accounts.admin.token })).body.requests;
    assert.equal(list.length, 1);
    assert.equal(list[0].token_hash, undefined); assert.equal(list[0].iin, undefined);
    assert.equal((await approve(result.body.recoveryToken)).status, 200);
    assert.equal((await approve(result.body.recoveryToken)).status, 409);
    assert.equal((await call(login, { email: accounts.patient.email, password })).status, 200);
});
test('approval is bound to one request; new password consumes it, revokes sessions and is audited', async () => {
    const first = (await request()).body.recoveryToken, second = (await request()).body.recoveryToken;
    const data = { action: 'complete', newPassword: 'NewFixtureSecret34' };
    assert.equal((await call(recovery, data, { token: first })).status, 409);
    await approve(first);
    assert.equal((await call(recovery, { action: 'status' }, { token: first })).body.status, 'approved');
    assert.equal((await call(recovery, data, { token: second })).status, 409);
    const result = await call(recovery, data, { token: first });
    assert.equal(result.status, 200); assert.equal(result.body.token, undefined);
    assert.equal(result.headers.getSetCookie().length, 2);
    assert.equal((await call(recovery, data, { token: first })).status, 409);
    assert.equal((await call(session, {}, { actor: accounts.patient.token, method: 'GET' })).status, 401);
    assert.equal((await call(login, { email: accounts.patient.email, password })).status, 401);
    assert.equal((await call(login, { email: accounts.patient.email, password: data.newPassword })).status, 200);
    assert.equal((await sql`SELECT status FROM password_recovery_requests WHERE token_hash = ${digest(second)}`)[0].status, 'rejected');
    assert.ok((await sql`SELECT id FROM security_audit WHERE action = 'password_recovered'`).length);
    await sql`UPDATE users SET password = ${await passwordHash(password)} WHERE id = ${accounts.patient.id}`;
    accounts.patient.token = (await call(login, { email: accounts.patient.email, password })).body.token;
});
test('expired, rejected, deactivated and changed-role approvals fail closed', async () => {
    for (const mutation of ['expired', 'rejected', 'inactive', 'role']) {
        await db.exec('DELETE FROM auth_throttle; DELETE FROM password_recovery_requests');
        const token = (await request()).body.recoveryToken;
        await approve(token, mutation !== 'rejected');
        if (mutation === 'expired') await sql`UPDATE password_recovery_requests SET expires_at = now() - interval '1 second'`;
        if (mutation === 'inactive') await sql`UPDATE users SET is_active = false WHERE id = ${accounts.patient.id}`;
        if (mutation === 'role') await sql`UPDATE users SET role = 'doctor' WHERE id = ${accounts.patient.id}`;
        assert.equal((await call(recovery, { action: 'complete', newPassword: 'NewFixtureSecret34' }, { token })).status, 409);
        await sql`UPDATE users SET is_active = true, role = 'patient' WHERE id = ${accounts.patient.id}`;
    }
});
test('anonymous recovery requests are rate-limited before writes', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await request()).status, 202);
    assert.equal((await request()).status, 429);
    assert.equal((await sql`SELECT count(*)::int AS n FROM password_recovery_requests`)[0].n, 3);
});
