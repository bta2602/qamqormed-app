import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeDemoDate, normalizeDemoDates } from '../scripts/normalize-demo-dates.mjs';
import { reconcileRotation } from '../scripts/lib/rotation-reconciliation.mjs';
import { passwordHash } from '../netlify/lib/security.mjs';

test('demo date conversion preserves dates and pins relative dates to an explicit anchor', () => {
    assert.equal(normalizeDemoDate('23.09.2026', '2026-11-09'), '2026-09-23');
    assert.equal(normalizeDemoDate('2026-09-23', '2026-11-09'), '2026-09-23');
    assert.equal(normalizeDemoDate('\u0417\u0430\u0432\u0442\u0440\u0430', '2026-11-09'), '2026-11-10');
    assert.equal(normalizeDemoDate('\u0437\u0430\u0432\u0442\u0440\u0430', '2026-12-31'), '2027-01-01');
    for (const input of ['31.02.2026', '2026-02-31', '01/02/26', null, 'next week']) {
        assert.throws(() => normalizeDemoDate(input, '2026-11-09'));
    }
});

async function fixture(t) {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec(`CREATE TABLE appointments(id SERIAL PRIMARY KEY, date TEXT, diagnosis TEXT);
        CREATE TABLE analyses(id SERIAL PRIMARY KEY, date TEXT);
        INSERT INTO appointments(date, diagnosis) VALUES ('2026-11-01', 'synthetic');
        INSERT INTO analyses(date) VALUES ('01.11.2026');
        CREATE FUNCTION keep_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable'; END $$;
        CREATE TRIGGER qamqor_completed_record BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION keep_record();`);
    const sql = { query: (text, params = []) => ({text, params,
        then: (resolve, reject) => db.query(text, params).then(r => r.rows).then(resolve, reject)}),
    transaction: async statements => {
        await db.exec('BEGIN');
        try {
            for (const item of statements) await db.query(item.text, item.params);
            await db.exec('COMMIT');
        } catch (error) { await db.exec('ROLLBACK'); throw error; }
    }};
    return {db, sql};
}

test('normalization requires synthetic-data consent and a backup before writing', async () => {
    const sql = {query: () => assert.fail('must not query')};
    await assert.rejects(normalizeDemoDates(sql, {referenceDate:'2026-11-09'}));
    await assert.rejects(normalizeDemoDates(sql, {referenceDate:'2026-11-09',syntheticConfirmed:true,apply:true}));
});

test('normalization is idempotent, preserves other fields and restores the clinical trigger', async t => {
    const {db, sql} = await fixture(t);
    await db.query('INSERT INTO appointments(date) VALUES ($1)', ['\u0437\u0430\u0432\u0442\u0440\u0430']);
    const options = {referenceDate:'2026-11-09',syntheticConfirmed:true,backupVerified:true,apply:true};
    const dry = await normalizeDemoDates(sql, {...options,apply:false});
    assert.deepEqual(dry.changes, {appointments:1,analyses:1});
    await normalizeDemoDates(sql, options);
    assert.deepEqual((await db.query('SELECT date FROM appointments ORDER BY id')).rows.map(r=>r.date), ['2026-11-01','2026-11-10']);
    assert.equal((await db.query('SELECT diagnosis FROM appointments WHERE id=1')).rows[0].diagnosis,'synthetic');
    assert.deepEqual((await normalizeDemoDates(sql,options)).changes,{appointments:0,analyses:0});
    await assert.rejects(db.exec("UPDATE appointments SET diagnosis='bad' WHERE id=1"), /Immutable/);
});

test('invalid dates cause no partial updates', async t => {
    const {db,sql}=await fixture(t);
    await db.exec("INSERT INTO analyses(date) VALUES ('31.02.2026')");
    await assert.rejects(normalizeDemoDates(sql,{referenceDate:'2026-11-09',syntheticConfirmed:true,backupVerified:true,apply:true}));
    assert.equal((await db.query('SELECT date FROM analyses WHERE id=1')).rows[0].date,'01.11.2026');
});

test('a stale date rolls back all updates and restores the history trigger', async t => {
    const {db,sql}=await fixture(t);
    await db.query('INSERT INTO appointments(date) VALUES ($1)', ['\u0437\u0430\u0432\u0442\u0440\u0430']);
    const transaction = sql.transaction;
    sql.transaction = async statements => {
        await db.exec("UPDATE analyses SET date='02.11.2026' WHERE id=1");
        return transaction(statements);
    };
    await assert.rejects(normalizeDemoDates(sql,{referenceDate:'2026-11-09',syntheticConfirmed:true,backupVerified:true,apply:true}), /stale-demo-date/);
    assert.equal((await db.query('SELECT date FROM appointments WHERE id=2')).rows[0].date,'\u0437\u0430\u0432\u0442\u0440\u0430');
    await assert.rejects(db.exec("UPDATE appointments SET diagnosis='bad' WHERE id=1"), /Immutable/);
});

test('resuming rotation verifies every saved credential without any database writes', async () => {
    const credentials = [{id:1,email:'test@example.invalid',role:'admin',newPassword:'SyntheticAdmin42!'}];
    const stored = {email:credentials[0].email,role:'admin',password:await passwordHash(credentials[0].newPassword)};
    const sql={query:async(text,params)=>{assert.match(text,/^SELECT /);assert.deepEqual(params,[1]);return [stored];}};
    assert.deepEqual(await reconcileRotation(sql,credentials),{rotated:1,resumed:true});
    await assert.rejects(reconcileRotation(sql,[{...credentials[0],newPassword:'Wrong42!'}]), /Manual reconciliation/);
    await assert.rejects(reconcileRotation(sql,[{...credentials[0],role:'patient'}]), /Manual reconciliation/);
    await assert.rejects(reconcileRotation(sql,[]), /Manual reconciliation/);
});

test('PowerShell operator uses raw UTF-8 stdin compatible with Windows PowerShell 5.1', async () => {
    const source=await readFile(new URL('../scripts/Invoke-Operator.ps1',import.meta.url),'utf8');
    assert.doesNotMatch(source,/StandardInputEncoding/);
    assert.match(source,/StandardInput\.BaseStream\.Write/);
    assert.match(source,/ProtectedData\]::Unprotect/);
    assert.doesNotMatch(source,/Write-Output \$plain/);
});
