# QamqorMed

Website and Netlify API for QamqorMed. PostgreSQL is provided by the existing
Neon integration (`@netlify/neon`). The Android project is maintained separately.

## Deployment

**Apply the reviewed SQL migration before publishing these functions.**
Start with [the Russian migration guide](MIGRATION-RU.md) and the detailed
[deployment/security checklist](DEPLOYMENT-2026-09.md).

The new server uses verified sessions, password hashes, access checks and
prescription/schedule tables. Legacy unauthenticated clients are not compatible
with protected operations. Email verification codes and FCM are not enabled.

Netlify builds `main` using `npm run build:netlify`: it verifies the database
schema read-only, then publishes only `public/index.html` and bundles the
functions separately. A missing migration or inaccessible DB blocks publishing;
it does not disable an already published insecure legacy version.

## Local Verification (No Credentials)

Requires Node 24.x. No `.env` is needed for these commands:

```sh
npm ci
npm test
npm run build
```

Tests use isolated in-memory PostgreSQL-compatible fixtures. They do not access
the production database. `npm run db:check` is separate and requires the existing
server-only `NETLIFY_DATABASE_URL`; it never applies a migration.

Do not commit secrets, database dumps, generated `public/`, or `node_modules/`.
Never use the disabled legacy `init-db` endpoint to run migrations.
