import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { dataKeyring, protectField, revealField, protectRecord, revealRecord } from '../netlify/lib/data-crypto.mjs';

const env = () => ({ QAMQOR_DATA_KEY_ID: 'test', QAMQOR_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }) });
test('clinical text and JSON round-trip without storing their plaintext', () => {
    const key = env();
    for (const [table, record] of [
        ['appointments', { id: 1, message: 'Private fixture', diagnosis: 'Diagnosis', notes: '', treatment: null }],
        ['analyses', { id: 2, type: 'Private fixture', results: [{ name: 'Test', value: 3 }] }],
        ['prescriptions', { id: 3, medicine: 'Private fixture', dosage: 'Fixture', instructions: 'Fixture' }],
        ['chat_messages', { id: 4, text: 'Private fixture' }],
        ['users', { id: 5, blood_type: 'Private fixture' }],
    ]) {
        const encoded = protectRecord(table, record, key);
        assert.equal(JSON.stringify(encoded).includes('Private fixture'), false);
        assert.deepEqual(revealRecord(table, encoded, key), record);
    }
});
test('fresh nonces make identical values different at rest', () => {
    const key = env();
    assert.notEqual(protectField('same', 'chat_messages', 1, 'text', key), protectField('same', 'chat_messages', 1, 'text', key));
});
test('row, table and field substitution, wrong keys, tampering and truncation fail closed', () => {
    const key = env();
    const value = protectField('Fixture', 'appointments', 1, 'notes', key);
    for (const [table, id, field] of [['appointments', 2, 'notes'], ['appointments', 1, 'diagnosis'], ['chat_messages', 1, 'text']]) {
        assert.throws(() => revealField(value, table, id, field, key), /Protected data is unavailable/);
    }
    assert.throws(() => revealField(value, 'appointments', 1, 'notes', env()));
    assert.throws(() => revealField(value.slice(0, -3), 'appointments', 1, 'notes', key));
    const parts = value.split('.'); parts[4] = (parts[4][0] === 'A' ? 'B' : 'A') + parts[4].slice(1);
    assert.throws(() => revealField(parts.join('.'), 'appointments', 1, 'notes', key));
});
test('missing/invalid keys never fall back to plaintext writes', () => {
    for (const config of [{}, { QAMQOR_ALLOW_LEGACY_PLAINTEXT: 'true' }, { QAMQOR_DATA_KEY_ID: 'x', QAMQOR_DATA_KEYS: '{"x":"short"}' }]) {
        assert.throws(() => dataKeyring(config));
        assert.throws(() => protectField('Fixture', 'chat_messages', 1, 'text', config));
    }
});
test('legacy reads need explicit migration mode; invalid ciphertext never uses it', () => {
    assert.throws(() => revealField('Fixture', 'chat_messages', 1, 'text', {}));
    const migration = { ...env(), QAMQOR_ALLOW_LEGACY_PLAINTEXT: 'true' };
    assert.equal(revealField('Fixture', 'chat_messages', 1, 'text', migration), 'Fixture');
    assert.throws(() => revealField('qmenc1.invalid', 'chat_messages', 1, 'text', migration));
});
test('rotation writes the active key and retains old-key reads until migration', () => {
    const original = env();
    const old = protectField('Fixture', 'chat_messages', 1, 'text', original);
    const rotated = { QAMQOR_DATA_KEY_ID: 'next', QAMQOR_DATA_KEYS: JSON.stringify({ ...JSON.parse(original.QAMQOR_DATA_KEYS), next: randomBytes(32).toString('base64') }) };
    assert.equal(revealField(old, 'chat_messages', 1, 'text', rotated), 'Fixture');
    assert.match(protectField('Fixture', 'chat_messages', 1, 'text', rotated), /^qmenc1\.next\./);
});
