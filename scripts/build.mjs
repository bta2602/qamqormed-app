import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssets } from './public-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'public');
const allowed = new Set(publicAssets.map(([, target]) => target));
const directories = new Set(['']);
for (const target of allowed) {
    let parent = dirname(target).replaceAll('\\', '/');
    while (parent !== '.') { directories.add(parent); parent = dirname(parent).replaceAll('\\', '/'); }
}
async function inspect(path = '') {
    const full = join(output, path);
    const info = await lstat(full).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Publish directory must be regular');
    for (const entry of await readdir(full, { withFileTypes: true })) {
        const relative = [path, entry.name].filter(Boolean).join('/');
        if (entry.isSymbolicLink()) throw new Error('Unexpected public entry');
        if (entry.isDirectory() && directories.has(relative)) await inspect(relative);
        else if (!entry.isFile() || !allowed.has(relative)) throw new Error('Unexpected public entry');
    }
}
await inspect();
// Explicit assets only; never copy the repository, environment files, or backend source.
for (const [source] of publicAssets) {
    let part = source;
    while (part !== '.') {
        const info = await lstat(join(root, part));
        if (info.isSymbolicLink() || (part === source ? !info.isFile() : !info.isDirectory())) {
            throw new Error('Source must be a regular file with regular parent directories');
        }
        part = dirname(part);
    }
}
for (const [source, target] of publicAssets) {
    await mkdir(dirname(join(output, target)), { recursive: true });
    await copyFile(join(root, source), join(output, target));
}
console.log('Built ' + publicAssets.length + ' allowlisted public assets');
