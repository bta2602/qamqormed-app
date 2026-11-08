import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const prefix = 'qmenc1';
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const fields = {
    appointments: ['message', 'diagnosis', 'notes', 'treatment'],
    analyses: ['type', 'results'],
    prescriptions: ['medicine', 'dosage', 'instructions'],
    chat_messages: ['text'],
    users: ['blood_type'],
};

export class DataProtectionError extends Error {
    constructor() { super('Protected data is unavailable'); this.name = 'DataProtectionError'; }
}

export function dataKeyring(env = process.env) {
    try {
        const active = env.QAMQOR_DATA_KEY_ID;
        const source = JSON.parse(env.QAMQOR_DATA_KEYS ?? 'null');
        if (!keyIdPattern.test(active ?? '') || !source || Array.isArray(source) || typeof source !== 'object') throw new DataProtectionError();
        const keys = new Map();
        for (const [id, value] of Object.entries(source)) {
            if (!keyIdPattern.test(id) || typeof value !== 'string') throw new DataProtectionError();
            const key = Buffer.from(value, 'base64');
            if (key.length !== 32 || key.toString('base64') !== value) throw new DataProtectionError();
            keys.set(id, key);
        }
        if (!keys.has(active)) throw new DataProtectionError();
        return { active, keys };
    } catch { throw new DataProtectionError(); }
}

function aad(table, id, field, keyId) {
    if (!fields[table]?.includes(field) || !/^[1-9][0-9]*$/.test(String(id))) throw new DataProtectionError();
    return Buffer.from(JSON.stringify(['QamqorMed', 1, keyId, table, String(id), field]));
}

export function protectField(value, table, id, field, env = process.env) {
    if (value == null) return value;
    const { active, keys } = dataKeyring(env);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keys.get(active), nonce, { authTagLength: 16 });
    cipher.setAAD(aad(table, id, field, active));
    const plaintext = JSON.stringify(value);
    if (plaintext === undefined || Buffer.byteLength(plaintext) > 1024 * 1024) throw new DataProtectionError();
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const encoded = [prefix, active, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    return field === 'results' ? { _encrypted: encoded } : encoded;
}

export function revealField(value, table, id, field, env = process.env) {
    if (value == null) return value;
    const encoded = field === 'results' ? value?._encrypted : value;
    const protectedValue = typeof encoded === 'string' && encoded.startsWith(prefix + '.');
    if (!protectedValue) {
        if ((typeof encoded === 'string' && encoded.startsWith('qmenc')) ||
            (field === 'results' && !Array.isArray(value))) throw new DataProtectionError();
        // Temporary read compatibility is an explicit rollout choice, never a silent write fallback.
        if (env.QAMQOR_ALLOW_LEGACY_PLAINTEXT === 'true') return value;
        throw new DataProtectionError();
    }
    try {
        const [version, keyId, iv, tag, payload, extra] = encoded.split('.');
        if (version !== prefix || extra !== undefined || !keyIdPattern.test(keyId) ||
            !/^[A-Za-z0-9_-]{16}$/.test(iv) || !/^[A-Za-z0-9_-]{22}$/.test(tag) ||
            !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length > 1400000) throw new DataProtectionError();
        const { keys } = dataKeyring(env);
        const key = keys.get(keyId);
        if (!key) throw new DataProtectionError();
        const ivBytes = Buffer.from(iv, 'base64url'), tagBytes = Buffer.from(tag, 'base64url'), bytes = Buffer.from(payload, 'base64url');
        if (ivBytes.toString('base64url') !== iv || tagBytes.toString('base64url') !== tag || bytes.toString('base64url') !== payload) throw new DataProtectionError();
        const decipher = createDecipheriv('aes-256-gcm', key, ivBytes, { authTagLength: 16 });
        decipher.setAAD(aad(table, id, field, keyId));
        decipher.setAuthTag(tagBytes);
        return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8'));
    } catch { throw new DataProtectionError(); }
}

export function protectRecord(table, record, env = process.env) {
    const result = { ...record };
    for (const field of fields[table] ?? []) if (Object.hasOwn(record, field)) result[field] = protectField(record[field], table, record.id, field, env);
    return result;
}
export function revealRecord(table, record, env = process.env) {
    const result = { ...record };
    for (const field of fields[table] ?? []) if (Object.hasOwn(record, field)) result[field] = revealField(record[field], table, record.id, field, env);
    return result;
}

// IDs are reserved before encryption so ciphertext authenticates the immutable row identity.
export async function reserveId(sql, table) {
    let rows;
    switch (table) {
        case 'appointments': rows = await sql`SELECT nextval(pg_get_serial_sequence('appointments', 'id')) AS id`; break;
        case 'analyses': rows = await sql`SELECT nextval(pg_get_serial_sequence('analyses', 'id')) AS id`; break;
        case 'prescriptions': rows = await sql`SELECT nextval(pg_get_serial_sequence('prescriptions', 'id')) AS id`; break;
        case 'chat_messages': rows = await sql`SELECT nextval(pg_get_serial_sequence('chat_messages', 'id')) AS id`; break;
        default: throw new DataProtectionError();
    }
    const id = Number(rows[0]?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new DataProtectionError();
    return id;
}
