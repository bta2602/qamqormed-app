import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sealVault, openVault } from '../scripts/lib/operator-vault.mjs';

const passphrase = 'Synthetic fixture passphrase only!';
const payload = { version: 1, createdAt: '2026-11-09T00:00:00.000Z', env: { fixture: 'not-an-operational-key' }, nested: [true, null, 123] };
const script = fileURLToPath(new URL('../scripts/initialize-data-keys.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('../scripts/Initialize-DataKeys.ps1', import.meta.url));
const root = path.dirname(path.dirname(script));
const failure = { name: 'Error', message: 'Vault operation failed.' };
let sealed;

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qamqormed-vault-test-'));
    t.after(() => {
        // Only remove the exact, newly-created fixture directory, never an arbitrary path.
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('qamqormed-vault-test-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

function cli(request, args = []) {
    return spawnSync(process.execPath, [script, ...args], {
        input: typeof request === 'string' || Buffer.isBuffer(request) ? request : JSON.stringify(request),
        encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
}

function rejected(result) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Key initialization failed. No key material was printed. Existing files were not overwritten.\n');
}

test('JSON round-trip, randomized salt/nonce, and ciphertext-only envelope', () => {
    sealed = sealVault(payload, passphrase);
    const next = sealVault(payload, passphrase);
    assert.deepEqual(openVault(JSON.parse(JSON.stringify(sealed)), passphrase), payload);
    assert.notEqual(next.kdf.salt, sealed.kdf.salt);
    assert.notEqual(next.nonce, sealed.nonce);
    assert.notEqual(next.ciphertext, sealed.ciphertext);
    assert.doesNotMatch(JSON.stringify(sealed), /not-an-operational-key|Synthetic fixture|createdAt/);
    assert.equal(Buffer.from(sealed.kdf.salt, 'base64').length, 32);
    assert.equal(Buffer.from(sealed.nonce, 'base64').length, 12);
    assert.equal(Buffer.from(sealed.tag, 'base64').length, 16);
});

test('wrong passphrase and authenticated field tampering have identical redacted errors', () => {
    assert.throws(() => openVault(sealed, 'Wrong synthetic passphrase!'), failure);
    for (const name of ['salt', 'nonce', 'ciphertext', 'tag']) {
        const copy = structuredClone(sealed);
        const target = name === 'salt' ? copy.kdf : copy;
        const bytes = Buffer.from(target[name], 'base64');
        bytes[0] ^= 1;
        target[name] = bytes.toString('base64');
        assert.throws(() => openVault(copy, passphrase), failure);
    }
});

test('ciphertext authentication requires the canonical metadata as AAD', () => {
    const key = scryptSync(passphrase, Buffer.from(sealed.kdf.salt, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'), { authTagLength: 16 });
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        const partial = decipher.update(Buffer.from(sealed.ciphertext, 'base64'));
        partial.fill(0);
        assert.throws(() => decipher.final());
        const valid = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'), { authTagLength: 16 });
        const { format, version, cipher, kdf, nonce } = sealed;
        valid.setAAD(Buffer.from(JSON.stringify({ format, version, cipher, kdf, nonce })));
        valid.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        const bytes = Buffer.concat([valid.update(Buffer.from(sealed.ciphertext, 'base64')), valid.final()]);
        assert.deepEqual(JSON.parse(bytes.toString('utf8')), payload);
        bytes.fill(0);
    } finally { key.fill(0); }
});

test('strict version, algorithms, schema, bounded KDF, and canonical encoding fail closed', () => {
    const changes = [
        value => { value.version = 2; }, value => { value.version = '1'; },
        value => { value.format = 'another-vault'; }, value => { value.cipher = 'aes-256-cbc'; },
        value => { value.kdf.name = 'pbkdf2'; }, value => { value.kdf.N = 2 ** 30; },
        value => { value.kdf.N = 2; }, value => { value.kdf.r = 1e9; }, value => { value.kdf.p = 1e9; },
        value => { value.kdf.N = '131072'; }, value => { value.kdf.extra = true; },
        value => { value.extra = 'private'; }, value => { delete value.tag; },
        value => { value.nonce += '='; }, value => { value.tag = value.tag.slice(0, -4); },
        value => { value.kdf.salt = ''; }, value => { value.ciphertext = 'A'.repeat(1400000); },
        value => { value.ciphertext = '!!!!'; }, value => { value.ciphertext = ''; },
        value => { Object.defineProperty(value, 'version', { get() { throw new Error('sensitive getter'); } }); },
    ];
    for (const change of changes) {
        const copy = structuredClone(sealed);
        change(copy);
        assert.throws(() => openVault(copy, passphrase), failure);
    }
    for (const value of [null, [], 'private', {}, undefined]) assert.throws(() => openVault(value, passphrase), failure);
});

test('short/oversized passphrases and lossy/oversized values are refused without leaking values', () => {
    for (const password of ['', '123456789012345', ' '.repeat(32), 'x'.repeat(1025), null, 42]) {
        assert.throws(() => sealVault(payload, password), failure);
        assert.throws(() => openVault(sealed, password), failure);
    }
    const circular = {}; circular.self = circular;
    for (const value of [undefined, NaN, Infinity, 1n, { missing: undefined }, new Date(), circular, 'x'.repeat(1024 * 1024)]) {
        assert.throws(() => sealVault(value, passphrase), failure);
    }
    assert.equal(openVault(sealVault(null, '1234567890123456'), '1234567890123456'), null);
});

test('CLI writes only the envelope outside git, verifies it, and refuses overwrite', t => {
    const directory = temporary(t);
    const backupPath = path.join(directory, 'fixture backup.json');
    const request = { passphrase, payload, backupPath };
    const result = cli(request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'verified', backupPath });
    const saved = fs.readFileSync(backupPath, 'utf8');
    assert.deepEqual(openVault(JSON.parse(saved), passphrase), payload);
    assert.doesNotMatch(saved + result.stdout, /not-an-operational-key|Synthetic fixture/);
    assert.deepEqual(fs.readdirSync(directory), ['fixture backup.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
    rejected(cli(request));
    assert.equal(fs.readFileSync(backupPath, 'utf8'), saved);
});

test('CLI rejects extra arguments, malformed/multiple JSON, invalid UTF-8, and oversized input', t => {
    const backupPath = path.join(temporary(t), 'never-created.json');
    const request = { passphrase, payload, backupPath };
    for (const input of ['', '{private', JSON.stringify(request) + '\n{}', JSON.stringify({ ...request, extra: true }),
        JSON.stringify({ payload, backupPath }), JSON.stringify({ ...request, passphrase: 'short' }),
        Buffer.from([0xff, 0xfe]), ' '.repeat(2 * 1024 * 1024 + 1)]) rejected(cli(input));
    rejected(cli(request, ['synthetic-secret-argument']));
    assert.equal(fs.existsSync(backupPath), false);
});

test('CLI rejects this repository, other git directories, and junctions into git', t => {
    const directory = temporary(t);
    const other = path.join(directory, 'other-repo');
    fs.mkdirSync(other);
    fs.mkdirSync(path.join(other, '.git'));
    const link = path.join(directory, 'linked-repo');
    fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const backupPath of [path.join(root, 'never-create-vault.json'), path.join(other, 'vault.json'),
        path.join(link, 'vault.json'), 'relative-vault.json', path.join(directory, 'missing', 'vault.json')]) {
        rejected(cli({ passphrase, payload, backupPath }));
        assert.equal(fs.existsSync(backupPath), false);
    }
});

test('CLI detects post-write corruption on its actual reopen path', t => {
    const directory = temporary(t);
    const backupPath = path.join(directory, 'corruption-fixture.json');
    const program = `
        import fs from 'node:fs/promises';
        const original = fs.open.bind(fs);
        fs.open = async (...args) => {
            const handle = await original(...args);
            if (args[1] === 'r') {
                const read = handle.readFile.bind(handle);
                handle.readFile = async (...options) => {
                    const value = JSON.parse(await read(...options));
                    const bytes = Buffer.from(value.tag, 'base64'); bytes[0] ^= 1;
                    value.tag = bytes.toString('base64');
                    return JSON.stringify(value);
                };
            }
            return handle;
        };
        process.argv = [process.execPath, ${JSON.stringify(script)}];
        await import(${JSON.stringify(new URL('../scripts/initialize-data-keys.mjs', import.meta.url).href)});
    `;
    rejected(spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        input: JSON.stringify({ passphrase, payload, backupPath }), encoding: 'utf8', windowsHide: true, timeout: 30000,
    }));
    assert.deepEqual(fs.readdirSync(directory), ['corruption-fixture.json']);
    assert.doesNotMatch(fs.readFileSync(backupPath, 'utf8'), /not-an-operational-key|Synthetic fixture/);
});

const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";

for (const executable of ['powershell.exe', 'pwsh.exe']) {
test(`${executable} full dry bootstrap: existing directory, mocked secure prompts, dummy bytes, ACL, DPAPI, no overwrite`, { skip: process.platform !== 'win32' }, t => {
    const parent = temporary(t);
    const directory = path.join(parent, "fixture space ' quoted");
    fs.mkdirSync(directory);
    const program = `
        $ErrorActionPreference = 'Stop'
        $source = [IO.File]::ReadAllText(${psLiteral(wrapper)})
        $tokens = $null; $errors = $null
        $null = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        if ($errors.Count -ne 0) { throw 'Parser failure.' }
        # Never run the operational key generator: substitute a public, deterministic fixture in memory.
        $needle = '$random.GetBytes($keyBytes)'
        if ($source.Split(@($needle), [StringSplitOptions]::None).Length -ne 2) { throw 'Fixture substitution failed.' }
        $source = $source.Replace($needle, '$keyBytes = [byte[]](0..31)')
        $source = $source.Replace('$PSScriptRoot', ${psLiteral(psLiteral(path.dirname(wrapper)))})
        function Read-Host {
            param([string]$Prompt, [switch]$AsSecureString)
            if (-not $AsSecureString) { throw 'Secure input required.' }
            return ConvertTo-SecureString ${psLiteral(passphrase)} -AsPlainText -Force
        }
        & ([scriptblock]::Create($source)) -SecretsDirectory ${psLiteral(directory)}
    `;
    // Let 5.1 locate its own built-in modules, not inherited PowerShell 7 modules.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
    const options = { env, encoding: 'utf8', windowsHide: true, timeout: 45000 };
    const run = () => spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', program], options);
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Initialization complete/);
    assert.doesNotMatch(result.stdout, /Synthetic fixture/);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['data-keys.dpapi', 'data-keys.vault.json']);
    const saved = fs.readFileSync(path.join(directory, 'data-keys.vault.json'), 'utf8');
    const recovered = openVault(JSON.parse(saved), passphrase);
    const dummyBase64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
    assert.equal(recovered.version, 1);
    assert.ok(Number.isFinite(Date.parse(recovered.createdAt)));
    assert.equal(recovered.env.QAMQOR_DATA_KEY_ID, 'data-20261109');
    assert.deepEqual(JSON.parse(recovered.env.QAMQOR_DATA_KEYS), { 'data-20261109': dummyBase64 });
    assert.doesNotMatch(saved + result.stdout, new RegExp(dummyBase64));
    const verify = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Security
        $directory = ${psLiteral(directory)}
        $acl = Get-Acl -LiteralPath $directory
        if (-not $acl.AreAccessRulesProtected) { throw 'ACL inheritance enabled.' }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        foreach ($item in @($directory, (Join-Path $directory 'data-keys.dpapi'), (Join-Path $directory 'data-keys.vault.json'))) {
            $rules = @((Get-Acl -LiteralPath $item).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if ($rules.Count -ne 2) { throw 'Unexpected ACL.' }
            foreach ($rule in $rules) {
                if ($rule.IdentityReference.Value -notin @($sid, 'S-1-5-18') -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected principal.' }
            }
        }
        $bytes = [IO.File]::ReadAllBytes((Join-Path $directory 'data-keys.dpapi'))
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $value = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString($plain))
        if ($value.version -ne 1 -or ([DateTimeOffset]$value.createdAt).UtcDateTime.Ticks -ne ([DateTimeOffset]${psLiteral(recovered.createdAt)}).UtcDateTime.Ticks -or
            $value.env.QAMQOR_DATA_KEY_ID -ne 'data-20261109' -or
            ($value.env.QAMQOR_DATA_KEYS | ConvertFrom-Json).'data-20261109' -ne [Convert]::ToBase64String([byte[]](0..31))) { throw 'Fixture mismatch.' }
        [Array]::Clear($plain, 0, $plain.Length)
        $bytes[0] = $bytes[0] -bxor 1
        $failed = $false
        try { $null = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) } catch { $failed = $true }
        if (-not $failed) { throw 'Tamper accepted.' }
        Write-Output 'Fixture DPAPI and ACL verified.'
    `], options);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    assert.match(verify.stdout, /Fixture DPAPI and ACL verified/);
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stdout, /failed during preflight/);
    assert.equal(fs.readFileSync(path.join(directory, 'data-keys.vault.json'), 'utf8'), saved);
});
}
