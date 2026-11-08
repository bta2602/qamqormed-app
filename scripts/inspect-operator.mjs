import { operatorClient, operatorDatabase, siteId } from './lib/operator-client.mjs';

try {
    const { api, site } = await operatorClient();
    const variables = await api.getEnvVars({ accountId: site.account_slug, siteId });
    console.log(JSON.stringify({ check: 'netlify', site: site.name, variables: variables.map(v => ({
        key: v.key, secret: v.is_secret === true, scopes: v.scopes,
        contexts: v.values?.map(value => value.context),
    })) }));
    const { sql, host } = await operatorDatabase('staging');
    const rows = await sql`SELECT (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM appointments) AS appointments, (SELECT count(*)::int FROM analyses) AS analyses`;
    console.log(JSON.stringify({ check: 'staging_connection', host, counts: rows[0] }));
} catch {
    console.error(JSON.stringify({ check: 'operator_access', status: 'failed', reason: 'Check local CLI authentication and approved database target; details redacted' }));
    process.exitCode = 1;
}
