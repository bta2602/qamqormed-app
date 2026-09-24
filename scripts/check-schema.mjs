import { pathToFileURL } from 'node:url';

export const requiredVersion = '20260924_sessions_prescriptions';

export async function checkSchema(sql) {
    // A read-only transaction checks the migration receipt and critical API columns.
    // LIMIT 0 validates the schema without returning user or clinical records.
    const [versions, indexes] = await sql.transaction([
        sql`SELECT version FROM qamqormed_schema_migrations WHERE version = ${requiredVersion}`,
        sql`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema()
            AND indexname IN ('users_public_id', 'users_email_case_insensitive', 'appointments_unique_upcoming_slot')`,
        sql`SELECT session_version, public_id, password, blood_type, spec, city, exp, bio, img, rating FROM users LIMIT 0`,
        sql`SELECT token_hash, user_id, session_version, expires_at FROM auth_sessions LIMIT 0`,
        sql`SELECT bucket, hits, window_start FROM auth_throttle LIMIT 0`,
        sql`SELECT doctor_iin, patient_iin, date, time, status, diagnosis, notes, treatment FROM appointments LIMIT 0`,
        sql`SELECT id, doctor_id, patient_id, medicine, dosage, instructions, interval_hours,
            duration_days, status, created_at, revoked_at FROM prescriptions LIMIT 0`,
        sql`SELECT prescription_id, start_at, timezone, reminders_enabled, updated_at FROM prescription_schedules LIMIT 0`,
        sql`SELECT sender, receiver, text, created_at FROM chat_messages LIMIT 0`,
    ], { readOnly: true, isolationLevel: 'RepeatableRead', fetchOptions: { signal: AbortSignal.timeout(15_000) } });
    if (versions.length !== 1 || versions[0].version !== requiredVersion || indexes[0]?.n !== 3) {
        throw new Error('Required migration or indexes are missing');
    }
}

export async function runSchemaCheck({ env = process.env, connect, log = console.log, error = console.error } = {}) {
    if (!env.NETLIFY_DATABASE_URL) {
        error('Deployment blocked: NETLIFY_DATABASE_URL is unavailable. See MIGRATION-RU.md; do not put credentials in Git.');
        return 1;
    }
    try {
        const createClient = connect ?? (await import('@netlify/neon')).neon;
        await checkSchema(createClient(env.NETLIFY_DATABASE_URL));
        log(`Database schema ready: ${requiredVersion}. No data was changed.`);
        return 0;
    } catch {
        // Driver errors may include connection details. Never print them in public build logs.
        error('Deployment blocked: database migration is missing, incompatible, or unreachable. Follow MIGRATION-RU.md, then retry the Netlify deploy. No migration was run by this build.');
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await runSchemaCheck();
}
