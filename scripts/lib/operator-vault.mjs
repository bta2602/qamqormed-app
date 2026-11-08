import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';

const format = 'QamqorMed.operator-vault';
const maxBytes = 1024 * 1024;
// Version 1 accepts exactly this bounded work factor, never caller-selected costs.
const work = Object.freeze({ N: 131072, r: 8, p: 1 });
const maxmem = 192 * 1024 * 1024;
const failure = () => new Error('Vault operation failed.');

function exactObject(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).length !== keys.length ||
        !keys.every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key).value !== undefined)) {
        throw failure();
    }
}

function checkPassphrase(passphrase) {
    if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase, 'utf8') > 1024 ||
        Array.from(passphrase.trim()).length < 16) throw failure();
}

function decode(value, length, maximum = length) {
    if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure();
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < length || bytes.length > maximum || bytes.toString('base64') !== value) throw failure();
    return bytes;
}

function metadata(envelope) {
    return Buffer.from(JSON.stringify({
        format: envelope.format,
        version: envelope.version,
        cipher: envelope.cipher,
        kdf: { name: envelope.kdf.name, N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p, salt: envelope.kdf.salt },
        nonce: envelope.nonce,
    }), 'utf8');
}

// Accept JSON values only: lossy JSON conversions must not silently change a backup.
export function sealVault(value, passphrase) {
    let plaintext, key;
    try {
        checkPassphrase(passphrase);
        const serialized = JSON.stringify(value);
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes ||
            !isDeepStrictEqual(JSON.parse(serialized), value)) throw failure();
        plaintext = Buffer.from(serialized, 'utf8');
        const salt = randomBytes(32);
        const nonce = randomBytes(12);
        const envelope = {
            format, version: 1, cipher: 'aes-256-gcm',
            kdf: { name: 'scrypt', ...work, salt: salt.toString('base64') },
            nonce: nonce.toString('base64'),
        };
        key = scryptSync(passphrase, salt, 32, { ...work, maxmem });
        const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(metadata(envelope));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { ...envelope, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    } catch {
        throw failure();
    } finally {
        plaintext?.fill(0);
        key?.fill(0);
    }
}

export function openVault(envelope, passphrase) {
    let key, partial, tail, plaintext;
    try {
        checkPassphrase(passphrase);
        exactObject(envelope, ['format', 'version', 'cipher', 'kdf', 'nonce', 'ciphertext', 'tag']);
        exactObject(envelope.kdf, ['name', 'N', 'r', 'p', 'salt']);
        if (envelope.format !== format || envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm' ||
            envelope.kdf.name !== 'scrypt' || !Object.entries(work).every(([name, value]) => envelope.kdf[name] === value)) {
            throw failure();
        }
        const salt = decode(envelope.kdf.salt, 32);
        const nonce = decode(envelope.nonce, 12);
        const tag = decode(envelope.tag, 16);
        const ciphertext = decode(envelope.ciphertext, 1, maxBytes);
        key = scryptSync(passphrase, salt, 32, { ...work, maxmem });
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        decipher.setAAD(metadata(envelope));
        decipher.setAuthTag(tag);
        partial = decipher.update(ciphertext);
        tail = decipher.final();
        plaintext = Buffer.concat([partial, tail]);
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch {
        throw failure();
    } finally {
        key?.fill(0);
        partial?.fill(0);
        tail?.fill(0);
        plaintext?.fill(0);
    }
}
