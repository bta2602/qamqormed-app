import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'index.html');
const output = join(root, 'public');
const sourceInfo = await lstat(source);
if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('index.html must be a regular file');

const outputInfo = await lstat(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
});
if (outputInfo && (!outputInfo.isDirectory() || outputInfo.isSymbolicLink())) {
    throw new Error('public must be a regular directory');
}
await mkdir(output, { recursive: true });

// Fail closed on stale files instead of deleting or publishing unexpected content.
const entries = await readdir(output, { withFileTypes: true });
if (entries.some(entry => entry.name !== 'index.html' || !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Unexpected public entry; inspect the generated directory before building');
}
await copyFile(source, join(output, 'index.html'));
console.log('Built public/index.html (only public asset)');
