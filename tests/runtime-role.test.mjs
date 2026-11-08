import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { provisionRuntimeRole, verifyRuntimeRole, configureRuntimeRowPolicies } from '../scripts/lib/runtime-role.mjs';

const migrations = await Promise.all(['20260924_sessions_prescriptions', '20260924_roles_audit',
    '20260925_data_protection', '20261109_encrypted_field_capacity'].map(name =>
    readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8')));

async function sanitizedFailure(operation, prefix, password = '') {
    let error;
    try { await operation(); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, 'Operation must fail');
    assert.ok(error.message.startsWith(prefix), 'Only sanitized errors may escape');
    assert.equal(error.cause, undefined);
    if (password) assert.equal(inspect(error, { showHidden: true }).includes(password), false);
}

test('runtime role: isolated PostgreSQL permission and rollback checks', async t => {
    const db = new PGlite();
    t.after(() => db.close());
    const password = randomBytes(32).toString('base64url');
    let calls;
    const query = async (text, params = []) => {
        try { return (await db.query(text, params)).rows; }
        catch (error) { throw Object.assign(new Error('Fixture query failed; details redacted.'), { code: error.code }); }
    };
    const exec = async text => {
        try { await db.exec(text); }
        catch (error) { throw Object.assign(new Error('Fixture command failed; details redacted.'), { code: error.code }); }
    };
    const sql = {
        query(text, params = []) {
            calls.built.push({ text, params });
            return { text, params, then(resolve, reject) { return query(text, params).then(resolve, reject); } };
        },
        async transaction(statements, options) {
            calls.transactions++;
            assert.deepEqual(options, { isolationLevel: 'Serializable', readOnly: false, arrayMode: false, fullResults: false });
            await exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
            try {
                const results = [];
                for (const statement of statements) results.push(await query(statement.text, statement.params));
                await exec('COMMIT');
                calls.commits++;
                return results;
            } catch (error) {
                await exec('ROLLBACK');
                calls.rollbacks++;
                throw error;
            }
        },
    };
    const roleExists = async () => (await query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qamqor_runtime') AS present"))[0].present;
    const denied = async statement => {
        await assert.rejects(() => query(statement), error => error.code === '42501', `Must deny: ${statement}`);
    };
    async function asRuntime(operation) {
        await exec('SET ROLE qamqor_runtime');
        try { await operation(); } finally { await exec('RESET ROLE'); }
    }
    t.beforeEach(async () => {
        await exec('RESET ROLE');
        if (await roleExists()) await exec('DROP OWNED BY qamqor_runtime; DROP ROLE qamqor_runtime');
        await exec(`DROP SCHEMA IF EXISTS fixture_extra CASCADE;
            DROP SCHEMA public CASCADE; CREATE SCHEMA public;
            GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
            DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$;
            CREATE TABLE users(id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT,
                iin VARCHAR(12) UNIQUE, role TEXT);
            CREATE TABLE appointments(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_iin VARCHAR(12),
                date TEXT, time TEXT, type TEXT, message TEXT, status TEXT);
            CREATE TABLE analyses(id SERIAL PRIMARY KEY, patient_iin VARCHAR(12), doctor_email TEXT,
                type TEXT, date TEXT, results JSONB, overall_status TEXT, created_at TIMESTAMPTZ DEFAULT now());`);
        for (const migration of migrations) await exec(migration);
        await exec(`INSERT INTO users(name, email, password, iin, role) VALUES
            ('Doctor', 'doctor@example.invalid', 'fixture', '900000000001', 'doctor'),
            ('Patient', 'patient@example.invalid', 'fixture', '900000000002', 'patient');`);
        calls = { built: [], transactions: 0, commits: 0, rollbacks: 0 };
    });

    await t.test('creates exact role atomically with bound password and metadata-only results', async () => {
        const result = await provisionRuntimeRole(sql, password);
        assert.equal(result.role, 'qamqor_runtime');
        assert.equal(result.verified, true);
        assert.equal(Object.values(result.checks).every(value => value === true), true);
        assert.equal(JSON.stringify(result).includes(password), false);
        assert.equal(calls.transactions, 1);
        assert.equal(calls.commits, 1);
        assert.equal(calls.built.every(statement => !statement.text.includes(password)), true);
        assert.equal(calls.built.filter(statement => statement.params.includes(password)).length, 1);
        assert.match(calls.built.find(statement => statement.params.includes(password)).text, /set_config/);
        assert.equal((await query("SELECT current_setting('qamqor.runtime_password', true) AS value"))[0].value, '');
        const [stored] = await query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS is_scram FROM pg_authid WHERE rolname = 'qamqor_runtime'");
        assert.equal(stored.is_scram, true);
        assert.deepEqual(await verifyRuntimeRole(sql), result);
        assert.equal(calls.transactions, 1, 'Verification is read-only');
    });

    await t.test('existing RLS remains enabled with a policy only for the trusted server role', async () => {
        await exec('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
        await provisionRuntimeRole(sql,password);
        await asRuntime(async () => {
            assert.equal((await query('SELECT count(*)::int AS n FROM users'))[0].n,2);
        });
        const [policy] = await query("SELECT p.polroles = ARRAY[r.oid] AS only_server FROM pg_policy p JOIN pg_roles r ON r.rolname='qamqor_runtime' WHERE p.polrelid='users'::regclass AND p.polname='qamqor_server_access'");
        assert.equal(policy.only_server,true);
        await exec('DROP POLICY qamqor_server_access ON users');
        await asRuntime(async () => { assert.equal((await query('SELECT count(*)::int AS n FROM users'))[0].n,0); });
        await configureRuntimeRowPolicies(sql);
        await verifyRuntimeRole(sql);
        await exec('ALTER POLICY qamqor_server_access ON users TO PUBLIC');
        await sanitizedFailure(()=>configureRuntimeRowPolicies(sql),'Runtime row policies could not be configured');
        await sanitizedFailure(()=>verifyRuntimeRole(sql),'Runtime role verification failed');
    });

    await t.test('runtime CRUD and sequences work while existing security triggers keep working', async () => {
        await provisionRuntimeRole(sql, password);
        await asRuntime(async () => {
            await exec(`INSERT INTO analyses(patient_iin, type, results) VALUES ('900000000002', 'fixture', '[]');
                UPDATE analyses SET type = 'updated'; DELETE FROM analyses;
                INSERT INTO appointments(patient_iin, doctor_iin, date, time, status)
                    VALUES ('900000000002', '900000000001', '2026-11-10', '09:00', 'completed');
                INSERT INTO prescriptions(doctor_id, patient_id, medicine, dosage, interval_hours, duration_days)
                    VALUES (1, 2, 'fixture', 'fixture', 24, 2);
                INSERT INTO prescription_schedules(prescription_id, start_at, timezone) VALUES (1, now(), 'UTC');
                UPDATE prescriptions SET status = 'revoked' WHERE id = 1;
                UPDATE users SET password = 'changed-fixture' WHERE id = 2;
                INSERT INTO security_audit(actor_id, action, resource_type, resource_id) VALUES (1, 'fixture', 'user', 2);
                INSERT INTO chat_messages(sender, receiver, text) VALUES ('fixture', 'fixture', 'fixture');
                UPDATE chat_messages SET text = 'updated'; DELETE FROM chat_messages;
                INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES (repeat('a', 64), 2, now());
                UPDATE auth_sessions SET expires_at = now(); DELETE FROM auth_sessions;
                INSERT INTO auth_throttle(bucket) VALUES (repeat('b', 64));
                UPDATE auth_throttle SET hits = 2; DELETE FROM auth_throttle;
                INSERT INTO password_recovery_requests(token_hash, user_id, session_version) VALUES (repeat('c', 64), 2, 2);
                UPDATE password_recovery_requests SET status = 'rejected'; DELETE FROM password_recovery_requests;`);
            assert.equal((await query('SELECT session_version FROM users WHERE id = 2'))[0].session_version, 2);
            assert.equal((await query('SELECT reminders_enabled FROM prescription_schedules'))[0].reminders_enabled, false);
            assert.equal((await query('SELECT count(*)::int AS n FROM security_audit'))[0].n, 1);
            assert.ok((await query('SELECT * FROM qamqormed_schema_migrations')).length >= 3);
            await assert.rejects(() => query("UPDATE prescription_schedules SET reminders_enabled = true"), error => error.code === '23514');
            await assert.rejects(() => query("UPDATE appointments SET status = 'cancelled'"), error => error.code === '23514');
        });
    });

    await t.test('SET ROLE cannot perform DDL, escalate, bypass triggers, truncate, or mutate audit/receipts', async () => {
        await provisionRuntimeRole(sql, password);
        await asRuntime(async () => {
            for (const statement of [
                'CREATE ROLE fixture_escalation', 'ALTER ROLE qamqor_runtime SUPERUSER',
                'CREATE TABLE public.fixture_denied(id int)', 'CREATE TEMP TABLE fixture_denied(id int)',
                'CREATE SCHEMA fixture_denied', 'ALTER TABLE public.users ADD COLUMN fixture_denied int',
                'DROP TABLE public.auth_throttle', 'ALTER TABLE public.users DISABLE TRIGGER ALL',
                'ALTER TABLE public.security_audit DISABLE TRIGGER ALL', "SET session_replication_role = 'replica'",
                'TRUNCATE public.users', 'TRUNCATE public.auth_throttle', 'TRUNCATE public.security_audit',
                "UPDATE public.security_audit SET action = 'tampered'", 'DELETE FROM public.security_audit',
                "INSERT INTO public.qamqormed_schema_migrations(version) VALUES ('tampered')",
                'DELETE FROM public.qamqormed_schema_migrations',
                "SELECT setval('public.users_id_seq', 1)",
                'CREATE OR REPLACE FUNCTION public.qamqor_protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
            ]) await denied(statement);
            // PostgreSQL may warn instead of throwing when GRANT has no grantable privileges.
            await query('GRANT SELECT ON public.users TO PUBLIC');
            assert.equal((await query(`SELECT EXISTS (SELECT 1 FROM pg_class c,
                LATERAL aclexplode(c.relacl) a WHERE c.oid = 'public.users'::regclass
                AND a.grantee = 0 AND a.privilege_type = 'SELECT') AS granted`))[0].granted, false);
        });
    });

    await t.test('existing roles are refused without changing password, flags or ACLs', async () => {
        await provisionRuntimeRole(sql, password);
        const [before] = await query("SELECT rolpassword FROM pg_authid WHERE rolname = 'qamqor_runtime'");
        await sanitizedFailure(() => provisionRuntimeRole(sql, randomBytes(48).toString('base64url')), 'Runtime role provisioning failed');
        const [after] = await query("SELECT rolpassword FROM pg_authid WHERE rolname = 'qamqor_runtime'");
        assert.equal(before.rolpassword === after.rolpassword, true, 'Existing password is never replaced');
        assert.equal(calls.commits, 1);
        await verifyRuntimeRole(sql);
    });

    await t.test('missing schema rolls back role and scoped PUBLIC changes', async () => {
        await exec('DROP TABLE password_recovery_requests');
        await sanitizedFailure(() => provisionRuntimeRole(sql, password), 'Runtime role provisioning failed', password);
        assert.equal(await roleExists(), false);
        assert.equal(calls.rollbacks, 1);
        assert.equal((await query("SELECT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS present"))[0].present, true);
    });

    for (const [name, setup] of [
        ['other schema CREATE', 'CREATE SCHEMA fixture_extra; GRANT CREATE ON SCHEMA fixture_extra TO PUBLIC'],
        ['callable security definer', 'CREATE FUNCTION public.fixture_escalate() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$'],
        ['unrelated relation access', 'CREATE TABLE public.fixture_private(id int); GRANT SELECT ON public.fixture_private TO PUBLIC'],
        ['disabled audit trigger', 'ALTER TABLE public.security_audit DISABLE TRIGGER qamqor_audit_immutable'],
    ]) {
        await t.test(`unsafe ${name} fails inside transaction without broad revocations`, async () => {
            await exec(setup);
            await sanitizedFailure(() => provisionRuntimeRole(sql, password), 'Runtime role provisioning failed', password);
            assert.equal(await roleExists(), false);
            assert.equal(calls.rollbacks, 1);
        });
    }

    await t.test('scoped revocation removes existing PUBLIC table and column privileges', async () => {
        await exec('GRANT ALL ON security_audit TO PUBLIC; GRANT UPDATE(action) ON security_audit TO PUBLIC');
        await provisionRuntimeRole(sql, password);
        await asRuntime(async () => { await denied("UPDATE security_audit SET action = 'tampered'"); });
        await verifyRuntimeRole(sql);
    });

    await t.test('preserves unrelated objects, ordinary functions, default ACLs and explicit grants', async () => {
        await exec(`CREATE ROLE fixture_other NOLOGIN;
            CREATE SCHEMA fixture_extra;
            CREATE TABLE fixture_extra.fixture_private(id int);
            CREATE SEQUENCE fixture_extra.fixture_sequence;
            CREATE FUNCTION public.fixture_ordinary() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
            GRANT USAGE, CREATE ON SCHEMA public TO fixture_other;
            GRANT SELECT ON users, security_audit, fixture_extra.fixture_private TO fixture_other;
            GRANT USAGE ON SEQUENCE fixture_extra.fixture_sequence TO fixture_other;
            DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO fixture_other', current_database()); END $$;`);
        const defaults = await query('SELECT * FROM pg_default_acl ORDER BY oid');
        try {
            await provisionRuntimeRole(sql, password);
            const [preserved] = await query(`SELECT
                has_schema_privilege('fixture_other', 'public', 'CREATE') AS schema_create,
                has_database_privilege('fixture_other', current_database(), 'TEMPORARY') AS temporary,
                has_table_privilege('fixture_other', 'users', 'SELECT') AS app_read,
                has_table_privilege('fixture_other', 'security_audit', 'SELECT') AS audit_read,
                has_table_privilege('fixture_other', 'fixture_extra.fixture_private', 'SELECT') AS unrelated_read,
                has_sequence_privilege('fixture_other', 'fixture_extra.fixture_sequence', 'USAGE') AS unrelated_sequence,
                has_function_privilege('qamqor_runtime', 'public.fixture_ordinary()', 'EXECUTE') AS ordinary_function,
                NOT has_table_privilege('qamqor_runtime', 'fixture_extra.fixture_private', 'SELECT') AS no_new_read,
                NOT has_sequence_privilege('qamqor_runtime', 'fixture_extra.fixture_sequence', 'USAGE') AS no_new_sequence`);
            assert.equal(Object.values(preserved).every(value => value === true), true);
            assert.deepEqual(await query('SELECT * FROM pg_default_acl ORDER BY oid'), defaults);
        } finally { await exec('DROP OWNED BY fixture_other; DROP ROLE fixture_other'); }
    });

    for (const [name, drift] of [
        ['privileged flags', 'ALTER ROLE qamqor_runtime CREATEDB'],
        ['ownership', 'ALTER TABLE auth_throttle OWNER TO qamqor_runtime'],
        ['membership despite NOINHERIT', 'GRANT pg_read_all_data TO qamqor_runtime'],
        ['audit mutation', 'GRANT UPDATE ON security_audit TO qamqor_runtime'],
        ['PUBLIC column mutation', 'GRANT UPDATE(action) ON security_audit TO PUBLIC'],
        ['missing CRUD', 'REVOKE DELETE ON auth_throttle FROM qamqor_runtime'],
        ['grant option', 'GRANT SELECT ON users TO qamqor_runtime WITH GRANT OPTION'],
        ['TEMP inherited from PUBLIC', "DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$"],
        ['sequence mutation', 'GRANT UPDATE ON users_id_seq TO qamqor_runtime'],
        ['trigger bypass permission', 'GRANT SET ON PARAMETER session_replication_role TO qamqor_runtime'],
        ['wrong trigger events', `DROP TRIGGER qamqor_audit_immutable ON security_audit;
            CREATE TRIGGER qamqor_audit_immutable BEFORE DELETE ON security_audit
                FOR EACH STATEMENT EXECUTE FUNCTION qamqor_protect_audit()`],
    ]) {
        await t.test(`read-only verification detects ${name}`, async () => {
            await provisionRuntimeRole(sql, password);
            await exec(drift);
            await sanitizedFailure(() => verifyRuntimeRole(sql), 'Runtime role verification failed');
            assert.equal(calls.transactions, 1);
        });
    }

    await t.test('invalid passwords and driver errors never expose secrets or issue partial writes', async () => {
        for (const candidate of [undefined, null, '', 'short', randomBytes(31).toString('base64url'), password + '=', password + "'", password + '\n']) {
            await sanitizedFailure(() => provisionRuntimeRole(sql, candidate), 'Runtime role provisioning failed', password);
        }
        assert.equal(calls.built.length, 0);
        assert.equal(calls.transactions, 0);
        const broken = { query: sql.query, transaction: async () => {
            throw Object.assign(new Error(password), { detail: password, parameters: [password] });
        } };
        await sanitizedFailure(() => provisionRuntimeRole(broken, password), 'Runtime role provisioning failed', password);
        await sanitizedFailure(() => verifyRuntimeRole({ query() { throw new Error(password); } }), 'Runtime role verification failed', password);
        assert.equal(await roleExists(), false);
        await sanitizedFailure(() => verifyRuntimeRole(sql), 'Runtime role verification failed');
    });
});
