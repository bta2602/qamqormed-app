import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publicAssets } from '../scripts/public-assets.mjs';

const exec = promisify(execFile);
const project = new URL('../', import.meta.url);

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'qamqormed-build-'));
    t.after(async () => {
        const absolute = resolve(root);
        if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('qamqormed-build-')) {
            throw new Error('Refusing to remove a non-fixture directory');
        }
        await rm(absolute, { recursive: true, force: true });
    });
    for (const name of ['public', 'scripts', 'src', 'migrations']) await mkdir(join(root, name));
    for (const name of ['build.mjs', 'public-assets.mjs']) await copyFile(new URL('scripts/' + name, project), join(root, 'scripts', name));
    for (const [source] of publicAssets) {
        await mkdir(dirname(join(root, source)), { recursive: true });
        await writeFile(join(root, source), 'Synthetic public asset: ' + source);
    }
    // Synthetic sentinel only. These tests never read a real environment file.
    await writeFile(join(root, '.env'), 'SYNTHETIC_PRIVATE_SENTINEL=not-a-credential');
    await writeFile(join(root, 'src/private.mjs'), 'export const internal = true;');
    await writeFile(join(root, 'migrations/schema.sql'), '-- private fixture');
    return { root, build: () => exec(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: tmpdir(), windowsHide: true }) };
}

async function files(directory, prefix = '') {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), name + '/'));
        else result.push(name);
    }
    return result.sort();
}

test('build copies exactly allowlisted assets, excludes private files, and is deterministic', async t => {
    const { root, build } = await fixture(t);
    await build();
    const expected = publicAssets.map(([, target]) => target).sort();
    assert.deepEqual(await files(join(root, 'public')), expected);
    for (const [source, target] of publicAssets) {
        const output = await readFile(join(root, 'public', target));
        assert.deepEqual(output, await readFile(join(root, source)));
        assert.equal(output.includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
    }
    await build();
    assert.deepEqual(await files(join(root, 'public')), expected);
});

test('build refuses unexpected publish files before overwriting existing output', async t => {
    const { root, build } = await fixture(t);
    await writeFile(join(root, 'public/debug.txt'), 'Preserve this unexpected file');
    await writeFile(join(root, 'public/index.html'), 'Preserve old output');
    await assert.rejects(build(), error => /Unexpected public entry/.test(error.stderr));
    assert.equal(await readFile(join(root, 'public/debug.txt'), 'utf8'), 'Preserve this unexpected file');
    assert.equal(await readFile(join(root, 'public/index.html'), 'utf8'), 'Preserve old output');
});

test('build rejects a publish-directory junction without following it', async t => {
    const { root, build } = await fixture(t);
    await rmdir(join(root, 'public'));
    await symlink(join(root, 'src'), join(root, 'public'), 'junction');
    await assert.rejects(build(), error => /Publish directory must be regular/.test(error.stderr));
    assert.deepEqual(await readdir(join(root, 'src')), ['private.mjs']);
});

test('build rejects source parent junctions before copying any assets', async t => {
    const { root, build } = await fixture(t);
    await mkdir(join(root, 'linked'));
    await symlink(join(root, 'web'), join(root, 'linked/web'), 'junction');
    // The manifest is a synthetic fixture, not a change to the real asset allowlist.
    await writeFile(join(root, 'scripts/public-assets.mjs'), "export const publicAssets = [['linked/web/app.mjs', 'app.mjs']];");
    await assert.rejects(build(), error => /regular parent directories/.test(error.stderr));
    assert.deepEqual(await readdir(join(root, 'public')), []);
});

test('Netlify configuration enforces gated publication and browser security headers', async () => {
    const config = await readFile(new URL('netlify.toml', project), 'utf8');
    for (const line of ['command = "npm run build:netlify"', 'publish = "public"', 'NODE_VERSION = "24"',
        'directory = "netlify/functions"', 'node_bundler = "esbuild"', 'X-Content-Type-Options = "nosniff"',
        'X-Frame-Options = "DENY"', 'Referrer-Policy = "no-referrer"']) assert.ok(config.includes(line), line);
    assert.match(config, /Content-Security-Policy.*script-src 'self'/);
    assert.match(config, /frame-ancestors 'none'/);
    const packageJson = JSON.parse(await readFile(new URL('package.json', project), 'utf8'));
    assert.equal(packageJson.scripts.build, 'node scripts/build.mjs');
    assert.equal(packageJson.scripts['build:netlify'], 'npm run security:secrets && npm run db:check && npm run build');
    assert.equal(packageJson.scripts['db:check'], 'node scripts/check-schema.mjs');
    assert.match(await readFile(new URL('.gitignore', project), 'utf8'), /^public\/$/m);
});

test('HTML uses only bundled allowlisted references without inline scripts', async () => {
    const html = await readFile(new URL('index.html', project), 'utf8');
    const references = [...html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/g)].map(match => match[2]);
    const allowed = new Set(publicAssets.map(([, target]) => '/' + target));
    assert.ok(references.length > 0);
    for (const value of references) assert.ok(allowed.has(value), value);
    assert.doesNotMatch(html, /\bsrcset\s*=|@import\b|<script\b(?![^>]*src=)/i);
});
