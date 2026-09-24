import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = new URL('../', import.meta.url);

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'qamqormed-build-'));
    const files = ['public/debug.txt', 'public/index.html', 'index.html', '.env', 'src/private.mjs',
        'migrations/schema.sql', 'scripts/build.mjs'];
    const directories = ['public', 'src', 'migrations', 'scripts'];
    t.after(async () => {
        // Remove only known synthetic fixture paths, never recursively or from the project.
        for (const name of files) await unlink(join(root, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        for (const name of directories) {
            const path = join(root, name);
            if ((await lstat(path)).isSymbolicLink()) await unlink(path);
            else await rmdir(path);
        }
        await rmdir(root);
    });
    for (const name of directories) await mkdir(join(root, name));
    await copyFile(new URL('scripts/build.mjs', project), join(root, 'scripts/build.mjs'));
    await writeFile(join(root, 'index.html'), '<!doctype html><html><body>Public fixture</body></html>\n');
    // Synthetic sentinel only. The real project .env is never opened by these tests.
    await writeFile(join(root, '.env'), 'SYNTHETIC_PRIVATE_SENTINEL=not-a-credential\n');
    await writeFile(join(root, 'src/private.mjs'), 'export const internal = true;\n');
    await writeFile(join(root, 'migrations/schema.sql'), '-- private migration fixture\n');
    return { root, build: () => exec(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: tmpdir() }) };
}

test('build emits only identical index.html, excludes private files, and is deterministic', async t => {
    const { root, build } = await fixture(t);
    await build();
    assert.deepEqual(await readdir(join(root, 'public')), ['index.html']);
    const first = await readFile(join(root, 'public/index.html'));
    assert.deepEqual(first, await readFile(join(root, 'index.html')));
    assert.equal(first.includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
    await build();
    assert.deepEqual(await readdir(join(root, 'public')), ['index.html']);
    assert.deepEqual(await readFile(join(root, 'public/index.html')), first);
});

test('build refuses unexpected publish files and leaves them untouched', async t => {
    const { root, build } = await fixture(t);
    await writeFile(join(root, 'public/debug.txt'), 'Preserve this unexpected file');
    await assert.rejects(build(), error => /Unexpected public entry/.test(error.stderr));
    assert.deepEqual(await readdir(join(root, 'public')), ['debug.txt']);
    assert.equal(await readFile(join(root, 'public/debug.txt'), 'utf8'), 'Preserve this unexpected file');
});

test('build rejects a publish-directory symlink or junction without following it', async t => {
    const { root, build } = await fixture(t);
    await rmdir(join(root, 'public'));
    await symlink(join(root, 'src'), join(root, 'public'), 'junction');
    await assert.rejects(build(), error => /public must be a regular directory/.test(error.stderr));
    assert.deepEqual(await readdir(join(root, 'src')), ['private.mjs']);
});

test('Netlify configuration fixes the public directory, Node version, and function bundler', async () => {
    const config = await readFile(new URL('netlify.toml', project), 'utf8');
    assert.equal(config.replace(/\r\n/g, '\n').trim(), `[build]
  command = "npm run build:netlify"
  publish = "public"

[build.environment]
  NODE_VERSION = "24"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"`);
    const packageJson = JSON.parse(await readFile(new URL('package.json', project), 'utf8'));
    assert.equal(packageJson.scripts.build, 'node scripts/build.mjs');
    assert.equal(packageJson.scripts['build:netlify'], 'npm run db:check && npm run build');
    assert.equal(packageJson.scripts['db:check'], 'node scripts/check-schema.mjs');
    assert.match(await readFile(new URL('.gitignore', project), 'utf8'), /^public\/$/m);
});

test('website static asset references are external and local fetches target functions', async () => {
    const html = await readFile(new URL('index.html', project), 'utf8');
    const attributes = [...html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/g)].map(match => match[2]);
    const references = attributes.filter(value => value && !value.includes('${'));
    const cssUrls = [...html.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map(match => match[1]);
    assert.ok(references.length > 0);
    for (const value of [...references, ...cssUrls]) assert.match(value, /^https:\/\//);
    assert.doesNotMatch(html, /\bsrcset\s*=|@import\b/i);
    const localFetches = [...html.matchAll(/fetch\(\s*['"](\/[^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(localFetches.length > 0);
    for (const value of localFetches) assert.match(value, /^\/\.netlify\/functions\/[a-z-]+$/);
});
