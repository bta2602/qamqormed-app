import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiReply, geminiModel, contentsForGemini, DEFAULT_GEMINI_MODEL, MAX_CONTEXT_BYTES } from '../netlify/lib/gemini.mjs';
import { HttpError } from '../netlify/lib/security.mjs';

function keyFor(t, key = 'fixture-only') {
    const original = process.env.GEMINI_API_KEY;
    if (key === null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key;
    t.after(() => { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; });
}
const success = text => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] });

test('Gemini uses fixed HTTPS host, server-only key header, timeout and bounded text payload', async t => {
    keyFor(t);
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers['x-goog-api-key'], 'fixture-only');
        assert.equal(init.headers.Authorization, undefined);
        assert.doesNotMatch(url, /fixture-only|\?key=/);
        assert.ok(init.signal instanceof AbortSignal);
        const payload = JSON.parse(init.body);
        assert.equal(payload.generationConfig.maxOutputTokens, 2048);
        assert.equal(payload.generationConfig.temperature, undefined);
        assert.equal(payload.systemInstruction.parts.length, 1);
        assert.equal(payload.user, undefined);
        assert.equal(payload.tools, undefined);
        assert.deepEqual(payload.contents, [
            { role: 'user', parts: [{ text: 'Previous question' }] }, { role: 'model', parts: [{ text: 'Previous answer' }] },
            { role: 'user', parts: [{ text: 'Current question' }] },
        ]);
        assert.doesNotMatch(init.body, /fixture-only|private-id|private-email/);
        return Response.json(success(' Final answer '));
    });
    assert.equal(await geminiReply('Current question', [
        { sender: 'private-id', text: 'Previous question', email: 'private-email' },
        { sender: 'support', text: 'Previous answer', id: 2 },
    ]), 'Final answer');
    assert.equal(fetch.mock.callCount(), 1);
});

test('history is limited to ten messages and bounded in UTF-8 bytes without modifying input', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ sender: i % 2 ? 'support' : 'patient', text: 'Message ' + i }));
    const original = structuredClone(history);
    const messages = contentsForGemini('Current', history);
    assert.equal(messages.length, 11);
    assert.equal(messages[0].parts[0].text, 'Message 20');
    assert.deepEqual(history, original);
    const large = contentsForGemini('Current', [
        { sender: 'patient', text: 'Old question' },
        { sender: 'support', text: 'a'.repeat(MAX_CONTEXT_BYTES) },
        { sender: 'patient', text: '\u049a'.repeat(6000) },
    ]);
    assert.equal(large.length, 2);
    assert.equal(large[0].parts[0].text.length, 6000);
    assert.ok(large.reduce((total, m) => total + Buffer.byteLength(m.parts[0].text), 0) <= MAX_CONTEXT_BYTES);
});

test('oversized, empty and non-string messages are rejected before any transmission', async t => {
    keyFor(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not transmit'); });
    for (const input of ['', ' ', null, 'x'.repeat(8001), '\u4e00'.repeat(8000)]) {
        await assert.rejects(geminiReply(input, []), error => error instanceof HttpError && error.status === 400);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('missing key never falls back to another provider or makes a request', async t => {
    keyFor(t, null);
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not transmit'); });
    await assert.rejects(geminiReply('Question', []), error => error.status === 503);
    assert.equal(fetch.mock.callCount(), 0);
});

test('rate limits are sanitized, bounded and not retried automatically', async t => {
    keyFor(t);
    let retryAfter;
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream diagnostics', {
        status: 429, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
    }));
    for (const [header, expected] of [[null, 60], ['3.2', 4], ['999999', 86400], ['nonsense', 60]]) {
        retryAfter = header;
        await assert.rejects(geminiReply('Question', []), error => {
            assert.equal(error.status, 429);
            assert.equal(error.retryAfterSeconds, expected);
            assert.equal(error.retryAfterSource, header === null || header === 'nonsense' ? 'fallback' : 'provider');
            assert.doesNotMatch(error.message, /secret upstream|fixture-only/);
            return true;
        });
    }
    assert.equal(fetch.mock.callCount(), 4);
});

test('upstream HTTP failures never echo provider diagnostics', async t => {
    keyFor(t);
    let status;
    t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream diagnostics', { status }));
    for (status of [400, 401, 403, 404, 500, 503]) {
        await assert.rejects(geminiReply('Question', []), error => error.status === 503 && !error.message.includes('secret upstream'));
    }
});

test('timeouts and transport failures become sanitized service errors', async t => {
    keyFor(t);
    let failure;
    t.mock.method(globalThis, 'fetch', async () => { throw failure; });
    for (failure of [new DOMException('private content', 'TimeoutError'), new Error('private credential')]) {
        await assert.rejects(geminiReply('Question', []), error => error instanceof HttpError && error.status === 503 && !error.message.includes('private'));
    }
});

test('malformed, empty, truncated, tool and reasoning responses are not used as medical answers', async t => {
    keyFor(t);
    let output;
    t.mock.method(globalThis, 'fetch', async () => new Response(output));
    const truncated = success('Partial answer'); truncated.candidates[0].finishReason = 'MAX_TOKENS';
    const tool = success('Answer'); tool.candidates[0].content.parts.push({ functionCall: { name: 'book' } });
    const blocked = success('Answer'); blocked.promptFeedback = { blockReason: 'SAFETY' };
    const unsafe = success('Answer'); unsafe.candidates[0].safetyRatings = [{ blocked: true }];
    const thoughts = success('Private reasoning'); thoughts.candidates[0].content.parts[0].thought = true;
    const malformed = success('Answer'); malformed.candidates[0].safetyRatings = {};
    for (const candidate of [null, {}, { candidates: [{ finishReason: 'STOP' }] }, success(' '), success('x'.repeat(20001)),
        success('<think>private reasoning</think>answer'), truncated, tool, blocked, unsafe, thoughts, malformed, success(['Unexpected structure'])]) {
        output = JSON.stringify(candidate);
        await assert.rejects(geminiReply('Question', []), error => error instanceof HttpError && error.status === 503);
    }
    output = '<html>upstream failure</html>';
    await assert.rejects(geminiReply('Question', []), error => error.status === 503);
});

test('thought parts are excluded while complete public text parts are joined', async t => {
    keyFor(t);
    const output = success('Hello ');
    output.candidates[0].content.parts.unshift({ text: 'private thought', thought: true });
    output.candidates[0].content.parts.push({ text: 'there', thoughtSignature: 'opaque-private-signature' });
    t.mock.method(globalThis, 'fetch', async () => Response.json(output));
    assert.equal(await geminiReply('Question', []), 'Hello there');
});

test('model overrides cannot inject paths, query credentials or change the provider host', async t => {
    keyFor(t);
    assert.equal(geminiModel({}), DEFAULT_GEMINI_MODEL);
    assert.equal(geminiModel({ GEMINI_MODEL: ' gemini-3.1-flash-lite ' }), 'gemini-3.1-flash-lite');
    const original = process.env.GEMINI_MODEL;
    t.after(() => { if (original === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = original; });
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not transmit'); });
    for (const model of ['https://other.invalid', 'gemini-../secret', 'gemini-test?key=private', 'gemini-' + 'a'.repeat(101)]) {
        process.env.GEMINI_MODEL = model;
        await assert.rejects(geminiReply('Question', []), error => error.status === 503 && !error.message.includes(model));
    }
    assert.equal(fetch.mock.callCount(), 0);
});
