import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGeminiCheck } from '../scripts/check-gemini.mjs';
import { DEFAULT_GEMINI_MODEL } from '../netlify/lib/gemini.mjs';

test('live check stops before network access when key is absent or malformed', async () => {
    for (const key of [undefined, '', ' ', 'not a key']) {
        const output = [];
        assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: key }, reply: () => assert.fail('must not transmit'), log: value => output.push(value) }), 2);
        assert.equal(JSON.parse(output[0]).status, 'blocked');
    }
});

test('live check uses one fixed synthetic message with no history and emits only safe metadata', async () => {
    const output = [];
    let calls = 0;
    const secret = 'synthetic-credential';
    assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: secret }, reply: async (message, history) => {
        calls++;
        assert.match(message, /technical connectivity test/);
        assert.doesNotMatch(message, new RegExp(secret));
        assert.deepEqual(history, []);
        return 'QAMQOR_GEMINI_OK';
    }, log: value => output.push(value) }), 0);
    assert.equal(calls, 1);
    const result = JSON.parse(output[0]);
    assert.equal(result.status, 'passed');
    assert.equal(result.model, DEFAULT_GEMINI_MODEL);
    assert.equal(typeof result.elapsedMs, 'number');
    assert.doesNotMatch(output.join(), /synthetic-credential|QAMQOR_GEMINI_OK/);
});

test('check failures never print credentials, upstream errors, headers or model content and never retry', async () => {
    for (const status of [429, 503, undefined]) {
        const output = [];
        let calls = 0;
        const error = Object.assign(new Error('synthetic-sensitive-diagnostic'), { status, headers: { Authorization: 'synthetic-credential' } });
        assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: 'fixture' }, reply: async () => { calls++; throw error; }, log: value => output.push(value) }), 1);
        assert.equal(calls, 1);
        assert.equal(JSON.parse(output[0]).reason, status === 429 ? 'rate_limited' : 'provider_or_network_unavailable');
        assert.doesNotMatch(output.join(), /synthetic-sensitive|synthetic-credential|Authorization/);
    }
    const output = [];
    assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: 'fixture' }, reply: async () => 'untrusted model content', log: value => output.push(value) }), 1);
    assert.equal(JSON.parse(output[0]).reason, 'unexpected_test_reply');
    assert.doesNotMatch(output.join(), /untrusted model content/);
});

test('rate-limit diagnostics expose only bounded seconds and an allowlisted source', async () => {
    for (const [seconds, source, expectedSeconds, expectedSource] of [
        [18.2, 'provider', 19, 'provider'], [undefined, undefined, 60, 'fallback'],
        [Infinity, 'provider', 60, 'fallback'], ['private-value', 'provider', 60, 'fallback'],
        [99999999, 'provider', 86400, 'provider'], [30, 'private-value', 30, 'fallback'],
    ]) {
        const output = [];
        const error = { status: 429, retryAfterSeconds: seconds, retryAfterSource: source };
        assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: 'fixture' }, reply: async () => { throw error; }, log: value => output.push(value) }), 1);
        const result = JSON.parse(output[0]);
        assert.equal(result.retryAfterSeconds, expectedSeconds);
        assert.equal(result.retryAfterSource, expectedSource);
        assert.doesNotMatch(output.join(), /private-value/);
    }
});

test('live check preserves Gemini Retry-After through the actual adapter without retrying', async t => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture';
    t.after(() => { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; });
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('private diagnostics', {
        status: 429, headers: { 'Retry-After': '23' },
    }));
    const output = [];
    assert.equal(await runGeminiCheck({ log: value => output.push(value) }), 1);
    assert.equal(JSON.parse(output[0]).retryAfterSeconds, 23);
    assert.equal(JSON.parse(output[0]).retryAfterSource, 'provider');
    assert.equal(fetch.mock.callCount(), 1);
    assert.doesNotMatch(output.join(), /private diagnostics/);
});

test('CLI rejects secret arguments without echoing them and fails closed without a key', () => {
    const env = { ...process.env, GEMINI_API_KEY: '' };
    const script = fileURLToPath(new URL('../scripts/check-gemini.mjs', import.meta.url));
    const missing = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).reason, 'missing_or_invalid_key');
    const rejected = spawnSync(process.execPath, [script, 'synthetic-secret-argument'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(rejected.status, 2);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-secret-argument/);
});

test('Windows secure wrapper can invoke Node and propagate a missing-key result', { skip: process.platform !== 'win32' }, () => {
    const script = fileURLToPath(new URL('../scripts/Test-Gemini.ps1', import.meta.url));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-UseEnvironment'], {
        env: { ...process.env, GEMINI_API_KEY: '' }, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout.trim()).reason, 'missing_or_invalid_key');
});

test('live check exercises the real Gemini adapter, with only the transport mocked', async t => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fixture';
    t.after(() => { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls++;
        assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
        const payload = JSON.parse(init.body);
        assert.equal(payload.contents.length, 1);
        assert.equal(payload.systemInstruction.parts.length, 1);
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'QAMQOR_GEMINI_OK' }] } }] });
    });
    const output = [];
    assert.equal(await runGeminiCheck({ log: value => output.push(value) }), 0);
    assert.equal(calls, 1);
});

test('invalid model configuration is redacted and rejected before the connection test', async () => {
    const output = [];
    assert.equal(await runGeminiCheck({ env: { GEMINI_API_KEY: 'fixture', GEMINI_MODEL: 'https://private.invalid/key' },
        reply: () => assert.fail('must not transmit'), log: value => output.push(value) }), 2);
    assert.equal(JSON.parse(output[0]).reason, 'invalid_model_configuration');
    assert.doesNotMatch(output.join(), /private.invalid|fixture/);
});
