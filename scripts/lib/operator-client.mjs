import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { neon } from '@netlify/neon';

export const siteId = '0a35a102-63e3-43ab-941e-807d11aa5e39';
export const productionHost = 'ep-shiny-recipe-aebz3yiw.c-2.us-east-2.aws.neon.tech';
export const stagingHost = 'ep-gentle-mouse-aen32wxj.c-2.us-east-2.aws.neon.tech';

// Operator-only tooling: reuse the installed CLI's authenticated client; never put tokens in command arguments.
export async function operatorClient() {
    const cliRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'netlify-cli');
    const require = createRequire(join(cliRoot, 'package.json'));
    const { NetlifyAPI } = require('@netlify/api');
    const { getToken } = await import(pathToFileURL(join(cliRoot, 'dist', 'utils', 'command-helpers.js')));
    const [token] = await getToken();
    if (!token) throw new Error('Operator authentication unavailable');
    const api = new NetlifyAPI(token);
    const site = await api.getSite({ site_id: siteId });
    if (site.id !== siteId || site.name !== 'qamqor-med' || site.ssl_url !== 'https://qamqor-med.netlify.app') {
        throw new Error('Unexpected deployment target');
    }
    return { api, site };
}

export async function operatorDatabase(target = 'staging') {
    if (!['staging', 'production'].includes(target)) throw new Error('Invalid database target');
    const { api, site } = await operatorClient();
    const vars = await api.getEnvVars({ accountId: site.account_slug, siteId });
    const variable = vars.find(v => v.key === 'NETLIFY_DATABASE_URL_UNPOOLED');
    const connection = variable?.values?.find(v => v.context === 'production')?.value ??
        variable?.values?.find(v => v.context === 'all')?.value;
    const url = new URL(connection ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== productionHost ||
        url.pathname !== '/neondb' || !url.password || url.searchParams.get('sslmode') !== 'require') {
        throw new Error('Unexpected database configuration');
    }
    if (target === 'staging') url.hostname = stagingHost;
    return { sql: neon(url.toString()), url: url.toString(), host: url.hostname };
}
