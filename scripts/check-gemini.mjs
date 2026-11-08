import { pathToFileURL } from 'node:url';
import { geminiModel, geminiReply } from '../netlify/lib/gemini.mjs';

const prompt = 'This is a technical connectivity test, not a medical question. Reply with just: QAMQOR_GEMINI_OK';

export async function runGeminiCheck({ env = process.env, reply = geminiReply, log = console.log } = {}) {
    let model;
    try { model = geminiModel(env); } catch {
        log(JSON.stringify({ check: 'gemini', status: 'blocked', reason: 'invalid_model_configuration' }));
        return 2;
    }
    const emit = (status, reason, extra = {}) => log(JSON.stringify({ check: 'gemini', status, model, reason, ...extra }));
    const key = env.GEMINI_API_KEY?.trim();
    if (!key || /\s/.test(key)) {
        emit('blocked', 'missing_or_invalid_key');
        return 2;
    }
    const started = Date.now();
    try {
        const answer = await reply(prompt, []);
        if (typeof answer !== 'string' || answer.trim() !== 'QAMQOR_GEMINI_OK') {
            emit('failed', 'unexpected_test_reply');
            return 1;
        }
        emit('passed', 'synthetic_completion_received', { elapsedMs: Date.now() - started });
        return 0;
    } catch (error) {
        // Only allowlisted diagnostics. Never serialize provider errors, headers or answers.
        if (error?.status === 429) {
            const validDelay = Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0;
            emit('failed', 'rate_limited', {
                retryAfterSeconds: validDelay ? Math.min(86400, Math.ceil(error.retryAfterSeconds)) : 60,
                retryAfterSource: validDelay && error.retryAfterSource === 'provider' ? 'provider' : 'fallback',
            });
        } else emit('failed', 'provider_or_network_unavailable');
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.length !== 2) {
        console.error('No arguments accepted. Supply the key through the secure prompt or process environment, never as a command argument.');
        process.exitCode = 2;
    } else {
        process.exitCode = await runGeminiCheck();
    }
}
