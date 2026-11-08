import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rules = [
    ['google-api-key', /AIza[0-9A-Za-z_-]{35}/g],
    ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
    ['database-credentials', /postgres(?:ql)?:\/\/[^\s'"<>:/]+:[^\s'"<>@]+@[^\s'"<>]+/g],
    ['groq-api-key', /\bgsk_[A-Za-z0-9_-]{20,}/g],
    ['assigned-secret', /\b(?:GROQ_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY|NETLIFY_AUTH_TOKEN|QAMQOR_DATA_KEYS)\s*(?:=|:)\s*['"]([^'"\r\n]{20,})['"]/g],
];
const sensitivePath = /(?:^|\/)(?:\.env(?:\..+)?|keystore\.properties|local\.properties|credentials[^/]*\.json|service-account[^/]*\.json)$|\.(?:pem|key|p12|pfx|jks|keystore|dump)$/i;

export function findings(source, path) {
    const results = [];
    for (const [rule, expression] of rules) {
        expression.lastIndex = 0;
        for (const match of source.matchAll(expression)) {
            results.push({ path, rule, line: source.slice(0, match.index).split('\n').length });
        }
    }
    return results;
}
export function forbiddenPath(path) {
    return sensitivePath.test(path) && !/(?:^|\/)\.env\.example$/.test(path);
}

export async function scanRepository(root, { history = false, output = console.log } = {}) {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
    const files = [...new Set(git('ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean))];
    let count = 0;
    const report = item => { count++; output(JSON.stringify(item)); };
    for (const path of tracked) if (forbiddenPath(path)) report({ path, rule: 'tracked-sensitive-file' });
    for (const path of files) {
        // Do not open sensitive files just to print a finding. A tracked path alone blocks release.
        if (forbiddenPath(path)) continue;
        const fullPath = resolve(root, path);
        const stat = await lstat(fullPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) continue;
        const buffer = await readFile(fullPath);
        if (buffer.includes(0)) continue;
        for (const item of findings(buffer.toString('utf8'), path)) report(item);
    }
    if (history) {
        const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean);
        const seen = new Set();
        for (const commit of commits) {
            const entries = git('ls-tree', '-rz', commit).split('\0').filter(Boolean);
            for (const entry of entries) {
                const [meta, path] = entry.split('\t');
                const [mode, type, id] = meta.split(' ');
                if (type !== 'blob' || mode === '120000' || seen.has(id)) continue;
                seen.add(id);
                if (forbiddenPath(path)) { report({ commit: commit.slice(0, 12), path, rule: 'historical-sensitive-file' }); continue; }
                const size = Number(git('cat-file', '-s', id).trim());
                if (size > 8 * 1024 * 1024) continue;
                const source = git('cat-file', 'blob', id);
                if (source.includes('\0')) continue;
                for (const item of findings(source, path)) report({ commit: commit.slice(0, 12), ...item });
            }
        }
    }
    output(`Secret scan: ${count} finding(s). Values are never printed. Pattern scanning is not proof of absence.`);
    return count ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.exitCode = await scanRepository(fileURLToPath(new URL('../', import.meta.url)), { history: process.argv.includes('--history') });
    } catch {
        console.error('Secret scan failed; publication must stop. No file contents or credentials are logged.');
        process.exitCode = 1;
    }
}
