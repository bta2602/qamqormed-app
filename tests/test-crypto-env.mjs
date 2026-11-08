import { randomBytes } from 'node:crypto';
// Ephemeral test-only keys, never production credentials or fixture secrets checked into Git.
process.env.QAMQOR_DATA_KEY_ID = 'test';
process.env.QAMQOR_DATA_KEYS = JSON.stringify({ test: randomBytes(32).toString('base64') });
process.env.QAMQOR_ALLOW_LEGACY_PLAINTEXT = 'true';
