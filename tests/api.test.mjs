import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import login from '../netlify/functions/login.mjs';
import register from '../netlify/functions/register.mjs';
import session from '../netlify/functions/session.mjs';
import logout from '../netlify/functions/logout.mjs';
import doctors from '../netlify/functions/get-doctors.mjs';
import prescriptions from '../netlify/functions/prescriptions.mjs';
import appointments from '../netlify/functions/appointments.mjs';
import profile from '../netlify/functions/update-user.mjs';
import admin from '../netlify/functions/admin.mjs';
import getAnalyses from '../netlify/functions/get-analyses.mjs';
import saveAnalysis from '../netlify/functions/save-analysis.mjs';
import doctorAppointments from '../netlify/functions/get-doctor-appointments.mjs';
import chat from '../netlify/functions/chat.mjs';
import initDb from '../netlify/functions/init-db.mjs';
import clinics, { mapClinics } from '../netlify/functions/clinics.mjs';
import { digest, passwordMatches } from '../netlify/lib/security.mjs';

let db, sql, patientToken, doctorToken, otherToken, secondDoctorToken, adminToken, doctorPublic, prescriptionId;
const iins = { patient: '000000000001', doctor: '000000000002', other: '000000000003', doctor2: '000000000004', admin: '000000000005' };
const password = 'TestPassword12';
async function call(handler, data = {}, token, options = {}) {
    const method = options.method ?? 'POST';
    const response = await handler(new Request('https://qamqor-med.netlify.app/.netlify/functions/test' + (options.query ?? ''), {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    }), { testSql: sql, ip: '192.0.2.1', ...options.context });
    return { status: response.status, body: await response.json(), headers: response.headers };
}
before(async () => {
    db = new PGlite();
    sql = (strings, ...values) => db.query(strings.reduce((s, part, index) => s + (index ? '$' + index : '') + part, ''), values).then(r => r.rows);
    await db.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, password VARCHAR(100), iin VARCHAR(12) UNIQUE, role VARCHAR(20));
        CREATE TABLE appointments(id SERIAL PRIMARY KEY, doctor_id INTEGER NOT NULL, patient_iin VARCHAR(12), date VARCHAR(20), time VARCHAR(20), type TEXT, message TEXT, status TEXT);
        CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_email TEXT, type TEXT, date TEXT, results JSONB, overall_status TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
    const migration = await readFile(new URL('../migrations/20260924_sessions_prescriptions.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    for (const role of Object.keys(iins)) {
        const result = await call(register, { name: 'Тест ' + role, email: role + '@example.invalid', password, iin: iins[role], role: 'admin' });
        assert.equal(result.status, 200);
        assert.equal(result.body.user.role, 'patient');
        if (role === 'patient') patientToken = result.body.token;
        if (role === 'doctor') doctorToken = result.body.token;
        if (role === 'other') otherToken = result.body.token;
        if (role === 'doctor2') secondDoctorToken = result.body.token;
        if (role === 'admin') adminToken = result.body.token;
    }
    await sql`UPDATE users SET role = 'doctor', spec = 'Терапевт' WHERE iin = ${iins.doctor}`;
    await sql`UPDATE users SET role = 'doctor' WHERE iin = ${iins.doctor2}`;
    await sql`UPDATE users SET role = 'admin' WHERE iin = ${iins.admin}`;
    doctorPublic = (await call(doctors, {}, null, { method: 'GET' })).body.doctors[0].iin;
});
after(async () => { await db?.close(); });

test('password hashes, registration role and cookie-based session', async () => {
    const stored = (await sql`SELECT password FROM users WHERE iin = ${iins.patient}`)[0].password;
    assert.match(stored, /^scrypt\$/);
    assert.equal(await passwordMatches(password, stored), true);
    assert.equal(await passwordMatches('wrong', stored), false);
    const response = await call(login, { email: 'PATIENT@example.invalid', password });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(response.body.user.password, undefined);
    assert.equal(response.body.user.session_version, undefined);
    assert.equal((await sql`SELECT token_hash FROM auth_sessions WHERE token_hash = ${digest(response.body.token)}`).length, 1);
    assert.equal((await sql`SELECT token_hash FROM auth_sessions WHERE token_hash = ${response.body.token}`).length, 0);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await call(session, {}, null, { method: 'GET', headers: { Cookie: cookie } })).body.user.iin, iins.patient);
});
test('public doctor catalogue omits passwords, email and government identifier', async () => {
    const response = await call(doctors, {}, null, { method: 'GET' });
    assert.equal(response.status, 200);
    assert.notEqual(doctorPublic, iins.doctor);
    assert.match(doctorPublic, /^[a-f0-9-]{36}$/);
    assert.equal(response.body.doctors[0].password, undefined);
    assert.equal(response.body.doctors[0].email, undefined);
});
test('unauthenticated, forged role and cross-origin requests are rejected', async () => {
    assert.equal((await call(prescriptions, { action: 'get' })).status, 401);
    assert.equal((await call(admin, { action: 'get_all', adminEmail: 'admin@example.invalid' }, patientToken)).status, 403);
    assert.equal((await call(prescriptions, { action: 'create', patientIin: iins.other }, patientToken)).status, 403);
    assert.equal((await call(prescriptions, { action: 'get' }, patientToken, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
});

test('legacy database initialization endpoint is inert for every method', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const response = await initDb(new Request('https://qamqor-med.netlify.app/.netlify/functions/init-db', { method }));
        assert.equal(response.status, 404);
    }
});
test('a doctor cannot prescribe before a care relationship exists', async () => {
    assert.equal((await call(prescriptions, { action: 'create', patientIin: iins.patient }, doctorToken)).status, 403);
});

test('expired, missing, malformed and revoked bearer/cookie sessions fail closed', async () => {
    const result = await call(login, { email: 'other@example.invalid', password });
    const token = result.body.token;
    await sql`UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = ${digest(token)}`;
    assert.equal((await call(session, {}, token, { method: 'GET' })).status, 401);
    assert.equal((await call(prescriptions, { action: 'get' }, token)).status, 401);
    assert.equal((await call(session, {}, null, { method: 'GET', headers: { Cookie: '__Host-qamqor=' + token } })).status, 401);
    assert.equal((await call(session, {}, 'x'.repeat(43), { method: 'GET' })).status, 401);
    assert.equal((await call(session, {}, null, { method: 'GET', headers: {
        Cookie: '__Host-qamqor=' + patientToken, Authorization: 'Basic fake',
    } })).status, 401);
    const cookie = '__Host-qamqor=' + otherToken;
    const fresh = await call(login, { email: 'other@example.invalid', password });
    assert.equal((await call(logout, {}, fresh.body.token)).status, 200);
    assert.equal((await call(session, {}, null, { method: 'GET', headers: { Cookie: '__Host-qamqor=' + fresh.body.token } })).status, 401);
    assert.equal((await call(session, {}, null, { method: 'GET', headers: { Cookie: cookie } })).status, 200);
});
test('booking ownership, real doctor and slot uniqueness', async () => {
    const data = { action: 'book', patientIin: iins.patient, doctorIin: doctorPublic,
        date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), time: '10:00', type: 'В клинике', message: '' };
    assert.equal((await call(appointments, data, otherToken)).status, 403);
    assert.equal((await call(appointments, { ...data, date: '2026-02-30' }, patientToken)).status, 400);
    assert.equal((await call(appointments, data, patientToken)).status, 200);
    assert.equal((await call(appointments, data, patientToken)).status, 409);
    const rows = await call(appointments, { action: 'get', patientIin: iins.patient }, patientToken);
    assert.equal(rows.body.appointments[0].doctor_iin, doctorPublic);
});
test('prescribe, patient scheduling, interval validation and isolation', async () => {
    const value = { action: 'create', patientIin: iins.patient, medicine: 'Тестовый препарат', dosage: 'По назначению', instructions: '', intervalHours: 8, durationDays: 7 };
    assert.equal((await call(prescriptions, { ...value, intervalHours: 0 }, doctorToken)).status, 400);
    const result = await call(prescriptions, value, doctorToken);
    assert.equal(result.status, 200);
    prescriptionId = result.body.id;
    const schedule = { action: 'schedule', id: prescriptionId, startAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'Asia/Almaty', enabled: true };
    assert.equal((await call(prescriptions, schedule, otherToken)).status, 404);
    assert.equal((await call(prescriptions, schedule, doctorToken)).status, 403);
    assert.equal((await call(prescriptions, { ...schedule, timezone: 'Fake/Zone' }, patientToken)).status, 400);
    assert.equal((await call(prescriptions, schedule, patientToken)).status, 200);
    assert.equal((await call(prescriptions, { action: 'get' }, patientToken)).body.prescriptions.length, 1);
    assert.equal((await call(prescriptions, { action: 'get' }, otherToken)).body.prescriptions.length, 0);
});
test('only prescribing doctor may revoke, revoked treatment cannot be scheduled', async () => {
    assert.equal((await call(prescriptions, { action: 'revoke', id: prescriptionId }, patientToken)).status, 403);
    assert.equal((await call(prescriptions, { action: 'revoke', id: prescriptionId }, secondDoctorToken)).status, 404);
    assert.equal((await call(prescriptions, { action: 'get' }, secondDoctorToken)).body.prescriptions.length, 0);
    assert.equal((await call(prescriptions, { action: 'revoke', id: prescriptionId }, doctorToken)).status, 200);
    assert.equal((await call(prescriptions, { action: 'get' }, patientToken)).body.prescriptions[0].reminders_enabled, false);
    assert.equal((await sql`SELECT reminders_enabled FROM prescription_schedules WHERE prescription_id = ${prescriptionId}`)[0].reminders_enabled, false);
    assert.equal((await call(prescriptions, { action: 'schedule', id: prescriptionId, startAt: new Date().toISOString(), timezone: 'Asia/Almaty', enabled: true }, patientToken)).status, 404);
});

test('appointment lists and mutations are isolated across both patients and doctors', async () => {
    const [appointment] = await sql`SELECT id FROM appointments WHERE patient_iin = ${iins.patient} AND status = 'upcoming'`;
    assert.equal((await call(appointments, { action: 'get', patientIin: iins.patient }, otherToken)).status, 403);
    assert.equal((await call(doctorAppointments, {}, patientToken)).status, 403);
    assert.equal((await call(doctorAppointments, { doctor_iin: iins.doctor }, secondDoctorToken)).status, 403);
    assert.deepEqual((await call(doctorAppointments, {}, secondDoctorToken)).body.appointments, []);
    assert.equal((await call(doctorAppointments, {}, doctorToken)).body.appointments.length, 1);
    for (const token of [otherToken, secondDoctorToken]) {
        assert.equal((await call(appointments, { action: 'cancel', appointmentId: appointment.id }, token)).status, 409);
    }
    assert.equal((await call(appointments, { action: 'complete', appointmentId: appointment.id }, patientToken)).status, 403);
    assert.equal((await call(appointments, { action: 'complete', appointmentId: appointment.id }, secondDoctorToken)).status, 409);
    assert.equal((await call(appointments, { action: 'add_treatment', appointmentId: appointment.id, treatment: 'Test' }, secondDoctorToken)).status, 409);
    assert.equal((await call(appointments, { action: 'add_treatment', appointmentId: appointment.id, treatment: 'Test' }, patientToken)).status, 403);
    assert.equal((await call(appointments, { action: 'add_treatment', appointmentId: appointment.id, treatment: 'Test' }, doctorToken)).status, 200);
    assert.equal((await sql`SELECT status FROM appointments WHERE id = ${appointment.id}`)[0].status, 'upcoming');
});

test('analyses cannot be read or written by unrelated patients or doctors', async () => {
    const analysis = { patientIIN: iins.patient, type: 'Test', date: '2026-09-24',
        results: [{ name: 'Test', value: 1, min: 0, max: 2 }], overallStatus: 'normal' };
    for (const token of [otherToken, secondDoctorToken, adminToken]) {
        assert.equal((await call(getAnalyses, { iin: iins.patient }, token)).status, 403);
        assert.equal((await call(saveAnalysis, analysis, token)).status, 403);
    }
    assert.equal((await call(saveAnalysis, analysis, doctorToken)).status, 200);
    assert.equal((await call(getAnalyses, { iin: iins.patient }, patientToken)).body.analyses.length, 1);
    assert.equal((await call(getAnalyses, { iin: iins.patient }, doctorToken)).body.analyses.length, 1);
    assert.equal((await call(getAnalyses, { iin: Number(iins.patient) }, patientToken)).status, 400);
});

test('malformed analyses fail validation without completing the appointment', async () => {
    const [appointment] = await sql`SELECT id FROM appointments WHERE patient_iin = ${iins.patient} AND status = 'upcoming'`;
    for (const results of [[null], [{ name: 'Test', value: '1', min: 0, max: 2 }], [{ name: 'Test', value: 1, min: 2, max: 0 }]]) {
        const analysis = { type: 'Test', date: '2026-09-24', results, overallStatus: 'normal' };
        assert.equal((await call(saveAnalysis, { ...analysis, patientIIN: iins.patient }, doctorToken)).status, 400);
        assert.equal((await call(appointments, { action: 'complete', appointmentId: appointment.id, analysis }, doctorToken)).status, 400);
    }
    assert.equal((await sql`SELECT status FROM appointments WHERE id = ${appointment.id}`)[0].status, 'upcoming');
});

test('valid completion atomically saves the analysis and cannot be repeated', async () => {
    const [appointment] = await sql`SELECT id FROM appointments WHERE patient_iin = ${iins.patient} AND status = 'upcoming'`;
    const analysis = { type: 'Test', date: '2026-09-24', results: [{ name: 'Test', value: 1, min: 0, max: 2 }], overallStatus: 'normal' };
    const before = (await sql`SELECT count(*)::int AS n FROM analyses`)[0].n;
    const completion = { action: 'complete', appointmentId: appointment.id, diagnosis: 'Test diagnosis', analysis };
    assert.equal((await call(appointments, completion, doctorToken)).status, 200);
    assert.equal((await sql`SELECT status FROM appointments WHERE id = ${appointment.id}`)[0].status, 'completed');
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0].n, before + 1);
    assert.equal((await call(appointments, completion, doctorToken)).status, 409);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0].n, before + 1);
});

test('doctor/patient chat is private and sender cannot be spoofed', async () => {
    const message = { action: 'send', sender: iins.patient, receiver: doctorPublic, text: 'Private test message' };
    assert.equal((await call(chat, message, otherToken)).status, 403);
    assert.equal((await call(chat, { ...message, sender: iins.other }, otherToken)).status, 403);
    assert.equal((await call(chat, message, patientToken)).status, 200);
    const publicHistory = await call(chat, { ...message, action: 'get' }, patientToken);
    assert.equal(publicHistory.body.messages[0].receiver, doctorPublic);
    assert.equal(JSON.stringify(publicHistory.body).includes(iins.doctor), false);
    const legacyHistory = await call(chat, { ...message, action: 'get', receiver: iins.doctor }, patientToken);
    assert.deepEqual(legacyHistory.body.messages, publicHistory.body.messages);
    const history = await call(chat, { action: 'get', sender: iins.doctor, receiver: iins.patient }, doctorToken);
    assert.equal(history.body.messages.length, 1);
    assert.equal((await call(chat, { action: 'get', sender: iins.doctor2, receiver: iins.patient }, secondDoctorToken)).status, 403);
    assert.deepEqual((await call(chat, { action: 'get', sender: iins.other, receiver: 'support' }, otherToken)).body.messages, []);
});

test('cancelled appointments do not establish care access; completed appointments do', async () => {
    const [appointment] = await sql`INSERT INTO appointments(patient_iin, doctor_iin, date, time, status)
        VALUES (${iins.other}, ${iins.doctor2}, '2026-10-15', '14:00', 'cancelled') RETURNING id`;
    assert.equal((await call(getAnalyses, { iin: iins.other }, secondDoctorToken)).status, 403);
    assert.equal((await call(prescriptions, { action: 'create', patientIin: iins.other }, secondDoctorToken)).status, 403);
    await sql`UPDATE appointments SET status = 'completed' WHERE id = ${appointment.id}`;
    assert.equal((await call(getAnalyses, { iin: iins.other }, secondDoctorToken)).status, 200);
});

test('prescription schedule rejects impossible dates and supports Android fractional timestamps', async () => {
    const result = await call(prescriptions, { action: 'create', patientIin: iins.patient, medicine: 'Test', dosage: 'Test', intervalHours: 24, durationDays: 1 }, doctorToken);
    assert.equal(result.status, 200);
    const schedule = { action: 'schedule', id: result.body.id, timezone: 'Asia/Almaty', enabled: true };
    const year = new Date().getUTCFullYear();
    assert.equal((await call(prescriptions, { ...schedule, startAt: year + '-02-30T12:00:00Z' }, patientToken)).status, 400);
    const timestamp = new Date().toISOString().replace('Z', '123456Z');
    assert.equal((await call(prescriptions, { ...schedule, startAt: timestamp }, patientToken)).status, 200);
});
test('profile changes cannot modify another user; logout invalidates server session', async () => {
    assert.equal((await call(profile, { action: 'update_profile', iin: iins.patient, email: 'new@example.invalid', bloodType: 'A+' }, otherToken)).status, 403);
    const result = await call(login, { email: 'other@example.invalid', password });
    assert.equal((await call(logout, {}, result.body.token)).status, 200);
    assert.equal((await call(session, {}, result.body.token, { method: 'GET' })).status, 401);
});
test('legacy plaintext passwords upgrade during login', async () => {
    await sql`INSERT INTO users(name, email, password, iin, role) VALUES ('Legacy', 'legacy@example.invalid', ${password}, '000000000009', 'patient')`;
    assert.equal((await call(login, { email: 'legacy@example.invalid', password })).status, 200);
    assert.match((await sql`SELECT password FROM users WHERE email = 'legacy@example.invalid'`)[0].password, /^scrypt\$/);
});

test('password change checks old/new passwords and invalidates other devices, not the current one', async () => {
    const second = await call(login, { email: 'patient@example.invalid', password });
    const change = { action: 'change_password', oldPassword: password, newPassword: 'UpdatedPassword34' };
    assert.equal((await call(profile, { ...change, oldPassword: 'wrong' }, patientToken)).status, 400);
    assert.equal((await call(profile, { ...change, newPassword: 'short' }, patientToken)).status, 400);
    assert.equal((await call(profile, change, patientToken)).status, 200);
    assert.equal((await call(session, {}, second.body.token, { method: 'GET' })).status, 401);
    assert.equal((await call(session, {}, patientToken, { method: 'GET' })).status, 200);
    assert.equal((await call(login, { email: 'patient@example.invalid', password })).status, 401);
    assert.equal((await call(login, { email: 'patient@example.invalid', password: change.newPassword })).status, 200);
});

test('an in-flight login cannot mint a usable session after a password change', async () => {
    let intercepted = false;
    const racingSql = async (strings, ...values) => {
        if (strings.join('').includes('INSERT INTO auth_sessions')) {
            intercepted = true;
            assert.equal((await call(profile, { action: 'change_password', oldPassword: password, newPassword: 'ChangedPassword56' }, otherToken)).status, 200);
        }
        return sql(strings, ...values);
    };
    const result = await call(login, { email: 'other@example.invalid', password }, null, { context: { testSql: racingSql } });
    assert.equal(intercepted, true);
    assert.equal(result.status, 401);
    assert.equal(result.body.token, undefined);
    // Model a stale PostgreSQL snapshot inserting an old version after the revocation DELETE.
    const staleToken = 's'.repeat(43);
    await sql`INSERT INTO auth_sessions(token_hash, user_id, session_version, expires_at)
        SELECT ${digest(staleToken)}, id, session_version - 1, now() + interval '1 day' FROM users WHERE iin = ${iins.other}`;
    assert.equal((await call(session, {}, staleToken, { method: 'GET' })).status, 401);
});

test('administrator edits revoke target sessions and cannot delete clinical identities', async () => {
    const result = await call(admin, { action: 'update', targetIin: iins.doctor2, name: 'Second doctor', email: 'doctor2@example.invalid', role: 'patient' }, adminToken);
    assert.equal(result.status, 200);
    assert.equal((await call(session, {}, secondDoctorToken, { method: 'GET' })).status, 401);
    assert.equal((await call(session, {}, adminToken, { method: 'GET' })).status, 200);
    assert.equal((await call(admin, { action: 'delete', targetIin: iins.patient }, adminToken)).status, 409);
    assert.equal((await sql`SELECT id FROM users WHERE iin = ${iins.patient}`).length, 1);
});
test('clinic cities are allowlisted and incomplete upstream results are not shown as complete', async () => {
    assert.equal((await call(clinics, {}, null, { method: 'GET', query: '?city=arbitrary' })).status, 400);
    const result = await call(clinics, {}, null, { method: 'GET', query: '?city=astana', context: {
        testFetch: async () => new Response(JSON.stringify({ remark: 'timeout', elements: [] })),
    } });
    assert.equal(result.status, 503);
    const rows = mapClinics([{ type: 'node', id: 1, lat: 51, lon: 71, tags: { name: 'Clinic' } },
        { type: 'way', id: 2, center: { lat: 51, lon: 71 }, tags: { name: 'Clinic' } }]);
    assert.equal(rows.length, 1);
});
