import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, isDeepStrictEqual } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { preparePasswordRotation, applyPasswordRotation } from '../scripts/rotate-legacy-passwords.mjs';
import { passwordHash, passwordMatches, validatePassword } from '../netlify/lib/security.mjs';

const fixturePassword = 'RotationFixture12';
const migrationNames = ['20260924_sessions_prescriptions', '20260924_roles_audit', '20260925_data_protection'];

// Never let assertion diffs or raw PGlite errors print credential-bearing rows/parameters.
function same(actual, expected, message) {
    assert.equal(isDeepStrictEqual(actual, expected), true, message);
}

async function fails(operation, expectedMessage) {
    let caught;
    try { await operation(); } catch (error) { caught = error; }
    assert.equal(caught instanceof Error, true, 'Operation must fail closed');
    assert.equal(caught.message.startsWith(expectedMessage), true, 'Only a sanitized error may escape');
    assert.equal(caught.cause === undefined, true, 'No underlying driver error may escape');
    return caught;
}

test('operator password rotation with serial, in-memory Postgres fixtures', { concurrency: 1 }, async t => {
    const db = new PGlite();
    t.after(() => db.close());
    const query = async (text, params = []) => {
        try { return (await db.query(text, params)).rows; }
        catch { throw new Error('Fixture database query failed (values redacted).'); }
    };
    const exec = async text => {
        try { await db.exec(text); }
        catch { throw new Error('Fixture database command failed (values redacted).'); }
    };
    const migrations = [];
    for (const name of migrationNames) migrations.push(await readFile(new URL('../migrations/' + name + '.sql', import.meta.url), 'utf8'));
    const existingHash = await passwordHash(fixturePassword);
    let sql, calls, users;

    t.beforeEach(async () => {
        await exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
            CREATE TABLE users(id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT,
                iin VARCHAR(12) UNIQUE, role TEXT, custom_data JSONB);
            CREATE TABLE appointments(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_iin VARCHAR(12),
                date TEXT, time TEXT, type TEXT, message TEXT, status TEXT);
            CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_email TEXT,
                type TEXT, date TEXT, results JSONB, overall_status TEXT, created_at TIMESTAMPTZ);`);
        for (const migration of migrations) await exec(migration);
        const entries = [
            ['admin', existingHash, true], ['doctor', existingHash, false],
            ['admin', fixturePassword, false], ['doctor', fixturePassword, true],
            ['patient', fixturePassword, true], ['patient', null, false],
            ['patient', 'scrypt$invalid', true], ['patient', existingHash, true],
            ['patient', existingHash, false],
        ];
        for (const [index, [role, password, active]] of entries.entries()) {
            await query(`INSERT INTO users(name, email, password, iin, role, is_active, session_version,
                custom_data, blood_type, spec, city, exp, bio, img, rating)
                VALUES ($1, $2, $3, $4, $5, $6, 3, '{"preserve":[1,2,3]}', 'fixture-blood',
                    'fixture-spec', 'fixture-city', 'fixture-exp', 'fixture-bio', 'fixture-img', 4.5)`,
            ['Fixture user', `rotation-${index}@example.invalid`, password, String(900000000000 + index), role, active]);
        }
        users = await query('SELECT * FROM users ORDER BY id');
        for (const user of users) {
            await query(`INSERT INTO auth_sessions(token_hash, user_id, session_version, expires_at)
                VALUES ($1, $2, $3, now() + interval '1 day')`, [String(user.id).padStart(64, '0'), user.id, user.session_version]);
            for (const [index, status] of ['pending', 'approved', 'rejected', 'consumed'].entries()) {
                await query(`INSERT INTO password_recovery_requests(token_hash, user_id, session_version, status)
                    VALUES ($1, $2, $3, $4)`, [String(user.id * 10 + index).padStart(64, '0'), user.id, user.session_version, status]);
            }
        }
        await exec(`INSERT INTO appointments(patient_iin, doctor_iin, date, time, type, message, status,
                diagnosis, notes, treatment) VALUES ('900000000004', '900000000003', '2026-01-01', '09:00',
                'fixture', 'fixture-message', 'completed', 'fixture-diagnosis', 'fixture-notes', 'fixture-treatment');
            INSERT INTO analyses(patient_iin, type, results) VALUES ('900000000004', 'fixture-analysis', '{"fixture":true}');
            INSERT INTO prescriptions(doctor_id, patient_id, medicine, dosage, interval_hours, duration_days)
                VALUES (4, 5, 'fixture-medicine', 'fixture-dosage', 24, 2);
            INSERT INTO prescription_schedules(prescription_id, start_at, timezone) VALUES (1, now(), 'UTC');
            INSERT INTO chat_messages(sender, receiver, text) VALUES ('fixture-sender', 'fixture-receiver', 'fixture-message');`);
        calls = { built: 0, reads: 0, transactions: 0, executed: [], committed: 0, rolledBack: 0 };
        sql = {
            query(text, params = []) {
                calls.built++;
                // Match Neon's lazy queries: constructing a statement never executes it.
                return { text, params, then(resolve, reject) {
                    calls.reads++;
                    return query(text, params).then(resolve, reject);
                } };
            },
            async transaction(statements, options) {
                calls.transactions++;
                assert.equal(options.isolationLevel, 'Serializable');
                await exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
                const results = [];
                try {
                    for (const statement of statements) {
                        calls.executed.push(statement.text);
                        results.push(await query(statement.text, statement.params));
                    }
                    await exec('COMMIT');
                    calls.committed++;
                    return results;
                } catch (error) {
                    await exec('ROLLBACK');
                    calls.rolledBack++;
                    throw error;
                }
            },
        };
    });

    async function snapshot() {
        return {
            users: await query('SELECT * FROM users ORDER BY id'),
            sessions: await query('SELECT * FROM auth_sessions ORDER BY token_hash'),
            recovery: await query('SELECT * FROM password_recovery_requests ORDER BY token_hash'),
            audit: await query('SELECT * FROM security_audit ORDER BY id'),
            appointments: await query('SELECT * FROM appointments ORDER BY id'),
            analyses: await query('SELECT * FROM analyses ORDER BY id'),
            prescriptions: await query('SELECT * FROM prescriptions ORDER BY id'),
            schedules: await query('SELECT * FROM prescription_schedules ORDER BY prescription_id'),
            messages: await query('SELECT * FROM chat_messages ORDER BY id'),
        };
    }

    await t.test('all staff and only legacy/invalid patients receive unique strong replacements; preparation is read-only', async () => {
        const before = await snapshot();
        const plan = await preparePasswordRotation(sql);
        same(plan.credentials.map(c => c.id), [1, 2, 3, 4, 5, 6, 7], 'Target population must be complete');
        assert.equal(new Set(plan.credentials.map(c => c.newPassword)).size, 7);
        assert.equal(Object.isFrozen(plan) && Object.isFrozen(plan.credentials), true);
        for (const credential of plan.credentials) {
            same(Object.keys(credential).sort(), ['email', 'id', 'newPassword', 'role']);
            assert.equal(Object.isFrozen(credential), true);
            assert.equal(validatePassword(credential.newPassword) === credential.newPassword, true);
            assert.equal(/^R7!2[A-Za-z0-9_-]{43}$/.test(credential.newPassword), true);
            assert.equal(Buffer.from(credential.newPassword.slice(4), 'base64url').length >= 32, true);
        }
        for (const serialized of [JSON.stringify(plan), inspect(plan, { showHidden: true })]) {
            assert.equal(serialized.includes(fixturePassword) || serialized.includes(existingHash) || serialized.includes('oldPassword'), false);
        }
        same(await snapshot(), before, 'Preparation must preserve every row');
        assert.equal(calls.transactions, 0);
    });

    await t.test('durable callback precedes every statement; rotation revokes access, preserves data and audits an explicit admin', async () => {
        const before = await snapshot();
        const plan = await preparePasswordRotation(sql);
        const built = calls.built;
        let backup, finish;
        const gate = new Promise(resolve => { finish = resolve; });
        const applying = applyPasswordRotation(sql, plan, { actorAdminId: 1, persistRecovery: async credentials => {
            backup = JSON.parse(JSON.stringify(credentials));
            await gate;
        } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.built, built, 'No SQL may be built before persistence resolves');
        same(await snapshot(), before, 'Pending persistence must cause zero writes');
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Invalid password rotation');
        finish();
        const counts = await applying;
        same(counts, { rotated: 7, sessionsRevoked: 7, recoveryRequestsRevoked: 14, audited: 7 });
        assert.equal(Object.values(counts).every(Number.isInteger), true);
        assert.equal(calls.committed, 1);
        const after = await snapshot();
        for (const original of before.users) {
            const saved = after.users.find(row => row.id === original.id);
            const credential = backup.find(row => row.id === original.id);
            if (!credential) { same(saved, original, 'Valid hashed patients must stay untouched'); continue; }
            assert.equal(await passwordMatches(fixturePassword, saved.password), false, 'Old password must reject');
            assert.equal(await passwordMatches(credential.newPassword, saved.password), true, 'New password must authenticate');
            assert.equal(saved.password !== credential.newPassword && saved.password.startsWith('scrypt$'), true);
            same({ ...saved, password: original.password, session_version: original.session_version }, original,
                'No profile, role, active flag, or other user data may change');
            assert.equal(saved.session_version, original.session_version + 1);
        }
        const ids = new Set(backup.map(row => row.id));
        same(after.sessions, before.sessions.filter(row => !ids.has(row.user_id)));
        same(after.recovery, before.recovery.map(row => ids.has(row.user_id) && ['pending', 'approved'].includes(row.status)
            ? { ...row, status: 'rejected' } : row));
        for (const table of ['appointments', 'analyses', 'prescriptions', 'schedules', 'messages']) same(after[table], before[table]);
        same(after.audit.map(row => [row.actor_id, row.action, row.resource_type, Number(row.resource_id)]),
            backup.map(row => [1, 'password_rotated', 'user', row.id]));
        for (const credential of backup) assert.equal(JSON.stringify(after.audit).includes(credential.newPassword), false);
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Invalid password rotation');
        assert.equal(calls.transactions, 1, 'A persisted plan must be single-use');
    });

    await t.test('missing or failed persistence performs zero writes and strips callback error details', async () => {
        const before = await snapshot();
        const plan = await preparePasswordRotation(sql);
        const built = calls.built;
        await fails(() => applyPasswordRotation(sql, plan), 'Invalid password rotation');
        const error = await fails(() => applyPasswordRotation(sql, plan, { persistRecovery: async credentials => {
            await new Promise(resolve => setImmediate(resolve));
            throw new Error(JSON.stringify(credentials) + fixturePassword);
        } }), 'Recovery persistence failed');
        for (const secret of [fixturePassword, ...plan.credentials.map(row => row.newPassword)]) {
            assert.equal(inspect(error, { showHidden: true }).includes(secret), false);
        }
        assert.equal(calls.built, built);
        assert.equal(calls.transactions, 0);
        same(await snapshot(), before);
    });

    for (const [field, statement] of [
        ['password', "UPDATE users SET password = 'OtherFixture34' WHERE id = 7"],
        ['session version', 'UPDATE users SET session_version = session_version + 1 WHERE id = 7'],
        ['active flag', 'UPDATE users SET is_active = false WHERE id = 7'],
        ['role', "UPDATE users SET role = 'doctor' WHERE id = 7"],
        ['email', "UPDATE users SET email = 'changed@example.invalid' WHERE id = 7"],
    ]) {
        await t.test(`stale ${field} rejects and rolls back other matching password changes`, async () => {
            const plan = await preparePasswordRotation(sql);
            await exec(statement);
            const before = await snapshot();
            let persisted = false;
            await fails(() => applyPasswordRotation(sql, plan, { persistRecovery: async () => { persisted = true; } }),
                'Password rotation transaction failed');
            assert.equal(persisted, true);
            assert.equal(calls.rolledBack, 1);
            assert.equal(calls.executed.some(text => text.includes('UPDATE users AS u')), true);
            same(await snapshot(), before, 'Stale CAS must roll back the entire statement and transaction');
        });
    }

    await t.test('newly eligible users invalidate the complete target snapshot', async () => {
        const plan = await preparePasswordRotation(sql);
        await exec("UPDATE users SET password = 'NewLegacyFixture56' WHERE id = 9");
        const before = await snapshot();
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Password rotation transaction failed');
        same(await snapshot(), before);
    });

    await t.test('removed targets invalidate the snapshot without writing the remaining targets', async () => {
        const plan = await preparePasswordRotation(sql);
        await query('UPDATE users SET password = $1 WHERE id = 7', [existingHash]);
        const before = await snapshot();
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Password rotation transaction failed');
        same(await snapshot(), before);
    });

    await t.test('profile edits made after preparation are preserved at apply time', async () => {
        const plan = await preparePasswordRotation(sql);
        await exec(`UPDATE users SET name = 'Edited fixture', bio = 'Edited fixture bio',
            custom_data = '{"preserve":"edited"}' WHERE id = 5;`);
        const edited = (await query('SELECT * FROM users WHERE id = 5'))[0];
        await applyPasswordRotation(sql, plan, { persistRecovery() {} });
        const saved = (await query('SELECT * FROM users WHERE id = 5'))[0];
        same({ ...saved, password: edited.password, session_version: edited.session_version }, edited);
    });

    await t.test('raw read and transaction errors cannot leak credentials or SQL parameters', async () => {
        const readError = await fails(() => preparePasswordRotation({
            query: async () => { throw new Error(existingHash + fixturePassword); }, transaction() {},
        }), 'Password rotation preparation failed');
        assert.equal(inspect(readError, { showHidden: true }).includes(existingHash), false);
        const plan = await preparePasswordRotation(sql);
        const before = await snapshot();
        sql.transaction = async statements => {
            throw Object.assign(new Error(fixturePassword + JSON.stringify(plan.credentials)), {
                detail: existingHash, parameters: statements.map(statement => statement.params),
            });
        };
        const error = await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }),
            'Password rotation transaction failed');
        for (const secret of [existingHash, fixturePassword, ...plan.credentials.map(row => row.newPassword)]) {
            assert.equal(inspect(error, { showHidden: true }).includes(secret), false);
        }
        same(await snapshot(), before);
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Invalid password rotation');
    });

    await t.test('audit failure after password and revocation writes rolls back all of them', async () => {
        await exec(`CREATE FUNCTION fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'Fixture audit rejected'; END $$;
            CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON security_audit
                FOR EACH ROW EXECUTE FUNCTION fixture_reject_audit();`);
        const before = await snapshot();
        const plan = await preparePasswordRotation(sql);
        await fails(() => applyPasswordRotation(sql, plan, { actorAdminId: 1, persistRecovery() {} }),
            'Password rotation transaction failed');
        assert.equal(calls.rolledBack, 1);
        assert.equal(calls.executed.some(text => text.includes('UPDATE password_recovery_requests')), true);
        same(await snapshot(), before);
    });

    await t.test('audit actor is never guessed and must be an explicitly selected active admin', async () => {
        for (const actorAdminId of [2, 3, 999]) {
            const before = await snapshot();
            const plan = await preparePasswordRotation(sql);
            await fails(() => applyPasswordRotation(sql, plan, { actorAdminId, persistRecovery() {} }),
                'Password rotation transaction failed');
            same(await snapshot(), before);
        }
        const plan = await preparePasswordRotation(sql);
        const result = await applyPasswordRotation(sql, plan, { persistRecovery() {} });
        assert.equal(result.audited, 0);
        assert.equal((await query('SELECT * FROM security_audit')).length, 0);
    });

    await t.test('disabled and ineffective identity triggers fail closed', async () => {
        await exec('ALTER TABLE users DISABLE TRIGGER qamqor_identity_change');
        let plan = await preparePasswordRotation(sql);
        const before = await snapshot();
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Password rotation transaction failed');
        same(await snapshot(), before);
        await exec(`ALTER TABLE users ENABLE TRIGGER qamqor_identity_change;
            CREATE OR REPLACE FUNCTION qamqor_revoke_changed_identity() RETURNS trigger LANGUAGE plpgsql
                AS $$ BEGIN RETURN NEW; END $$;`);
        plan = await preparePasswordRotation(sql);
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Password rotation transaction failed');
        same(await snapshot(), before, 'A broken trigger must roll back passwords');
        await exec(`CREATE OR REPLACE FUNCTION qamqor_revoke_changed_identity() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN NEW.password := NULL; NEW.session_version := OLD.session_version + 1; RETURN NEW; END $$;`);
        plan = await preparePasswordRotation(sql);
        await fails(() => applyPasswordRotation(sql, plan, { persistRecovery() {} }), 'Password rotation transaction failed');
        same(await snapshot(), before, 'Null trigger results must fail closed, not disappear from aggregate checks');
    });

    await t.test('forged, duplicate, oversized, cross-client and invalid snapshots/plans fail without writes', async () => {
        const plan = await preparePasswordRotation(sql);
        const before = await snapshot();
        for (const candidate of [null, {}, JSON.parse(JSON.stringify(plan)),
            { credentials: [plan.credentials[0], plan.credentials[0]] }, { credentials: Array(1001).fill(plan.credentials[0]) }]) {
            await fails(() => applyPasswordRotation(sql, candidate, { persistRecovery() {} }), 'Invalid password rotation');
        }
        await fails(() => applyPasswordRotation({ ...sql }, plan, { persistRecovery() {} }), 'Invalid password rotation');
        for (const actorAdminId of [0, -1, 1.5, 2147483648, '1']) {
            await fails(() => applyPasswordRotation(sql, plan, { actorAdminId, persistRecovery() {} }), 'Invalid password rotation');
        }
        for (const rows of [[users[0], users[0]], Array(1001).fill(users[0]),
            [{ ...users[0], id: 2147483648 }], [{ ...users[0], session_version: 2147483647 }],
            [{ ...users[0], password: 'x'.repeat(4097) }], [{ ...users[0], role: 'unknown' }]]) {
            await fails(() => preparePasswordRotation({ query: async () => rows, transaction() {} }), 'Password rotation preparation failed');
        }
        assert.equal(calls.transactions, 0);
        same(await snapshot(), before);
    });

    await t.test('strict scrypt recognition rejects malformed hashes including suffixes and wrong lengths', async () => {
        const malformed = [existingHash + '\n', existingHash + '$extra', existingHash.slice(0, -1), existingHash.toUpperCase(), ''];
        for (const [index, password] of malformed.entries()) {
            await query("INSERT INTO users(name, email, password, role) VALUES ('Fixture', $1, $2, 'patient')",
                [`malformed-${index}@example.invalid`, password]);
        }
        const plan = await preparePasswordRotation(sql);
        assert.equal(plan.credentials.length, 12);
        assert.equal(plan.credentials.some(row => row.id === 8 || row.id === 9), false);
    });

    await t.test('target bounds reject a real oversized population rather than silently rotating a subset', async () => {
        await exec(`INSERT INTO users(name, email, password, role)
            SELECT 'Fixture', 'bulk-' || n || '@example.invalid', 'BulkFixture12', 'patient'
            FROM generate_series(1, 1000) AS n;`);
        const before = await snapshot();
        await fails(() => preparePasswordRotation(sql), 'Password rotation preparation failed');
        assert.equal(calls.transactions, 0);
        same(await snapshot(), before);
    });

    await t.test('empty target sets persist an empty backup and return zero counts', async () => {
        await query("UPDATE users SET role = 'patient', password = $1", [existingHash]);
        const before = await snapshot();
        const plan = await preparePasswordRotation(sql);
        let persisted = false;
        const result = await applyPasswordRotation(sql, plan, { persistRecovery: credentials => {
            assert.equal(credentials.length, 0);
            persisted = true;
        } });
        assert.equal(persisted, true);
        same(result, { rotated: 0, sessionsRevoked: 0, recoveryRequestsRevoked: 0, audited: 0 });
        same(await snapshot(), before);
    });
});
