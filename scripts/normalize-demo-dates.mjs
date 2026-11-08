const allowedTables = ['appointments', 'analyses'];

function checkedIso(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Unsupported date format');
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
    return value;
}

export function normalizeDemoDate(value, referenceDate) {
    checkedIso(referenceDate);
    if (typeof value !== 'string') throw new Error('Unsupported date format');
    const date = value.trim();
    const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
    if (dotted) return checkedIso(`${dotted[3]}-${dotted[2]}-${dotted[1]}`);
    if (date.toLowerCase() === '\u0437\u0430\u0432\u0442\u0440\u0430') {
        return new Date(+new Date(referenceDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    }
    return checkedIso(date);
}

export async function normalizeDemoDates(sql, {
    referenceDate, syntheticConfirmed = false, backupVerified = false, apply = false,
} = {}) {
    if (!syntheticConfirmed || (apply && !backupVerified)) throw new Error('Demo confirmation and verified backup required');
    checkedIso(referenceDate);
    const changes = [];
    const counts = {};
    for (const table of allowedTables) {
        const rows = await sql.query(`SELECT id, date FROM ${table} ORDER BY id`);
        counts[table] = 0;
        for (const row of rows) {
            if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('Invalid identity');
            const next = normalizeDemoDate(row.date, referenceDate);
            if (next !== row.date) { changes.push({table, id: row.id, previous: row.date, next}); counts[table]++; }
        }
    }
    if (apply && changes.length) {
        const appointments = counts.appointments > 0;
        const statements = [sql.query("SET LOCAL lock_timeout = '5s'"),
            sql.query("SET LOCAL statement_timeout = '30s'"),
            sql.query('LOCK TABLE appointments, analyses IN ACCESS EXCLUSIVE MODE')];
        if (appointments) {
            statements.push(sql.query(`SELECT CAST(CASE WHEN count(*) = 1 THEN '1' ELSE 'missing-trigger' END AS integer)
                FROM pg_trigger WHERE tgrelid = 'appointments'::regclass AND tgname = 'qamqor_completed_record' AND tgenabled = 'O'`));
            statements.push(sql.query('ALTER TABLE appointments DISABLE TRIGGER qamqor_completed_record'));
        }
        for (const change of changes) {
            statements.push(sql.query(`WITH changed AS (UPDATE ${change.table} SET date = $1 WHERE id = $2 AND date = $3 RETURNING id)
                SELECT CAST(CASE WHEN count(*) = 1 THEN '1' ELSE 'stale-demo-date' END AS integer) FROM changed`,
            [change.next, change.id, change.previous]));
        }
        if (appointments) statements.push(sql.query('ALTER TABLE appointments ENABLE TRIGGER qamqor_completed_record'));
        await sql.transaction(statements, {isolationLevel: 'Serializable'});
    }
    return {referenceDate, applied: apply, changes: counts};
}
