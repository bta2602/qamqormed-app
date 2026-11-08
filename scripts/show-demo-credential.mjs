import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataKeyring } from '../netlify/lib/data-crypto.mjs';
import { openVault } from './lib/operator-vault.mjs';
import { productionHost } from './lib/operator-client.mjs';

try {
    // Only the owner explicitly running this command in a local terminal may reveal a demo password.
    if (process.platform !== 'win32' || !process.stdout.isTTY || process.argv.length !== 3 ||
        !['patient','doctor','admin'].includes(process.argv[2])) throw new Error();
    const chunks=[]; let size=0;
    for await (const chunk of process.stdin) {size+=chunk.length;if(size>16384)throw new Error();chunks.push(chunk);}
    const {active,keys}=dataKeyring(JSON.parse(Buffer.concat(chunks).toString('utf8')).env);
    const file=join(process.env.LOCALAPPDATA,'QamqorMed','secrets','production-credentials.vault.json');
    const backup=openVault(JSON.parse(await readFile(file,'utf8')),keys.get(active).toString('base64'));
    if (backup.host!==productionHost) throw new Error();
    const credential=backup.credentials.find(row=>row.role===process.argv[2]);
    if (!credential) throw new Error();
    console.log('Local demo credential. Do not send this output to chat or publish it.');
    console.log('Role: '+credential.role+'\nEmail: '+credential.email+'\nPassword: '+credential.newPassword);
} catch {
    console.error('Open this viewer in a local interactive terminal after the production rotation. No credentials shown.');
    process.exitCode=1;
}
