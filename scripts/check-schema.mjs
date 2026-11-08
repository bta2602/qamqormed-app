import { pathToFileURL } from 'node:url';
import { dataKeyring } from '../netlify/lib/data-crypto.mjs';

export const requiredVersion = '20261109_encrypted_field_capacity';

export async function checkSchema(sql) {
    // A read-only transaction checks the migration receipt and critical API columns.
    // LIMIT 0 validates the schema without returning user or clinical records.
    const [versions, indexes, triggers, roles, capacity] = await sql.transaction([
        sql`SELECT version FROM qamqormed_schema_migrations WHERE version = ${requiredVersion}`,
        sql`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema()
            AND indexname IN ('users_public_id', 'users_email_case_insensitive', 'appointments_unique_upcoming_slot', 'appointments_unique_patient_slot')`,
        sql`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
            AND ((tgname = 'qamqor_identity_change' AND tgrelid = 'users'::regclass)
                OR (tgname = 'qamqor_audit_immutable' AND tgrelid = 'security_audit'::regclass)
                OR (tgname = 'qamqor_schedule_active' AND tgrelid = 'prescription_schedules'::regclass)
                OR (tgname = 'qamqor_prescription_revoked' AND tgrelid = 'prescriptions'::regclass)
                OR (tgname = 'qamqor_completed_record' AND tgrelid = 'appointments'::regclass))`,
        sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'users_role_allowlist' AND conrelid = 'users'::regclass AND convalidated`,
        sql`SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = current_schema() AND data_type = 'text'
            AND (table_name, column_name) IN (
                ('appointments', 'message'), ('appointments', 'diagnosis'), ('appointments', 'notes'), ('appointments', 'treatment'),
                ('analyses', 'type'), ('prescriptions', 'medicine'), ('prescriptions', 'dosage'), ('prescriptions', 'instructions'),
                ('chat_messages', 'text'), ('users', 'blood_type'))`,
        sql`SELECT session_version, public_id, password, blood_type, spec, city, exp, bio, img, rating, is_active FROM users LIMIT 0`,
        sql`SELECT id, actor_id, action, resource_type, resource_id, created_at FROM security_audit LIMIT 0`,
        sql`SELECT doctor_id FROM analyses LIMIT 0`,
        sql`SELECT id, token_hash, user_id, session_version, status, expires_at, reviewed_by, consumed_at FROM password_recovery_requests LIMIT 0`,
        sql`SELECT token_hash, user_id, session_version, expires_at FROM auth_sessions LIMIT 0`,
        sql`SELECT bucket, hits, window_start FROM auth_throttle LIMIT 0`,
        sql`SELECT doctor_iin, patient_iin, date, time, type, status, message, diagnosis, notes, treatment FROM appointments LIMIT 0`,
        sql`SELECT id, doctor_id, patient_id, medicine, dosage, instructions, interval_hours,
            duration_days, status, created_at, revoked_at FROM prescriptions LIMIT 0`,
        sql`SELECT prescription_id, start_at, timezone, reminders_enabled, updated_at FROM prescription_schedules LIMIT 0`,
        sql`SELECT sender, receiver, text, created_at FROM chat_messages LIMIT 0`,
    ], { readOnly: true, isolationLevel: 'RepeatableRead', fetchOptions: { signal: AbortSignal.timeout(15_000) } });
    if (versions.length !== 1 || versions[0].version !== requiredVersion || indexes[0]?.n !== 4 || triggers[0]?.n !== 5 || roles[0]?.n !== 1 || capacity[0]?.n !== 10) {
        throw new Error('Required migration or indexes are missing');
    }
}

export async function runSchemaCheck({ env = process.env, connect, log = console.log, error = console.error } = {}) {
    if (!env.NETLIFY_DATABASE_URL) {
        error('Deployment blocked: NETLIFY_DATABASE_URL is unavailable. See MIGRATION-RU.md; do not put credentials in Git.');
        return 1;
    }
    try {
        dataKeyring(env);
        if (env.QAMQOR_ALLOW_LEGACY_PLAINTEXT === 'true') throw new Error('Legacy migration mode must not be published');
        const createClient = connect ?? (await import('@netlify/neon')).neon;
        const sql = createClient(env.NETLIFY_DATABASE_URL);
        await checkSchema(sql);
        const [plain] = await sql`SELECT (
            EXISTS(SELECT 1 FROM appointments WHERE (message IS NOT NULL AND message NOT LIKE 'qmenc1.%')
                OR (diagnosis IS NOT NULL AND diagnosis NOT LIKE 'qmenc1.%') OR (notes IS NOT NULL AND notes NOT LIKE 'qmenc1.%')
                OR (treatment IS NOT NULL AND treatment NOT LIKE 'qmenc1.%'))
            OR EXISTS(SELECT 1 FROM analyses WHERE (type IS NOT NULL AND type NOT LIKE 'qmenc1.%')
                OR (results IS NOT NULL AND COALESCE(results->>'_encrypted', '') NOT LIKE 'qmenc1.%'))
            OR EXISTS(SELECT 1 FROM prescriptions WHERE medicine NOT LIKE 'qmenc1.%' OR dosage NOT LIKE 'qmenc1.%' OR instructions NOT LIKE 'qmenc1.%')
            OR EXISTS(SELECT 1 FROM chat_messages WHERE text NOT LIKE 'qmenc1.%')
            OR EXISTS(SELECT 1 FROM users WHERE blood_type IS NOT NULL AND blood_type NOT LIKE 'qmenc1.%')
        ) AS found`;
        if (plain?.found !== false) throw new Error('Clinical backfill is incomplete');
        const [credentials] = await sql`SELECT EXISTS(
            SELECT 1 FROM users WHERE is_active = true AND
                (password IS NULL OR password !~ ${'^scrypt[$][a-f0-9]{32}[$][a-f0-9]{128}$'})
        ) AS unsafe`;
        if (credentials?.unsafe !== false) throw new Error('Active credentials require remediation');
        log(`Database schema ready: ${requiredVersion}. No data was changed.`);
        return 0;
    } catch {
        // Driver errors may include connection details. Never print them in public build logs.
        error('Deployment blocked: verify migration, encryption keys, encrypted-data backfill, active password hashes and database connectivity. Follow DATA-PROTECTION-RU.md. No migration was run by this build.');
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await runSchemaCheck();
}
