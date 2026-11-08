import { randomBytes } from 'node:crypto';
import { passwordHash, validatePassword } from '../netlify/lib/security.mjs';

const MAX_TARGETS = 1000;
const MAX_INTEGER = 2147483647;
const plans = new WeakMap();
const scryptPattern = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
const targetPredicate = `(role IN ('admin', 'doctor') OR (role = 'patient' AND
    (password IS NULL OR length(password) <> 168 OR
        password !~ '^scrypt[$][a-f0-9]{32}[$][a-f0-9]{128}$')))`;

function validId(value) {
    return Number.isInteger(value) && value > 0 && value <= MAX_INTEGER;
}

function validateSnapshots(rows) {
    if (!Array.isArray(rows) || rows.length > MAX_TARGETS) throw new Error();
    const ids = new Set();
    for (const row of rows) {
        if (!row || !validId(row.id) || ids.has(row.id) ||
            typeof row.email !== 'string' || !row.email.trim() || row.email.length > 320 ||
            !['admin', 'doctor', 'patient'].includes(row.role) || typeof row.is_active !== 'boolean' ||
            !validId(row.session_version) || row.session_version === MAX_INTEGER ||
            !(row.password === null || (typeof row.password === 'string' && row.password.length <= 4096)) ||
            (row.role === 'patient' && row.password?.length === 168 && scryptPattern.test(row.password))) {
            throw new Error();
        }
        ids.add(row.id);
    }
}

/**
 * Operator-only, read-only preparation. Supply a Neon-compatible, lazy query client;
 * this module never creates a connection, reads database URLs, logs, or runs a CLI.
 * All staff (including inactive/hashed staff) and only non-scrypt patients qualify.
 * Plans are process-local, frozen, bound to this client, and cannot be rehydrated.
 * More than 1,000 targets, invalid identities, emails over 320 characters, stored
 * passwords over 4,096 characters, or exhausted session versions fail closed.
 */
export async function preparePasswordRotation(sql) {
    try {
        if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') throw new Error();
        const rows = await sql.query(`SELECT id, email, role, password, session_version, is_active
            FROM users WHERE ${targetPredicate} ORDER BY id LIMIT $1`, [MAX_TARGETS + 1]);
        validateSnapshots(rows);
        const originals = [], credentials = [], secrets = new Set();
        // Serial hashing bounds scrypt's memory use even for a large plan.
        for (const row of rows) {
            let newPassword;
            do {
                newPassword = validatePassword('R7!2' + randomBytes(32).toString('base64url'));
            } while (secrets.has(newPassword) || newPassword === row.password);
            secrets.add(newPassword);
            originals.push(Object.freeze({ id: row.id, email: row.email, role: row.role,
                password: row.password, session_version: row.session_version, is_active: row.is_active,
                replacement: await passwordHash(newPassword) }));
            credentials.push(Object.freeze({ id: row.id, email: row.email, role: row.role, newPassword }));
        }
        const plan = Object.freeze({ credentials: Object.freeze(credentials) });
        // Original passwords/hashes must never be serializable with the recovery backup.
        plans.set(plan, { sql, originals: Object.freeze(originals), applying: false });
        return plan;
    } catch {
        throw new Error('Password rotation preparation failed; check schema, target bounds and snapshots.');
    }
}

/**
 * persistRecovery receives ONLY frozen {id,email,role,newPassword} records. It must
 * resolve only after durable, access-controlled storage succeeds, never just enqueue
 * a write. The operator owns storage/encryption and maintenance-mode coordination.
 * No statement is built or executed before it resolves. A rejected callback is
 * retryable; once persistence succeeds the plan is single-use, even on DB failure.
 * Reconcile an uncertain commit before preparing another plan. No automatic retries.
 * Optional actorAdminId must explicitly identify an active admin; omission skips
 * auditing rather than inventing an actor. Apply returns counts, never credentials.
 */
export async function applyPasswordRotation(sql, plan, options = {}) {
    const state = plans.get(plan);
    let persistRecovery, actorAdminId;
    try {
        ({ persistRecovery, actorAdminId } = options);
        if (!state || state.sql !== sql || state.applying || typeof persistRecovery !== 'function' ||
            (actorAdminId !== undefined && !validId(actorAdminId))) throw new Error();
        validateSnapshots(state.originals);
        if (plan.credentials.length !== state.originals.length ||
            new Set(plan.credentials.map(c => c.newPassword)).size !== plan.credentials.length) throw new Error();
        for (const credential of plan.credentials) validatePassword(credential.newPassword);
    } catch {
        throw new Error('Invalid password rotation plan, client or options.');
    }

    state.applying = true;
    try {
        await persistRecovery(plan.credentials);
    } catch {
        state.applying = false;
        throw new Error('Recovery persistence failed; no rotation writes were attempted.');
    }
    plans.delete(plan);

    try {
        const ids = state.originals.map(row => row.id);
        const statements = [
            sql.query("SET LOCAL lock_timeout = '10s'"),
            sql.query("SET LOCAL statement_timeout = '60s'"),
            // Fixed tables only. Freeze the target population and token issuance during maintenance.
            sql.query('LOCK TABLE users, auth_sessions, password_recovery_requests IN SHARE ROW EXCLUSIVE MODE'),
            sql.query(`SELECT CAST(CASE WHEN count(*) = $2 AND
                COALESCE(bool_and(id = ANY($1::integer[])), true) THEN '1'
                ELSE 'stale-rotation-plan' END AS integer) AS checked
                FROM users WHERE ${targetPredicate}`, [ids, ids.length]),
            sql.query(`SELECT CAST(CASE WHEN count(*) = 1 THEN '1' ELSE 'missing-identity-trigger' END AS integer)
                FROM pg_trigger WHERE tgrelid = 'users'::regclass AND tgname = 'qamqor_identity_change'
                AND NOT tgisinternal AND tgenabled IN ('O', 'A')`),
        ];
        if (actorAdminId !== undefined) {
            statements.push(sql.query(`SELECT CAST(CASE WHEN count(*) = 1 THEN '1'
                ELSE 'invalid-audit-actor' END AS integer) FROM users
                WHERE id = $1 AND role = 'admin' AND is_active = true`, [actorAdminId]));
        }
        const updateIndex = statements.length;
        // The count/trigger guard MUST throw inside SQL, before the transaction commits.
        statements.push(sql.query(`WITH originals AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS snapshot(id integer, email text, role text,
                password text, session_version integer, is_active boolean, replacement text)
        ), changed AS (
            UPDATE users AS u SET password = o.replacement FROM originals AS o
            WHERE u.id = o.id AND u.password IS NOT DISTINCT FROM o.password
                AND u.session_version = o.session_version AND u.is_active = o.is_active AND u.role = o.role
                AND u.email IS NOT DISTINCT FROM o.email
            RETURNING u.session_version = o.session_version + 1 AND u.password = o.replacement
                AND u.role = o.role AND u.is_active = o.is_active AS identity_checked
        ) SELECT CAST(CASE WHEN count(*) = $2 AND COALESCE(bool_and(identity_checked IS TRUE), true)
            THEN count(*)::text ELSE 'stale-rotation-or-invalid-trigger' END AS integer) AS rotated
            FROM changed`, [JSON.stringify(state.originals), ids.length]));
        statements.push(sql.query(`WITH revoked AS (DELETE FROM auth_sessions WHERE user_id = ANY($1::integer[])
            RETURNING user_id) SELECT count(*)::integer AS sessions_revoked FROM revoked`, [ids]));
        statements.push(sql.query(`WITH revoked AS (UPDATE password_recovery_requests SET status = 'rejected'
            WHERE user_id = ANY($1::integer[]) AND status IN ('pending', 'approved') RETURNING id)
            SELECT count(*)::integer AS recovery_requests_revoked FROM revoked`, [ids]));
        if (actorAdminId !== undefined) {
            statements.push(sql.query(`WITH audited AS (
                INSERT INTO security_audit(actor_id, action, resource_type, resource_id)
                SELECT $1, 'password_rotated', 'user', id FROM users WHERE id = ANY($2::integer[]) ORDER BY id
                RETURNING id) SELECT count(*)::integer AS audited FROM audited`, [actorAdminId, ids]));
        }
        const result = await sql.transaction(statements, {
            isolationLevel: 'Serializable', readOnly: false, arrayMode: false, fullResults: false,
        });
        return {
            rotated: result[updateIndex][0].rotated,
            sessionsRevoked: result[updateIndex + 1][0].sessions_revoked,
            recoveryRequestsRevoked: result[updateIndex + 2][0].recovery_requests_revoked,
            audited: actorAdminId === undefined ? 0 : result[updateIndex + 3][0].audited,
        };
    } catch {
        // Driver errors can carry SQL parameters, old passwords, and recovery credentials.
        throw new Error('Password rotation transaction failed; reconcile database state before preparing another plan.');
    }
}
