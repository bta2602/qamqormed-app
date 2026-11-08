import test, { before, after, beforeEach } from 'node:test';
import './test-crypto-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { passwordHash, createSession, digest } from '../netlify/lib/security.mjs';
import admin from '../netlify/functions/admin.mjs';
import login from '../netlify/functions/login.mjs';
import session from '../netlify/functions/session.mjs';
import doctors from '../netlify/functions/get-doctors.mjs';
import appointments from '../netlify/functions/appointments.mjs';
import analyses from '../netlify/functions/get-analyses.mjs';
import saveAnalysis from '../netlify/functions/save-analysis.mjs';
import prescriptions from '../netlify/functions/prescriptions.mjs';
import profile from '../netlify/functions/update-user.mjs';
import chat from '../netlify/functions/chat.mjs';
import aiChat from '../netlify/functions/ai-chat.mjs';
import { AI_CONSENT_VERSION } from '../netlify/lib/gemini.mjs';

let db, sql;
const accounts = {};
const password = 'FixtureSecret12';
async function call(handler, data = {}, token = accounts.admin?.token, context = {}, headers = {}, method = 'POST') {
    const response = await handler(new Request('https://test.invalid/.netlify/functions/test', {
        method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    }), { testSql: sql, ip: '192.0.2.50', ...context });
    return { status: response.status, body: await response.json(), headers: response.headers };
}
before(async () => {
    db = new PGlite();
    sql = (parts, ...args) => db.query(parts.reduce((s, p, i) => s + (i ? '$' + i : '') + p, ''), args).then(r => r.rows);
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, iin VARCHAR(12) UNIQUE, role TEXT);
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_iin VARCHAR(12), date TEXT, time TEXT, type TEXT, message TEXT, status TEXT);
        CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_email TEXT, type TEXT, date TEXT, results JSONB, overall_status TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
    for (const name of ['20260924_sessions_prescriptions', '20260924_roles_audit', '20260925_data_protection', '20261109_encrypted_field_capacity']) {
        const migration = await readFile(new URL('../migrations/' + name + '.sql', import.meta.url), 'utf8');
        await db.exec(migration);
        await db.exec(migration);
    }
    const hash = await passwordHash(password);
    for (const [index, role] of ['admin', 'doctor', 'patient'].entries()) {
        const [user] = await sql`INSERT INTO users(name, email, password, iin, role, spec, city)
            VALUES (${role}, ${role + '@example.invalid'}, ${hash}, ${'90000000000' + index}, ${role}, 'Терапевт', 'Алматы') RETURNING *`;
        accounts[role] = { ...user, token: (await (await createSession(sql, user)).json()).token };
    }
    await sql`INSERT INTO appointments(patient_iin, doctor_iin, date, time, status)
        VALUES (${accounts.patient.iin}, ${accounts.doctor.iin}, '2026-09-25', '10:00', 'completed')`;
    await sql`INSERT INTO analyses(patient_iin, doctor_email, type, date, results, overall_status)
        VALUES (${accounts.patient.iin}, ${accounts.doctor.email}, 'Private fixture', '2026-09-25', '[]', 'normal')`;
});
beforeEach(async () => { await db.exec('DELETE FROM auth_throttle'); });
after(async () => { await db?.close(); });

test('role matrix: patients/doctors cannot enter admin; admin cannot impersonate a treating doctor', async () => {
    for (const role of ['patient', 'doctor']) for (const action of ['get_all', 'audit', 'medical_record', 'create', 'set_active']) {
        assert.equal((await call(admin, { action }, accounts[role].token)).status, 403);
    }
    assert.equal((await call(analyses, { iin: accounts.patient.iin })).status, 403);
    assert.equal((await call(prescriptions, { action: 'create', patientIin: accounts.patient.iin })).status, 403);
    assert.equal((await call(chat, { sender: accounts.admin.iin, receiver: 'support', action: 'get' })).status, 403);
    assert.equal((await call(appointments, { action: 'get', patientIin: accounts.admin.iin })).status, 403);
});

test('patient cannot forge an official laboratory result for themselves', async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM analyses`)[0].n;
    assert.equal((await call(saveAnalysis, { patientIIN: accounts.patient.iin, type: 'Forged', date: '2026-09-25',
        results: [{ name: 'x', value: 1, min: 0, max: 2 }], overallStatus: 'normal' }, accounts.patient.token)).status, 403);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0].n, before);
});

test('admin directory is paginated and excludes medical/government/credential fields', async () => {
    const result = await call(admin, { action: 'get_all', pageSize: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.users.length, 1);
    assert.ok(result.body.total >= 3);
    for (const key of ['iin', 'blood_type', 'password', 'session_version', 'token']) assert.equal(result.body.users[0][key], undefined);
    assert.equal((await call(admin, { action: 'get_all', pageSize: 100000 })).status, 400);
    assert.equal((await call(admin, { action: 'get_all', query: '%' })).body.users.length, 0);
});

test('medical access requires password and explicit purpose and records a minimal audit entry', async () => {
    const request = { action: 'medical_record', targetId: accounts.patient.id, currentPassword: password, reason: 'patient_request' };
    assert.equal((await call(admin, { ...request, currentPassword: 'wrong' })).status, 403);
    assert.equal((await call(admin, { ...request, reason: '' })).status, 400);
    const result = await call(admin, request);
    assert.equal(result.status, 200);
    assert.equal(result.body.patient.id, accounts.patient.id);
    assert.equal(result.body.analyses[0].type, 'Private fixture');
    assert.equal(result.body.messages, undefined);
    const [event] = await sql`SELECT * FROM security_audit ORDER BY id DESC LIMIT 1`;
    assert.equal(event.actor_id, accounts.admin.id);
    assert.equal(event.action, 'medical_read:patient_request');
    assert.equal(event.resource_id, accounts.patient.id);
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(accounts.patient.iin), false);
    assert.equal(serialized.includes(password), false);
});

test('audit failure prevents medical disclosure; audit rows cannot be modified or deleted', async () => {
    let clinicalReads = 0;
    const failAudit = (parts, ...args) => {
        const query = parts.join('');
        if (query.includes('INSERT INTO security_audit')) throw new Error('Synthetic audit failure');
        if (/FROM (appointments|analyses|prescriptions)/.test(query)) clinicalReads++;
        return sql(parts, ...args);
    };
    const result = await call(admin, { action: 'medical_record', targetId: accounts.patient.id, currentPassword: password,
        reason: 'care_review' }, undefined, { testSql: failAudit });
    assert.equal(result.status, 503);
    assert.equal(clinicalReads, 0);
    for (const statement of ['DELETE FROM security_audit', "UPDATE security_audit SET action = 'changed'", 'TRUNCATE security_audit']) {
        await assert.rejects(db.exec(statement), /append-only/);
    }
});

test('account creation is authenticated, hashed and audited; administrators cannot be created through this API', async () => {
    const request = { action: 'create', role: 'doctor', name: 'New doctor', email: 'new-doctor@example.invalid',
        iin: '900000000009', password, currentPassword: password, spec: 'Кардиолог', city: 'Астана' };
    assert.equal((await call(admin, { ...request, role: 'admin' })).status, 400);
    assert.equal((await call(admin, { ...request, currentPassword: '' })).status, 403);
    assert.equal((await call(admin, request)).status, 200);
    const [user] = await sql`SELECT * FROM users WHERE email = 'new-doctor@example.invalid'`;
    assert.match(user.password, /^scrypt\$/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM security_audit WHERE resource_id = ${user.id} AND action = 'account_created'`)[0].n, 1);
});

test('clinical identities cannot change role or be deleted through administration', async () => {
    assert.equal((await call(admin, { action: 'update', targetId: accounts.doctor.id, role: 'patient', name: 'doctor',
        email: accounts.doctor.email, currentPassword: password })).status, 409);
    assert.equal((await call(admin, { action: 'delete', targetId: accounts.patient.id, currentPassword: password })).status, 400);
    assert.equal((await call(admin, { action: 'set_active', targetId: accounts.admin.id, active: false, currentPassword: password })).status, 400);
});

test('admin cannot choose another account password and impersonate its owner', async () => {
    const [user] = await sql`SELECT * FROM users WHERE email = 'new-doctor@example.invalid'`;
    const oldToken = (await call(login, { email: user.email, password })).body.token;
    const request = { action: 'reset_password', targetId: user.id, newPassword: 'ChangedFixtureSecret34', currentPassword: password };
    assert.equal((await call(admin, { ...request, currentPassword: 'wrong' })).status, 400);
    assert.equal((await call(admin, { ...request, targetId: accounts.admin.id })).status, 400);
    assert.equal((await call(admin, request, accounts.patient.token)).status, 403);
    assert.equal((await call(admin, request)).status, 400);
    assert.equal((await call(session, {}, oldToken, {}, {}, 'GET')).status, 200);
    assert.equal((await call(login, { email: user.email, password })).status, 200);
    assert.equal((await call(login, { email: user.email, password: request.newPassword })).status, 401);
    const [saved] = await sql`SELECT password FROM users WHERE id = ${user.id}`;
    assert.match(saved.password, /^scrypt\$/);
    assert.equal(saved.password, user.password);
});

test('disabling an account immediately revokes sessions and catalogue visibility without deleting clinical records', async () => {
    const request = { action: 'set_active', targetId: accounts.doctor.id, active: false, currentPassword: password };
    assert.equal((await call(admin, request)).status, 200);
    assert.equal((await call(session, {}, accounts.doctor.token, {}, {}, 'GET')).status, 401);
    assert.equal((await call(login, { email: accounts.doctor.email, password })).status, 401);
    assert.equal((await call(doctors, {}, undefined, {}, {}, 'GET')).body.doctors.some(d => d.id === accounts.doctor.id), false);
    assert.equal((await sql`SELECT count(*)::int AS n FROM appointments WHERE doctor_iin = ${accounts.doctor.iin}`)[0].n, 1);
    assert.equal((await call(admin, { ...request, active: true })).status, 200);
    assert.equal((await call(session, {}, accounts.doctor.token, {}, {}, 'GET')).status, 401);
    accounts.doctor.token = (await call(login, { email: accounts.doctor.email, password })).body.token;
});

test('database role allowlist and direct role-change revocation cannot be bypassed through SQL edits', async () => {
    await assert.rejects(sql`UPDATE users SET role = 'superuser' WHERE id = ${accounts.patient.id}`, /users_role_allowlist/);
    await sql`UPDATE users SET role = 'doctor' WHERE id = ${accounts.patient.id}`;
    assert.equal((await call(session, {}, accounts.patient.token, {}, {}, 'GET')).status, 401);
    await sql`UPDATE users SET role = 'patient' WHERE id = ${accounts.patient.id}`;
    accounts.patient.token = (await call(login, { email: accounts.patient.email, password })).body.token;
});

test('staff sessions expire within eight hours; patient sessions retain their separate policy', async () => {
    for (const role of ['admin', 'doctor', 'patient']) {
        const [row] = await sql`SELECT extract(epoch FROM (expires_at - now()))::int AS seconds FROM auth_sessions WHERE token_hash = ${digest(accounts[role].token)}`;
        assert.ok(row.seconds > 0);
        assert.ok(row.seconds <= (role === 'patient' ? 2592000 : 28800));
    }
});

test('changing email requires current password while ordinary profile updates remain usable', async () => {
    const request = { action: 'update_profile', email: 'changed@example.invalid', bloodType: 'A+' };
    assert.equal((await call(profile, request, accounts.patient.token)).status, 403);
    assert.equal((await call(profile, { ...request, currentPassword: password }, accounts.patient.token)).status, 200);
    assert.equal((await call(profile, request, accounts.patient.token)).status, 200);
});

test('cross-site fetches and oversized/mistyped bodies fail before authorization or database work', async () => {
    assert.equal((await call(admin, { action: 'get_all' }, undefined, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call(admin, { value: 'x'.repeat(66000) })).status, 413);
    assert.equal((await call(admin, {}, undefined, {}, { 'Content-Type': 'application/json-malicious' })).status, 415);
});

test('doctor authorship uses immutable ID, not the current owner of an email', async () => {
    const result = await call(saveAnalysis, { patientIIN: accounts.patient.iin, type: 'Authorship fixture', date: '2026-09-25',
        results: [{ name: 'x', value: 1, min: 0, max: 2 }], overallStatus: 'normal' }, accounts.doctor.token);
    assert.equal(result.status, 200);
    await sql`UPDATE users SET email = 'moved-doctor@example.invalid' WHERE id = ${accounts.doctor.id}`;
    const [hash] = await sql`SELECT password FROM users WHERE id = ${accounts.patient.id}`;
    await sql`INSERT INTO users(name, email, password, iin, role) VALUES ('Other identity', ${accounts.doctor.email}, ${hash.password}, '900000000008', 'patient')`;
    const [analysis] = await sql`SELECT doctor_id, doctor_email FROM analyses WHERE id = ${result.body.id}`;
    assert.equal(analysis.doctor_id, accounts.doctor.id);
    assert.equal(analysis.doctor_email, accounts.doctor.email);
});

test('a completed clinical record cannot be silently overwritten via API or direct SQL', async () => {
    const [record] = await sql`SELECT id FROM appointments WHERE patient_iin = ${accounts.patient.iin} AND status = 'completed' LIMIT 1`;
    assert.equal((await call(appointments, { action: 'add_treatment', appointmentId: record.id, treatment: 'Overwrite' }, accounts.doctor.token)).status, 409);
    await assert.rejects(sql`UPDATE appointments SET diagnosis = 'Overwrite' WHERE id = ${record.id}`, /versioned amendment/);
});

test('a started course cannot be restarted; disabling reminders remains permitted', async () => {
    const [rx] = await sql`INSERT INTO prescriptions(doctor_id, patient_id, medicine, dosage, interval_hours, duration_days)
        VALUES (${accounts.doctor.id}, ${accounts.patient.id}, 'Course fixture', 'Fixture', 24, 1) RETURNING id`;
    await sql`INSERT INTO prescription_schedules(prescription_id, start_at, timezone) VALUES (${rx.id}, now() - interval '2 days', 'Asia/Almaty')`;
    const update = { action: 'schedule', id: Number(rx.id), startAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'Asia/Almaty', enabled: true };
    assert.equal((await call(prescriptions, update, accounts.patient.token)).status, 409);
    const [schedule] = await sql`SELECT start_at FROM prescription_schedules WHERE prescription_id = ${rx.id}`;
    assert.equal((await call(prescriptions, { ...update, startAt: new Date(schedule.start_at).toISOString(), enabled: false }, accounts.patient.token)).status, 200);
    await sql`UPDATE prescriptions SET status = 'revoked' WHERE id = ${rx.id}`;
    await assert.rejects(sql`UPDATE prescription_schedules SET reminders_enabled = true WHERE prescription_id = ${rx.id}`, /not active/);
    assert.equal((await sql`SELECT reminders_enabled FROM prescription_schedules WHERE prescription_id = ${rx.id}`)[0].reminders_enabled, false);
});

test('revocation disables schedules even when performed directly by the database operator', async () => {
    const [rx] = await sql`INSERT INTO prescriptions(doctor_id, patient_id, medicine, dosage, interval_hours, duration_days)
        VALUES (${accounts.doctor.id}, ${accounts.patient.id}, 'Revocation fixture', 'Fixture', 24, 1) RETURNING id`;
    await sql`INSERT INTO prescription_schedules(prescription_id, start_at, timezone) VALUES (${rx.id}, now() + interval '1 day', 'Asia/Almaty')`;
    await sql`UPDATE prescriptions SET status = 'revoked' WHERE id = ${rx.id}`;
    assert.equal((await sql`SELECT reminders_enabled FROM prescription_schedules WHERE prescription_id = ${rx.id}`)[0].reminders_enabled, false);
});

test('appointment grid, horizon and patient overlap are enforced server-side', async () => {
    const doctor = (await call(doctors, {}, undefined, {}, {}, 'GET')).body.doctors.find(d => d.id === accounts.doctor.id);
    const data = { action: 'book', patientIin: accounts.patient.iin, doctorIin: doctor.iin,
        date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), time: '10:00', type: 'В клинике' };
    assert.equal((await call(appointments, { ...data, time: '02:17' }, accounts.patient.token)).status, 400);
    assert.equal((await call(appointments, { ...data, date: new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10) }, accounts.patient.token)).status, 400);
    assert.equal((await call(appointments, data, accounts.patient.token)).status, 200);
    const otherDoctor = (await call(doctors, {}, undefined, {}, {}, 'GET')).body.doctors.find(d => d.id !== accounts.doctor.id);
    assert.equal((await call(appointments, { ...data, doctorIin: otherDoctor.iin }, accounts.patient.token)).status, 409);
});

test('AI content is never transmitted without explicit consent', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Should not transmit'); });
    const result = await call(chat, { action: 'send', sender: accounts.patient.iin, receiver: 'support', text: 'Private fixture' }, accounts.patient.token);
    assert.equal(result.status, 400);
    assert.equal(calls, 0);
});

test('AI content is not transmitted when encryption is unavailable', async t => {
    const keys = process.env.QAMQOR_DATA_KEYS;
    t.after(() => { process.env.QAMQOR_DATA_KEYS = keys; });
    delete process.env.QAMQOR_DATA_KEYS;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Should not transmit'); });
    const result = await call(chat, { action: 'send', sender: accounts.patient.iin, receiver: 'support',
        text: 'Private fixture', aiConsent: true, aiConsentVersion: AI_CONSENT_VERSION }, accounts.patient.token);
    assert.equal(result.status, 503);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(result.body), /Private fixture|QAMQOR_DATA/);
});

test('legacy or mismatched provider consent cannot transmit to Gemini', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not transmit'); });
    for (const version of [undefined, 'gemini-v1', 'groq-qwen-v1', 'other-provider']) {
        const result = await call(chat, { action: 'send', sender: accounts.patient.iin, receiver: 'support',
            text: 'Private fixture', aiConsent: true, aiConsentVersion: version }, accounts.patient.token);
        assert.equal(result.status, 400);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('Gemini chat scopes history, encrypts successful messages and never saves failed responses', async t => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture-only';
    t.after(() => { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; });
    await sql`DELETE FROM chat_messages`;
    await sql`INSERT INTO chat_messages(sender, receiver, text) VALUES (${accounts.doctor.iin}, 'support', 'Other user private fixture')`;
    let upstreamFailure = false;
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const payload = JSON.parse(init.body);
        assert.doesNotMatch(init.body, /Other user private fixture|90000000000|@example.invalid/);
        assert.equal(payload.contents.at(-1).parts[0].text, 'Question fixture');
        if (upstreamFailure) {
            assert.equal(payload.contents.at(-2).parts[0].text, 'Answer fixture');
            return new Response('private upstream error', { status: 429, headers: { 'Retry-After': '17' } });
        }
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
            { text: 'Do not persist', thought: true }, { text: 'Answer fixture' },
        ] } }] });
    });
    const request = { action: 'send', sender: accounts.patient.iin, receiver: 'support', text: 'Question fixture',
        aiConsent: true, aiConsentVersion: AI_CONSENT_VERSION };
    const result = await call(aiChat, request, accounts.patient.token);
    assert.equal(result.status, 200);
    assert.equal(result.body.reply, 'Answer fixture');
    const rows = await sql`SELECT text FROM chat_messages WHERE sender = ${accounts.patient.iin} OR receiver = ${accounts.patient.iin}`;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.doesNotMatch(row.text, /Question fixture|Answer fixture|Do not persist/);
    const history = await call(chat, { action: 'get', sender: accounts.patient.iin, receiver: 'support' }, accounts.patient.token);
    assert.deepEqual(history.body.messages.map(m => m.text), ['Question fixture', 'Answer fixture']);
    upstreamFailure = true;
    const failed = await call(aiChat, request, accounts.patient.token);
    assert.equal(failed.status, 429);
    assert.equal(failed.headers.get('Retry-After'), '17');
    assert.doesNotMatch(JSON.stringify(failed.body), /private upstream error/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM chat_messages`)[0].n, 3);
    assert.equal(fetch.mock.callCount(), 2);
});

test('dedicated AI route enforces method, action, session, role and current provider consent', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not transmit'); });
    const data = { action: 'send', sender: accounts.patient.iin, receiver: 'support', text: 'Fixture',
        aiConsent: true, aiConsentVersion: AI_CONSENT_VERSION };
    assert.equal((await call(aiChat, {}, accounts.patient.token, {}, {}, 'GET')).status, 405);
    assert.equal((await call(aiChat, { ...data, action: 'get' }, accounts.patient.token)).status, 400);
    assert.equal((await call(aiChat, { ...data, receiver: 'doctor' }, accounts.patient.token)).status, 400);
    assert.equal((await call(aiChat, data, 'invalid')).status, 401);
    assert.equal((await call(aiChat, { ...data, sender: accounts.admin.iin })).status, 403);
    assert.equal((await call(aiChat, { ...data, aiConsentVersion: undefined }, accounts.patient.token)).status, 400);
    assert.equal(fetch.mock.callCount(), 0);
});
