import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { openVault, sealVault } from './lib/operator-vault.mjs';

const maxInputBytes = 2 * 1024 * 1024;
const maxEnvelopeBytes = 1500000;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function destination(backupPath) {
    if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath) || /[\x00-\x1f\x7f]/.test(backupPath)) throw new Error();
    if (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(backupPath) || /[:*?"<>|]/.test(backupPath.slice(2)))) throw new Error();
    const directory = await fs.realpath(path.dirname(backupPath));
    if (inside(await fs.realpath(repoRoot), directory)) throw new Error();
    // realpath prevents a junction/symlink from disguising a repository destination.
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
        try {
            await fs.lstat(path.join(ancestor, '.git'));
            throw new Error();
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error();
        }
        if (ancestor === path.dirname(ancestor)) break;
    }
    return path.join(directory, path.basename(backupPath));
}

async function initialize(request) {
    if (!request || Array.isArray(request) || typeof request !== 'object' ||
        Object.keys(request).length !== 3 || !['passphrase', 'payload', 'backupPath'].every(key => Object.hasOwn(request, key)) ||
        !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) throw new Error();
    const backupPath = await destination(request.backupPath);
    const envelope = sealVault(request.payload, request.passphrase);
    const serialized = JSON.stringify(envelope) + '\n';
    let written;
    const writer = await fs.open(backupPath, 'wx', 0o600);
    try {
        await writer.writeFile(serialized, 'utf8');
        await writer.sync();
        written = await writer.stat();
    } finally {
        await writer.close();
    }
    // Do not remove failed artifacts automatically, and never overwrite them on retry.
    if (!(await fs.lstat(backupPath)).isFile()) throw new Error();
    const reader = await fs.open(backupPath, 'r');
    try {
        const reopened = await reader.stat();
        if (!reopened.isFile() || reopened.dev !== written.dev || reopened.ino !== written.ino ||
            reopened.size !== Buffer.byteLength(serialized) || reopened.size > maxEnvelopeBytes) throw new Error();
        const recovered = openVault(JSON.parse(await reader.readFile('utf8')), request.passphrase);
        if (!isDeepStrictEqual(recovered, request.payload)) throw new Error();
    } finally {
        await reader.close();
    }
    return backupPath;
}

async function main() {
    const chunks = [];
    let input, request;
    try {
        if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
        let size = 0;
        for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > maxInputBytes) {
                chunk.fill(0);
                throw new Error();
            }
            chunks.push(chunk);
        }
        input = Buffer.concat(chunks);
        // JSON.parse consumes exactly one JSON document and rejects trailing documents.
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
        const backupPath = await initialize(request);
        process.stdout.write(JSON.stringify({ status: 'verified', backupPath }) + '\n');
    } catch {
        process.stderr.write('Key initialization failed. No key material was printed. Existing files were not overwritten.\n');
        process.exitCode = 1;
    } finally {
        for (const chunk of chunks) chunk.fill(0);
        input?.fill(0);
        if (request && typeof request === 'object') {
            request.passphrase = null;
            request.payload = null;
        }
    }
}

await main();
