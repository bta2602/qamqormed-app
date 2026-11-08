import test from 'node:test';
import assert from 'node:assert/strict';
import { findings, forbiddenPath } from '../scripts/scan-secrets.mjs';

test('secret findings contain locations and rule names, never credential values', () => {
    const secret = 'AI' + 'za' + 'A'.repeat(35);
    const result = findings('first line\nconst key = "' + secret + '";', 'fixture.js');
    assert.deepEqual(result, [{ path: 'fixture.js', rule: 'google-api-key', line: 2 }]);
    assert.equal(JSON.stringify(result).includes(secret), false);
});
test('connection strings and signing keys are detected without disclosing them', () => {
    assert.equal(findings('postgre' + 'sql://user:fixture@localhost/db', 'fixture.txt')[0].rule, 'database-credentials');
    assert.equal(findings('-----BEGIN ' + 'PRIVATE KEY-----', 'fixture.txt')[0].rule, 'private-key');
});
test('runtime environment references and placeholder-free source do not flag', () => {
    assert.deepEqual(findings('const key = process.env.GEMINI_API_KEY;', 'fixture.mjs'), []);
    assert.deepEqual(findings('const key = process.env.GROQ_API_KEY;', 'fixture.mjs'), []);
});
test('Groq keys and assigned credentials are detected without leaking their values', () => {
    const secret = 'gs' + 'k_' + 'X'.repeat(48);
    const result = findings(secret, 'fixture.txt');
    assert.equal(result[0].rule, 'groq-api-key');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(findings('GROQ_API_KEY = "' + 'X'.repeat(30) + '"', 'fixture.txt')[0].rule, 'assigned-secret');
});
test('tracked local secrets and signing files are forbidden even when gitignored', () => {
    for (const path of ['.env', '.env.production', 'config/service-account-prod.json', 'android/release.jks', 'android/local.properties']) assert.equal(forbiddenPath(path), true);
    for (const path of ['.env.example', 'web/app.mjs', 'package-lock.json']) assert.equal(forbiddenPath(path), false);
});
