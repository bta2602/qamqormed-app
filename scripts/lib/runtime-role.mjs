const ROLE = 'qamqor_runtime';
const CRUD = ['users', 'appointments', 'analyses', 'prescriptions', 'prescription_schedules',
    'chat_messages', 'auth_sessions', 'auth_throttle', 'password_recovery_requests'];
const TABLES = [...CRUD, 'security_audit', 'qamqormed_schema_migrations'];
const FUNCTIONS = ['qamqor_revoke_changed_identity', 'qamqor_protect_audit', 'qamqor_check_schedule',
    'qamqor_disable_revoked_schedule', 'qamqor_preserve_completed_appointment'];
const tableList = TABLES.map(name => `public.${name}`).join(', ');
const names = TABLES.map(name => `'${name}'`).join(', ');
const allowedTables = TABLES.map(name => `('${name}', ARRAY[${(CRUD.includes(name)
    ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : name === 'security_audit'
        ? ['SELECT', 'INSERT'] : ['SELECT']).map(privilege => `'${privilege}'`).join(', ')}]::text[])`).join(',\n');
const appSequences = `SELECT DISTINCT s.oid, s.relname, n.nspname
    FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE s.relkind = 'S' AND tn.nspname = 'public' AND t.relname IN (${names})`;

function rowPolicies(sql) {
    return TABLES.flatMap(table => [
        sql.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`),
        sql.query(`DO $$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.${table}'::regclass AND polname='qamqor_server_access') THEN
                CREATE POLICY qamqor_server_access ON public.${table} FOR ALL TO ${ROLE} USING (true) WITH CHECK (true);
            END IF;
        END $$`),
    ]);
}

// Check effective privileges, including PUBLIC and column ACLs, not just explicit role grants.
const verification = `WITH runtime AS (SELECT * FROM pg_roles WHERE rolname = '${ROLE}'),
    allowed(name, privileges) AS (VALUES ${allowedTables}),
    app_tables AS (SELECT c.oid, c.relname, a.privileges FROM allowed a
        JOIN pg_namespace n ON n.nspname = 'public'
        JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = a.name AND c.relkind IN ('r', 'p')),
    app_sequences AS (${appSequences})
SELECT
    EXISTS (SELECT 1 FROM runtime WHERE rolcanlogin AND NOT rolinherit AND NOT rolsuper
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) AS role_attributes,
    NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN runtime r ON m.member = r.oid) AS no_memberships,
    NOT EXISTS (SELECT 1 FROM pg_shdepend d JOIN runtime r ON d.refobjid = r.oid
        WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o') AS not_owner,
    EXISTS (SELECT 1 FROM runtime r WHERE has_database_privilege(r.oid, current_database(), 'CONNECT')
        AND NOT has_database_privilege(r.oid, current_database(), 'CREATE')
        AND NOT has_database_privilege(r.oid, current_database(), 'TEMPORARY')
        AND NOT has_database_privilege(r.oid, current_database(), 'CONNECT WITH GRANT OPTION')) AS database_permissions,
    EXISTS (SELECT 1 FROM runtime r WHERE has_schema_privilege(r.oid, 'public', 'USAGE')
        AND NOT has_schema_privilege(r.oid, 'public', 'USAGE WITH GRANT OPTION'))
        AND NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN runtime r
            WHERE has_schema_privilege(r.oid, n.oid, 'CREATE')) AS schema_permissions,
    (SELECT count(*) = ${TABLES.length} FROM app_tables)
        AND NOT EXISTS (SELECT 1 FROM app_tables t CROSS JOIN runtime r
            CROSS JOIN LATERAL unnest(t.privileges) p(privilege)
            WHERE NOT has_table_privilege(r.oid, t.oid, p.privilege)) AS required_table_permissions,
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN runtime r CROSS JOIN LATERAL aclexplode(c.relacl) a
        LEFT JOIN app_tables t ON t.oid = c.oid LEFT JOIN app_sequences s ON s.oid = c.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        AND a.grantee IN (0, r.oid) AND (a.is_grantable OR NOT CASE
            WHEN t.oid IS NOT NULL THEN a.privilege_type = ANY(t.privileges)
            WHEN s.oid IS NOT NULL THEN a.privilege_type IN ('USAGE', 'SELECT')
            ELSE false END)) AS no_extra_relation_permissions,
    NOT EXISTS (SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid = col.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN runtime r
        CROSS JOIN LATERAL aclexplode(col.attacl) a LEFT JOIN app_tables t ON t.oid = c.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        AND a.grantee IN (0, r.oid) AND (a.is_grantable OR t.oid IS NULL
            OR NOT a.privilege_type = ANY(t.privileges))) AS no_extra_column_permissions,
    NOT EXISTS (SELECT 1 FROM app_sequences s CROSS JOIN runtime r
        WHERE NOT has_sequence_privilege(r.oid, s.oid, 'USAGE')
            OR NOT has_sequence_privilege(r.oid, s.oid, 'SELECT')
            OR has_sequence_privilege(r.oid, s.oid, 'UPDATE')) AS sequence_permissions,
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN runtime r
        WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND has_schema_privilege(r.oid, n.oid, 'USAGE')
            AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS no_security_definer_access,
    NOT EXISTS (SELECT 1 FROM runtime r WHERE has_parameter_privilege(r.oid, 'session_replication_role', 'SET'))
        AS cannot_bypass_triggers,
    (SELECT count(*) = 5 FROM (VALUES
        ('users', 'qamqor_identity_change', 'qamqor_revoke_changed_identity', 19),
        ('security_audit', 'qamqor_audit_immutable', 'qamqor_protect_audit', 58),
        ('prescription_schedules', 'qamqor_schedule_active', 'qamqor_check_schedule', 23),
        ('prescriptions', 'qamqor_prescription_revoked', 'qamqor_disable_revoked_schedule', 17),
        ('appointments', 'qamqor_completed_record', 'qamqor_preserve_completed_appointment', 19)
    ) expected(table_name, trigger_name, function_name, trigger_type)
    JOIN app_tables c ON c.relname = expected.table_name
    JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = expected.trigger_name
    JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND n.nspname = 'public'
        AND t.tgtype = expected.trigger_type AND p.proname = expected.function_name
        AND NOT p.prosecdef) AS security_triggers,
    (SELECT count(*) = ${TABLES.length} FROM app_tables t JOIN pg_class c ON c.oid=t.oid
        JOIN pg_policy p ON p.polrelid=t.oid CROSS JOIN runtime r
        WHERE c.relrowsecurity AND p.polname='qamqor_server_access' AND p.polroles=ARRAY[r.oid]
            AND p.polcmd='*' AND p.polpermissive
            AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true') AS server_row_policies`;

function metadata(rows) {
    const checks = rows?.[0];
    if (!checks || Object.keys(checks).length !== 13 || Object.values(checks).some(value => value !== true)) {
        throw new Error();
    }
    return { role: ROLE, verified: true, checks: { ...checks } };
}

/**
 * Read-only verification through an operator client: query(text, params) resolves
 * to row objects (Neon's default, not fullResults/arrayMode). Returns only
 * {role, verified: true, checks}; throws a sanitized error on drift or query failure.
 * This verifies the current database's ACLs, not authentication or other databases.
 */
export async function verifyRuntimeRole(sql) {
    try {
        return metadata(await sql.query(verification));
    } catch {
        throw new Error('Runtime role verification failed; operator review required.');
    }
}

// This is a trusted server role, not a browser/user role. Per-patient authorization
// remains in the API; RLS gives this role access without granting PUBLIC or BYPASSRLS.
export async function configureRuntimeRowPolicies(sql) {
    try {
        const result = await sql.transaction([
            sql.query("SET LOCAL lock_timeout = '10s'"),
            ...rowPolicies(sql),
            sql.query(`SELECT CAST(CASE WHEN NOT EXISTS
                (SELECT 1 FROM jsonb_each(to_jsonb(checked)) p WHERE p.value IS DISTINCT FROM 'true'::jsonb)
                THEN '1' ELSE 'unsafe-runtime-role' END AS integer) FROM (${verification}) checked`),
            sql.query(verification),
        ], { isolationLevel:'Serializable',readOnly:false,arrayMode:false,fullResults:false });
        return metadata(result.at(-1));
    } catch {
        throw new Error('Runtime row policies could not be configured; transaction rolled back.');
    }
}

/**
 * Operator-only. sql must provide Neon-compatible LAZY query(text, params) and
 * atomic transaction(queries, options). password must be canonical base64url of
 * >=32 cryptographically random bytes, generated and durably stored by the caller.
 * Randomness cannot be inferred from a string. No connections, persistence or logs.
 * Refuses an existing role, including after an uncertain commit: verify/connect
 * separately before retrying. Success returns {role, verified: true, checks} only.
 *
 * PUBLIC changes are restricted to this database's TEMP, public schema CREATE,
 * the eleven app tables, their owned sequences, and the five security functions.
 * Explicit grants to other roles are preserved. Unknown unsafe PUBLIC privileges
 * fail closed, without changing unrelated objects or global default privileges.
 * Use during maintenance; operator must preserve any other users' required TEMP
 * or public CREATE via explicit grants. Server/driver parameter logging must be
 * disabled by the operator; this helper cannot control infrastructure logging.
 */
export async function provisionRuntimeRole(sql, password) {
    try {
        if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function'
            || typeof password !== 'string' || !/^[A-Za-z0-9_-]+$/.test(password)
            || Buffer.from(password, 'base64url').length < 32
            || Buffer.from(password, 'base64url').toString('base64url') !== password) throw new Error();
        const statements = [
            sql.query("SET LOCAL search_path = pg_catalog, public"),
            sql.query("SET LOCAL lock_timeout = '10s'"),
            sql.query("SET LOCAL statement_timeout = '60s'"),
            sql.query("SET LOCAL password_encryption = 'scram-sha-256'"),
            sql.query(`DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
                    RAISE EXCEPTION 'Runtime role already exists';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolcreaterole)) THEN
                    RAISE EXCEPTION 'Operator role required';
                END IF;
            END $$`),
            // The password is a bind value, never part of client-side SQL or results.
            sql.query("SELECT set_config('qamqor.runtime_password', $1, true) IS NOT NULL AS configured", [password]),
            sql.query(`DO $$ BEGIN
                EXECUTE format('CREATE ROLE ${ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
                    current_setting('qamqor.runtime_password'));
                PERFORM set_config('qamqor.runtime_password', '', true);
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION 'Runtime role creation failed';
            END $$`),
            sql.query(`DO $$ BEGIN
                EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
                EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database());
            END $$`),
            sql.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'),
            sql.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`),
            sql.query(`REVOKE ALL PRIVILEGES ON TABLE ${tableList} FROM PUBLIC`),
            sql.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${CRUD.map(name => `public.${name}`).join(', ')} TO ${ROLE}`),
            sql.query(`GRANT SELECT, INSERT ON TABLE public.security_audit TO ${ROLE}`),
            sql.query(`GRANT SELECT ON TABLE public.qamqormed_schema_migrations TO ${ROLE}`),
            sql.query(`DO $$ DECLARE sequence_record record; BEGIN
                FOR sequence_record IN ${appSequences} LOOP
                    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC', sequence_record.nspname, sequence_record.relname);
                    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO ${ROLE}', sequence_record.nspname, sequence_record.relname);
                END LOOP;
            END $$`),
            ...FUNCTIONS.flatMap(name => [
                sql.query(`REVOKE ALL PRIVILEGES ON FUNCTION public.${name}() FROM PUBLIC`),
                sql.query(`GRANT EXECUTE ON FUNCTION public.${name}() TO ${ROLE}`),
            ]),
            ...rowPolicies(sql),
            // A SQL-side assertion must abort BEFORE commit, not merely report unsafe ACLs afterwards.
            sql.query(`SELECT CAST(CASE WHEN NOT EXISTS
                (SELECT 1 FROM jsonb_each(to_jsonb(checked)) p WHERE p.value IS DISTINCT FROM 'true'::jsonb)
                THEN '1' ELSE 'unsafe-runtime-role' END AS integer) AS verified FROM (${verification}) checked`),
            sql.query(verification),
        ];
        const results = await sql.transaction(statements, {
            isolationLevel: 'Serializable', readOnly: false, arrayMode: false, fullResults: false,
        });
        return metadata(results.at(-1));
    } catch {
        // Driver errors can contain password parameters or the expanded CREATE ROLE.
        throw new Error('Runtime role provisioning failed; reconcile role state before retrying.');
    }
}
