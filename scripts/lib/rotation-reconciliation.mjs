import { passwordMatches } from '../../netlify/lib/security.mjs';

// An interrupted commit must never silently generate another set of credentials.
export async function reconcileRotation(sql, credentials) {
    try {
        if (!Array.isArray(credentials) || credentials.length === 0 || credentials.length > 1000 ||
            new Set(credentials.map(row => row.id)).size !== credentials.length) throw new Error();
        for (const credential of credentials) {
            if (!Number.isSafeInteger(credential.id) || credential.id < 1) throw new Error();
            const [stored] = await sql.query('SELECT email, role, password FROM users WHERE id = $1', [credential.id]);
            if (!stored || stored.email !== credential.email || stored.role !== credential.role ||
                !await passwordMatches(credential.newPassword, stored.password)) throw new Error();
        }
        return { rotated: credentials.length, resumed: true };
    } catch {
        throw new Error('Saved rotation does not match every target. Manual reconciliation required; no passwords changed.');
    }
}
