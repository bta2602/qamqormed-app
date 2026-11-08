# QamqorMed

Website and Netlify API for QamqorMed. PostgreSQL is provided by the existing
Neon integration (`@netlify/neon`). The Android project is maintained separately.

Asem-Ai uses Google Gemini on the server. See the
[Russian Gemini setup guide](GEMINI-SETUP-RU.md) for creating a server-only key,
provider-specific consent, privacy controls and testing before deployment.
This does not migrate or replace Neon. No live AI call is part of the local tests.

## Deployment

**This release is for synthetic demo data only, not real patient records.**
See the [9 November release-readiness report](RELEASE-READINESS-2026-11-09.md)
for migration/deployment evidence, the safe Gemini connection probe and unresolved identity prerequisites.
Read [current blockers](SECURITY-WORK-IN-PROGRESS.md) and the
[encryption and recovery guide](DATA-PROTECTION-RU.md) first.
The new schema migration does not encrypt existing data by itself.
Start with [the Russian migration guide](MIGRATION-RU.md) and the detailed
[deployment/security checklist](DEPLOYMENT-2026-09.md).

The new server uses verified sessions, password hashes, access checks and
prescription/schedule tables. Legacy unauthenticated clients are not compatible
with protected operations. Email verification codes and FCM are not enabled.

Netlify builds `main` using `npm run build:netlify`: it scans current sources for
secrets, verifies the database schema and encrypted-data backfill read-only,
then publishes only the assets explicitly listed in `scripts/public-assets.mjs`.
Functions are bundled separately. Missing keys/migrations or an inaccessible DB block publishing;
it does not disable an already published insecure legacy version.

## Local Verification (No Credentials)

Requires Node 24.x. No `.env` is needed for these commands:

```sh
npm ci
npx playwright install chromium
npm test
npm run security:secrets
npm audit
npm run build
```

Tests use isolated PostgreSQL-compatible fixtures and a local browser with
mocked endpoints. They do not access the production database or AI provider.
Real PostgreSQL concurrency and physical-device integration still need separate
verification. Browser screenshots are written to ignored `verification/`.
`npm run db:check` is separate and requires server-only `NETLIFY_DATABASE_URL`
and encryption key configuration; it never applies a migration.

Do not commit secrets, database dumps, generated `public/`, or `node_modules/`.
Never use the disabled legacy `init-db` endpoint to run migrations.
