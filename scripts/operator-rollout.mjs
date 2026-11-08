import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { neon } from '@netlify/neon';
import assert from 'node:assert/strict';
import { operatorClient, operatorDatabase, siteId, stagingHost, productionHost } from './lib/operator-client.mjs';
import { openVault, sealVault } from './lib/operator-vault.mjs';
import { dataKeyring, revealRecord } from '../netlify/lib/data-crypto.mjs';
import { runEncryption } from './encrypt-clinical-data.mjs';
import { runSchemaCheck } from './check-schema.mjs';
import { preparePasswordRotation, applyPasswordRotation } from './rotate-legacy-passwords.mjs';
import { passwordMatches } from '../netlify/lib/security.mjs';
import { reconcileRotation } from './lib/rotation-reconciliation.mjs';
import { normalizeDemoDates } from './normalize-demo-dates.mjs';
import login from '../netlify/functions/login.mjs';
import session from '../netlify/functions/session.mjs';
import admin from '../netlify/functions/admin.mjs';
import doctors from '../netlify/functions/get-doctors.mjs';
import aiChat from '../netlify/functions/ai-chat.mjs';
import analyses from '../netlify/functions/get-analyses.mjs';
import appointments from '../netlify/functions/appointments.mjs';
import doctorAppointments from '../netlify/functions/get-doctor-appointments.mjs';

const directory = join(process.env.LOCALAPPDATA ?? '', 'QamqorMed', 'secrets');
const tables = { appointments: ['message','diagnosis','notes','treatment'], analyses: ['type','results'],
    prescriptions: ['medicine','dosage','instructions'], chat_messages: ['text'], users: ['blood_type'] };
const report = value => console.log(JSON.stringify(value));
let phase = 'input';
const backupTables = ['users', 'appointments', 'analyses', 'prescriptions', 'prescription_schedules',
    'auth_sessions', 'auth_throttle', 'chat_messages', 'security_audit', 'password_recovery_requests',
    'qamqormed_schema_migrations'];

function expectedHost(target) {
    assert.ok(['staging','production'].includes(target));
    return target === 'staging' ? stagingHost : productionHost;
}

function authenticationRejected(error) {
    // Neon's HTTP proxy can reject authentication before PostgreSQL supplies a SQLSTATE.
    return error?.code === '28P01' || /password authentication failed for user\b/i.test(String(error?.message ?? ''));
}

function checkedConnection(value, target, role = 'neondb_owner') {
    const url = new URL(value);
    assert.equal(url.hostname, expectedHost(target));
    assert.equal(url.username, role);
    assert.equal(url.pathname, '/neondb');
    assert.equal(url.searchParams.get('sslmode'), 'require');
    assert.ok(['postgres:','postgresql:'].includes(url.protocol) && url.password);
    return {sql:neon(url.toString()),url:url.toString(),host:url.hostname};
}

async function databaseFor(target, secret, runtime = false) {
    const saved = await readEncrypted(`${target}-access.vault.json`,secret);
    if (!saved) {
        assert.equal(runtime,false);
        return operatorDatabase(target);
    }
    return checkedConnection(runtime ? saved.runtimeUrl : saved.ownerUrl,target,runtime ? 'qamqor_runtime' : 'neondb_owner');
}

async function assertMaintenance() {
    for (const path of ['/', '/.netlify/functions/login', '/.netlify/functions/admin']) {
        const response = await fetch('https://qamqor-med.netlify.app'+path, {redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
        assert.equal(response.status,503);
        assert.equal((await response.json()).maintenance,true);
    }
}

async function checkedStage(env, secret) {
    const checked = JSON.parse(await fs.readFile(join(directory,'staging-verification.json'),'utf8'));
    assert.equal(checked.status,'passed');
    assert.equal(checked.host,stagingHost);
    assert.equal(checked.keyId,env.QAMQOR_DATA_KEY_ID);
    assert.equal(checked.keyFingerprint,createHash('sha256').update(secret).digest('hex'));
    return checked;
}

async function secureAccess(target, secret) {
    phase = `${target}_database_access`;
    const {provisionRuntimeRole,verifyRuntimeRole,configureRuntimeRowPolicies} = await import('./lib/runtime-role.mjs');
    const name = `${target}-access.vault.json`;
    let saved = await readEncrypted(name,secret);
    if (!saved) {
        const current = await operatorDatabase(target);
        const owner = new URL(current.url), runtime = new URL(current.url);
        assert.equal(owner.username,'neondb_owner');
        owner.password = randomBytes(32).toString('base64url');
        runtime.username = 'qamqor_runtime';
        runtime.password = randomBytes(32).toString('base64url');
        saved = {host:current.host,oldOwnerUrl:current.url,ownerUrl:owner.toString(),runtimeUrl:runtime.toString()};
        await persistEncrypted(name,saved,secret);
    }
    assert.equal(saved.host,expectedHost(target));
    phase = `${target}_access_operator_auth`;
    let operator = checkedConnection(saved.ownerUrl,target);
    let alreadyRotated = false;
    try { await operator.sql.query('SELECT 1'); alreadyRotated = true; }
    catch (error) {
        if (!authenticationRejected(error)) {
            report({phase,code:['28P01','28000','42501'].includes(error.code)?error.code:'unclassified_transport_error'});
            throw new Error('Cannot reconcile operator credentials');
        }
        operator = checkedConnection(saved.oldOwnerUrl,target);
    }
    const {sql} = operator;
    phase = `${target}_access_provision`;
    const [existing] = await sql.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qamqor_runtime') AS found");
    if (!existing.found) await provisionRuntimeRole(sql,new URL(saved.runtimeUrl).password);
    else await configureRuntimeRowPolicies(sql);
    phase = `${target}_access_privileges`;
    await verifyRuntimeRole(sql);
    const restricted = checkedConnection(saved.runtimeUrl,target,'qamqor_runtime');
    phase = `${target}_access_runtime_auth`;
    const [identity] = await restricted.sql.query('SELECT current_user AS role');
    assert.equal(identity.role,'qamqor_runtime');
    if (!alreadyRotated) {
        phase = `${target}_access_owner_rotation`;
        await sql.transaction([
            sql.query("SET LOCAL password_encryption = 'scram-sha-256'"),
            sql.query("SELECT set_config('qamqor.operator_password', $1, true)",[new URL(saved.ownerUrl).password]),
            sql.query("DO $$ BEGIN EXECUTE format('ALTER ROLE neondb_owner PASSWORD %L', current_setting('qamqor.operator_password')); END $$"),
        ]);
    }
    const fresh = checkedConnection(saved.ownerUrl,target);
    phase = `${target}_access_new_operator_auth`;
    await fresh.sql.query('SELECT 1');
    // Existing sessions retain access after a password rotation; close only this app owner's other sessions.
    await fresh.sql.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = current_user AND pid <> pg_backend_pid()');
    phase = `${target}_access_old_operator_denial`;
    let rejected = false;
    try { await checkedConnection(saved.oldOwnerUrl,target).sql.query('SELECT 1'); }
    catch (error) { if (!authenticationRejected(error)) throw new Error('Old credential denial could not be verified'); rejected = true; }
    assert.equal(rejected,true);
    const result = {check:'database_access',status:'passed',target,runtimeRole:'qamqor_runtime',oldOwnerCredentialRejected:true};
    report(result);
    await fs.writeFile(join(directory,`${target}-access-verification.json`),JSON.stringify(result),{mode:0o600});
}

async function readEncrypted(name, secret) {
    let content;
    try { content = await fs.readFile(join(directory, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return openVault(JSON.parse(content), secret);
}

async function persistEncrypted(name, value, passphrase) {
    const path = join(directory, name);
    const canonical = JSON.parse(JSON.stringify(value));
    const envelope = sealVault(canonical, passphrase);
    const file = await fs.open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
    assert.deepEqual(openVault(JSON.parse(await fs.readFile(path, 'utf8')), passphrase), canonical);
    return path;
}

async function clinicalDigest(sql, env) {
    const hash = createHash('sha256');
    const counts = {};
    for (const [table, fields] of Object.entries(tables)) {
        const rows = await sql.query(`SELECT id, ${fields.join(', ')} FROM ${table} ORDER BY id`);
        counts[table] = rows.length;
        for (const row of rows) hash.update(JSON.stringify(revealRecord(table, row, env)));
    }
    return { signature: hash.digest('hex'), counts };
}

async function call(handler, sql, data = {}, token, method = 'POST') {
    const previousError = console.error;
    console.error = (message,code) => {
        if (message === 'API request failed' && /^[A-Za-z0-9_]{1,40}$/.test(String(code))) report({phase,apiError:code});
    };
    let response;
    try { response = await handler(new Request('https://qamqor-med.netlify.app/.netlify/functions/operator-test', {
        method, headers: { 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    }), { testSql: sql, ip: '192.0.2.80' }); } finally { console.error = previousError; }
    return { status: response.status, body: await response.json() };
}

async function migrate(target, env, secret) {
    if (target === 'production') { await checkedStage(env,secret); await assertMaintenance(); }
    const { sql, url, host } = await databaseFor(target,secret);
    assert.equal(host,expectedHost(target));
    phase = `${target}_backup`;
    const backupName = `${target}-source.vault.json`;
    let source = await readEncrypted(backupName, secret);
    if (!source) {
        const contents = {};
        const snapshots = await sql.transaction(backupTables.map(table =>
            sql.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)),
        { isolationLevel: 'RepeatableRead', readOnly: true });
        backupTables.forEach((table, i) => { contents[table] = snapshots[i].map(row => row.record); });
        source = { host, keyId: env.QAMQOR_DATA_KEY_ID, contents,
            before: await clinicalDigest(sql, {...env, QAMQOR_ALLOW_LEGACY_PLAINTEXT:'true'}) };
        await persistEncrypted(backupName, source, secret);
    }
    assert.equal(source.host, host);
    assert.equal(source.keyId, env.QAMQOR_DATA_KEY_ID);
    const before = source.before;
    const backupPath = join(directory, backupName);
    phase = `${target}_schema`;
    await sql.transaction([sql.query("SET LOCAL lock_timeout = '5s'"),
        sql.query('ALTER TABLE appointments ALTER COLUMN diagnosis TYPE TEXT'),
        sql.query("INSERT INTO qamqormed_schema_migrations(version) VALUES ('20261109_encrypted_field_capacity') ON CONFLICT (version) DO NOTHING")]);
    phase = `${target}_demo_dates`;
    const dates = await normalizeDemoDates(sql, { referenceDate: '2026-11-09', syntheticConfirmed: true,
        backupVerified: true, apply: true });
    report({phase, ...dates});
    phase = `${target}_encryption`;
    await runEncryption(sql, { env, apply:false, output: message => report({phase, message}) });
    await runEncryption(sql, { env, apply:true, output: message => report({phase, message}) });
    assert.deepEqual(await clinicalDigest(sql, env), before);
    await runEncryption(sql, { env, output: message => {
        assert.match(message, /would_encrypt=0$/);
        report({phase:`${target}_strict_read`, message});
    }});
    phase = `${target}_passwords`;
    const credentialsName = `${target}-credentials.vault.json`;
    const saved = await readEncrypted(credentialsName, secret);
    let credentials, rotation;
    const credentialsPath = join(directory, credentialsName);
    if (saved) {
        assert.equal(saved.host, host);
        credentials = saved.credentials;
        rotation = await reconcileRotation(sql, credentials);
    } else {
        const plan = await preparePasswordRotation(sql);
        credentials = plan.credentials;
        rotation = await applyPasswordRotation(sql, plan, { persistRecovery: records =>
            persistEncrypted(credentialsName, {host, credentials: records}, secret) });
    }
    for (const credential of credentials) {
        const [stored] = await sql`SELECT password FROM users WHERE id = ${credential.id}`;
        assert.equal(await passwordMatches(credential.newPassword, stored.password), true);
        const old = source.contents.users.find(row => row.id === credential.id);
        if (old?.password && !old.password.startsWith('scrypt$')) assert.equal(await passwordMatches(old.password, stored.password), false);
    }
    phase = `${target}_gate`;
    assert.equal(await runSchemaCheck({ env: {...env, NETLIFY_DATABASE_URL: url}, connect: () => sql,
        log: message => report({phase, message}), error: () => {} }), 0);
    phase = `${target}_api`;
    Object.assign(process.env, env);
    const runtime = await readEncrypted(`${target}-access.vault.json`,secret);
    const apiSql = runtime ? checkedConnection(runtime.runtimeUrl,target,'qamqor_runtime').sql : sql;
    const results = [];
    for (const role of ['patient','doctor','admin']) {
        phase=`${target}_api_${role}_login`;
        const credential = credentials.find(row => row.role === role);
        assert.ok(credential);
        const loggedIn = await call(login, apiSql, { email: credential.email, password: credential.newPassword });
        report({phase,status:loggedIn.status});
        assert.equal(loggedIn.status, 200);
        const token = loggedIn.body.token;
        assert.equal((await call(session, apiSql, {}, token, 'GET')).status, 200);
        assert.equal((await call(admin, apiSql, {action:'get_all'}, token)).status, role === 'admin' ? 200 : 403);
        assert.equal(loggedIn.body.user.role,role);
        if (role === 'patient') {
            phase=`${target}_api_patient_records`;
            const own = loggedIn.body.user.iin;
            const tests = [await call(analyses,apiSql,{iin:own},token),
                await call(appointments,apiSql,{action:'get',patientIin:own},token)];
            for (const response of tests) { report({phase,status:response.status}); assert.equal(response.status,200); assert.ok(!JSON.stringify(response.body).includes('qmenc1.')); }
            phase=`${target}_api_patient_isolation`;
            const other = source.contents.users.find(row=>row.role==='patient' && row.iin!==own);
            assert.ok(other);
            assert.equal((await call(analyses,apiSql,{iin:other.iin},token)).status,403);
        } else if (role === 'doctor') {
            phase=`${target}_api_doctor_records`;
            const response = await call(doctorAppointments,apiSql,{},token);
            assert.equal(response.status,200);
            assert.ok(!JSON.stringify(response.body).includes('qmenc1.'));
        } else {
            phase=`${target}_api_admin_patient_selection`;
            const patient = source.contents.users.find(row=>row.role==='patient' &&
                source.contents.analyses.some(a=>a.patient_iin===row.iin));
            assert.ok(patient);
            phase=`${target}_api_admin_medical_access`;
            const response = await call(admin,apiSql,{action:'medical_record',targetId:patient.id,
                reason:'security_review',currentPassword:credential.newPassword},token);
            assert.equal(response.status,200);
            assert.ok(response.body.analyses.length>0);
            assert.ok(!JSON.stringify(response.body).includes('qmenc1.'));
        }
        results.push({role, login:'passed', session:'passed', adminIsolation:'passed'});
    }
    phase=`${target}_api_catalogue`;
    const catalogue = await call(doctors, apiSql, {}, undefined, 'GET');
    assert.equal(catalogue.status, 200);
    for (const doctor of catalogue.body.doctors) {
        assert.equal(Object.hasOwn(doctor,'password'), false);
        assert.equal(Object.hasOwn(doctor,'email'), false);
    }
    assert.equal((await call(aiChat, apiSql, {action:'send', receiver:'support', text:'Synthetic connectivity check'})).status,401);
    const final = {check:`${target}_rollout`, status:'passed', host, keyId:env.QAMQOR_DATA_KEY_ID,
        keyFingerprint:createHash('sha256').update(secret).digest('hex'), counts:before.counts, dates, rotation, roles:results,
        backupPath, credentialsPath, clinicalRoundTrip:'passed', realGeminiCalled:false};
    report(final);
    await fs.writeFile(join(directory, `${target}-verification.json`), JSON.stringify(final), {flag:'w',mode:0o600});
}

async function setKeys(env, secret) {
    phase = 'netlify_key_setup';
    await checkedStage(env,secret);
    const { api, site } = await operatorClient();
    const vars = await api.getEnvVars({accountId:site.account_slug,siteId});
    const keys = ['QAMQOR_DATA_KEY_ID','QAMQOR_DATA_KEYS'];
    if (vars.some(v => keys.includes(v.key))) throw new Error('Existing key configuration needs explicit reconciliation');
    await api.createEnvVars({accountId:site.account_slug,siteId,body:keys.map(key => ({key, is_secret:true,
        scopes:['builds','functions','runtime'],values:[{context:'production',value:env[key]}]}))});
    report({check:'netlify_encryption_keys', status:'configured', context:'production', valuesPrinted:false});
}

async function publishDatabaseConfig(secret) {
    phase = 'publish_database_config';
    await assertMaintenance();
    const receipt = JSON.parse(await fs.readFile(join(directory,'production-verification.json'),'utf8'));
    assert.equal(receipt.status,'passed'); assert.equal(receipt.host,productionHost);
    const access = await readEncrypted('production-access.vault.json',secret);
    const direct = checkedConnection(access.runtimeUrl,'production','qamqor_runtime');
    const pooled = new URL(direct.url);
    pooled.hostname = productionHost.replace('.','-pooler.');
    const {api,site} = await operatorClient();
    for (const [key,value] of Object.entries({NETLIFY_DATABASE_URL:pooled.toString(),NETLIFY_DATABASE_URL_UNPOOLED:direct.url})) {
        await api.updateEnvVar({accountId:site.account_slug,siteId,key,body:{key,is_secret:true,
            scopes:['builds','functions','runtime'],values:[{context:'production',value}]}});
    }
    const variables = await api.getEnvVars({accountId:site.account_slug,siteId});
    for (const key of ['NETLIFY_DATABASE_URL','NETLIFY_DATABASE_URL_UNPOOLED']) {
        const item = variables.find(v=>v.key===key);
        assert.equal(item.is_secret,true);
        assert.deepEqual(item.values.map(v=>v.context),['production']);
    }
    report({check:'database_environment',status:'passed',secret:true,context:'production',role:'qamqor_runtime'});
}

try {
    if (process.argv.length !== 3 || !['stage','stage-access','set-keys','production','production-check','publish-db-config','build','verify-live'].includes(process.argv[2])) throw new Error();
    const chunks=[]; let size=0;
    for await (const chunk of process.stdin) { size+=chunk.length; if(size>16384) throw new Error(); chunks.push(chunk); }
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const {active,keys}=dataKeyring(payload.env);
    const env={QAMQOR_DATA_KEY_ID:active,QAMQOR_DATA_KEYS:payload.env.QAMQOR_DATA_KEYS};
    const secret=keys.get(active).toString('base64');
    if (process.argv[2]==='stage') await migrate('staging',env,secret);
    else if (process.argv[2]==='stage-access') { await secureAccess('staging',secret); await migrate('staging',env,secret); }
    else if(process.argv[2]==='set-keys') await setKeys(env, secret);
    else if(process.argv[2]==='production') {
        await checkedStage(env,secret); await assertMaintenance();
        const accessCheck = JSON.parse(await fs.readFile(join(directory,'staging-access-verification.json'),'utf8'));
        assert.equal(accessCheck.status,'passed');
        await secureAccess('production',secret);
        await migrate('production',env,secret);
    }
    else if(process.argv[2]==='publish-db-config') await publishDatabaseConfig(secret);
    else if(process.argv[2]==='verify-live') {
        phase='live_verification';
        const {verifyLive}=await import('./verify-live.mjs');
        const saved=await readEncrypted('production-credentials.vault.json',secret);
        assert.equal(saved.host,productionHost);
        await verifyLive(saved.credentials);
    }
    else if(process.argv[2]==='build') {
        phase='gated_build';
        const {url}=await databaseFor('production',secret,true);
        const npm=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
        const output=execFileSync(process.execPath,[npm,'run','build:netlify'],{cwd:join(import.meta.dirname,'..'),
            env:{...process.env,...env,NETLIFY_DATABASE_URL:url},encoding:'utf8',timeout:180000,windowsHide:true});
        console.log(output);
    }
    else {
        const {sql,url}=await databaseFor('production',secret);
        process.exitCode=await runSchemaCheck({env:{...env,NETLIFY_DATABASE_URL:url},connect:()=>sql});
    }
} catch {
    report({check:'operator_rollout',status:'failed',phase,reason:'Operation stopped; details redacted. Preserve all backup and credential files.'});
    process.exitCode=1;
}
