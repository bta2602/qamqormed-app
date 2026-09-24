# QamqorMed backend deployment - September 2026

For step-by-step Russian instructions, start with [MIGRATION-RU.md](MIGRATION-RU.md).
The repository now includes a **read-only deployment gate**, `npm run db:check`.
Netlify runs `npm run build:netlify`; local `npm run build` remains credential-free.
The current SQL writes a migration receipt in the same transaction. Earlier ZIPs
may lack this receipt: rerun the complete current SQL, never insert it by hand.
The gate neither migrates the DB nor replaces backup/preflight/credential rotation.
It blocks an incompatible new deploy but does not secure the legacy published one.

## Urgent: published legacy endpoint exposure

Read-only inspection on 2026-09-24 found that the published, unauthenticated
`/.netlify/functions/get-doctors` still returned physician passwords, email
addresses and government IINs. The secure source on disk does not mean the
published site is secure. Do not reproduce the exposed values, log in using
them, or copy the response into tickets, fixtures or this document.

1. The authorized operator must promptly restrict the legacy public endpoint
   and old initialization/seeding routes through hosting access controls or
   maintenance mode. Do not invoke a live legacy `init-db` route to check it:
   even GET may mutate data. Do not leave the old catalogue publicly available
   while preparing the full release.
2. Treat every exposed physician password as compromised. Rotate them through
   a trusted operator-controlled reset process, without authenticating using
   exposed passwords. Use fresh, unique passwords and the local `passwordHash`
   scrypt implementation, never plaintext storage. Revoke all affected sessions
   and increment each affected user's `session_version` atomically with the
   reset after the migration is installed. Coordinate any reused-password
   rotation with account owners. Do not place replacement secrets in shell
   history, source control or chat.
3. Remove or disable all legacy DB initialization and seeding functions in
   every deploy context. This source includes an inert `init-db.mjs` returning
   404 for all methods. Do not bundle an old `init-db.js` alongside it. Do not
   deploy cached `.netlify/functions-serve` output or seed accounts/passwords.
4. Deploy the secure endpoints promptly using the controlled sequence below.
   Review access logs and affected-data scope through the incident-response
   process; local code cannot retract already exposed data.

The local implementation review made **no production DB changes and no deployment**. Local tests
need **no credentials**. No credentials need to be shared with the assistant.
An eventual release must be performed by an authorized operator using their
existing DB and Netlify access.

## Backup and preflight

Preserve the existing source backup at the Android verification directory's
`2026-09-24-next/backend-before`. It is a source backup, not a database backup.
Before any migration or credential reset, take a verified database snapshot
or encrypted PostgreSQL backup, confirm restore access, and retain the exact
currently published deploy identifier. Restrict backup access: legacy passwords
and clinical data may be present. Test restoration into an isolated DB first.

Keep production writes stopped during the final preflight and migration.
Run the following SELECT-only checks on an isolated restoration first. The
operator can repeat them in a read-only production transaction. Do not paste
patient identifiers or query results into public logs. This review did not run
these queries against production.

```sql
BEGIN TRANSACTION READ ONLY;

-- Confirm server version, schema, types and existing constraints first.
SELECT current_database(), current_schema(), version();
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('users', 'appointments', 'analyses', 'chat_messages',
                     'auth_sessions', 'auth_throttle', 'prescriptions',
                     'prescription_schedules')
ORDER BY table_name, ordinal_position;

-- Exact conflicts for the new lower(email) unique index.
SELECT lower(email) AS email_key, count(*) AS accounts, array_agg(id) AS user_ids
FROM users GROUP BY lower(email) HAVING count(*) > 1;

-- Also detect whitespace/normalization conflicts before enabling new logins.
SELECT lower(btrim(email)) AS email_key, count(*) AS accounts,
       array_agg(id) AS user_ids
FROM users GROUP BY lower(btrim(email)) HAVING count(*) > 1;
SELECT id FROM users
WHERE email IS NULL OR btrim(email) = '' OR email <> btrim(email)
   OR password IS NULL OR iin IS NULL OR iin !~ '^[0-9]{12}$';
SELECT iin, count(*) FROM users GROUP BY iin HAVING count(*) > 1;

-- Optional legacy columns are inspected through JSON, so this works before
-- doctor_iin is added. doctor_id must identify users.id, not a UI catalogue ID.
WITH mapped AS (
  SELECT a.id, to_jsonb(a) AS j, u.iin AS legacy_iin
  FROM appointments a
  LEFT JOIN users u ON u.id::text = to_jsonb(a)->>'doctor_id'
)
SELECT id FROM mapped
WHERE (j->>'doctor_id' IS NOT NULL AND legacy_iin IS NULL)
   OR (j->>'doctor_iin' IS NOT NULL AND legacy_iin IS NOT NULL
       AND j->>'doctor_iin' <> legacy_iin)
   OR coalesce(nullif(j->>'doctor_iin', ''), legacy_iin) IS NULL;

-- Missing clinical identities need operator review, never invented mappings.
WITH mapped AS (
  SELECT a.id, a.patient_iin,
         coalesce(nullif(to_jsonb(a)->>'doctor_iin', ''), u.iin) AS effective_iin
  FROM appointments a
  LEFT JOIN users u ON u.id::text = to_jsonb(a)->>'doctor_id'
)
SELECT m.id FROM mapped m
LEFT JOIN users d ON d.iin = m.effective_iin
LEFT JOIN users p ON p.iin = m.patient_iin
WHERE d.id IS NULL OR p.id IS NULL;

-- Conflicts after the legacy doctor_id -> doctor_iin backfill.
WITH mapped AS (
  SELECT a.id, a.date, a.time, a.status,
         coalesce(nullif(to_jsonb(a)->>'doctor_iin', ''), u.iin) AS effective_iin
  FROM appointments a
  LEFT JOIN users u ON u.id::text = to_jsonb(a)->>'doctor_id'
)
SELECT effective_iin, date, time, count(*) AS appointments,
       array_agg(id) AS appointment_ids
FROM mapped WHERE status = 'upcoming'
GROUP BY effective_iin, date, time HAVING count(*) > 1;

-- Check textual date/time representations too. The new API uses YYYY-MM-DD
-- and HH:MM. Confirm column types before deciding whether normalization is
-- needed; native PostgreSQL time columns may display seconds legitimately.
SELECT id, date, time FROM appointments
WHERE status = 'upcoming' AND
  (date IS NULL OR time IS NULL OR date::text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR time::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$');
WITH mapped AS (
  SELECT a.id, btrim(a.date::text) AS day, left(btrim(a.time::text), 5) AS slot,
         a.status,
         coalesce(nullif(to_jsonb(a)->>'doctor_iin', ''), u.iin) AS effective_iin
  FROM appointments a
  LEFT JOIN users u ON u.id::text = to_jsonb(a)->>'doctor_id'
)
SELECT effective_iin, day, slot, count(*), array_agg(id)
FROM mapped WHERE status = 'upcoming'
GROUP BY effective_iin, day, slot HAVING count(*) > 1;

ROLLBACK;
```

Stop on duplicates, ambiguous doctor mappings, missing users, unexpected
schemas or unnormalized values. Have the data owner reconcile them explicitly
in a separately approved maintenance step. **Do not automatically delete,
merge or cancel appointments/accounts.** Check the actual existing `users.iin`
unique constraint and `users.id` integer key. The migration is not a full schema
bootstrap: `users`, `appointments` and `analyses` must already exist. Confirm
`gen_random_uuid()` is available on the target PostgreSQL version.

## Migration and deploy order

1. Keep the legacy routes contained and writes paused. From a clean source
   snapshot, run `npm ci`, `npm test`, and `npm run build`. The local static
   build requires no DB credentials and must not load `.env`. Then verify
   function bundling with a Netlify build using an isolated test database,
   not production configuration. Only the local npm build was run in this
   review; a Netlify build/deploy remains unverified.
2. Test `migrations/20260924_sessions_prescriptions.sql` on the restored DB,
   including a second run. Review differences before production approval.
   It widens password storage, creates stable doctor UUIDs, adds session
   versions/tables and prescription tables, and backfills legacy appointment
   doctor references only when they match actual user IDs. Conflicting or
   orphaned legacy references abort rather than guess. New unique indexes
   deliberately reject duplicate emails/upcoming slots.
3. After explicit operator approval, apply that SQL file to production with
   stop-on-error enabled (for psql: `-v ON_ERROR_STOP=1 -f <migration-file>`).
   The file includes its own BEGIN/COMMIT transaction. On any error, roll back
   and investigate. Do not strip constraints or continue through errors. Index
   creation is not concurrent and may block writes, hence the maintenance
   window and backup.
4. While access is still restricted, complete the trusted physician credential
   reset/revocation process above. Existing plaintext accounts otherwise only
   upgrade their password hash upon successful login; this gradual upgrade
   is **not** a remedy for exposed credentials.
5. Deploy the reviewed website/functions together to Netlify **after the
   migration succeeds**. `session_version` is required by authentication, so
   deploying functions first will fail. Verify functions use the existing
   server-only `NETLIFY_DATABASE_URL`; optional AI needs `GEMINI_API_KEY` and
   optionally `GEMINI_MODEL`. Never publish these variables to Android or
   browser assets. No new API key is needed for the clinic endpoint.
   The schema gate also needs `NETLIFY_DATABASE_URL` in the Netlify build scope
   for the same DB/context as Functions. Do not grant production secrets to
   untrusted pull requests. A failed gate leaves the previous deploy in place;
   restrict that deploy while resolving migration or connection errors.
   Operators may explicitly set server-only `OVERPASS_API_URL` to the full
   HTTPS interpreter URL of an owned/authorized Overpass instance, for example
   `https://overpass.example.invalid/api/interpreter` (a placeholder, not a
   working provider). With the variable unset, the sole default remains
   `https://overpass-api.de/api/interpreter`. Empty/invalid values, non-HTTPS
   schemes, embedded credentials and fragments fail closed with 503 and
   `code: upstream_configuration_error`. Redirects are disabled. A configured
   instance never falls back to the public service, and upstream refusals do
   not cause provider switching. Apply configuration through a new deploy or
   function restart. No owned instance was configured or tested live here;
   this option does not establish that the catalogue is working.
6. Before reopening access, verify the published catalogue has only public
   doctor fields and UUIDs, never passwords, emails or government IINs; verify
   the *new* inert initialization route is deployed. Exercise login/session/
   logout, password changes, access isolation, appointment conflicts and
   prescriptions with authorized disposable test accounts, not exposed
   credentials or real patients' records. These production smoke tests are
   the operator's future work, not actions performed in this review.
7. Release the updated Android client only after the auth backend checks pass.
   **New Android REQUIRES the deployed auth backend.** Client-side profiles,
   roles and IINs are not authentication. The client must retain the issued
   bearer token, handle 401 by signing in again, and clear it on logout. Old
   unauthenticated clients are intentionally incompatible with secure writes.
   Catalogue `iin` and patient-facing `doctor_iin` now carry public UUIDs.
   Patient chat resolves that UUID internally; old IIN-keyed conversation
   storage stays intact. Clinical doctor workflows still use their own IIN
   and the related patient's IIN.

If the release fails, keep maintenance restrictions in place and roll forward
with a secure fix. Do not publicly restore the vulnerable legacy functions as
a rollback. Retain additive tables and newly hashed passwords; the old login
code may not understand hashes. Database restoration is an explicit operator
decision because restoring a snapshot can lose newer records.

## Safe publish configuration

The root `netlify.toml` fixes the build command to `npm run build:netlify`, the static
publish directory to **`public`**, the functions directory to
`netlify/functions`, and function bundling to `esbuild`. `NODE_VERSION = "24"`
pins the build to Node 24.x, matching the locally tested Node v24.13.1 and
satisfying the installed Neon driver's Node >=19 requirement. Check for an
existing hosting runtime override before release; functions normally follow
the build Node version. See [Netlify configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)
and [Node version configuration](https://docs.netlify.com/build/configure-builds/manage-dependencies/).

`scripts/build.mjs` uses only Node filesystem APIs and explicitly copies
`index.html` to `public/index.html` unchanged. It does not enumerate/copy the
source root, read `.env`, inject environment values, or delete recursively.
It refuses a symlink/junction output directory and unexpected output files,
so stale content cannot silently be published. If it refuses a stale
directory, inspect it and remove only explicitly approved generated files;
do not change the publish directory to the source root to work around it.
Generated `public/` is ignored by Git and must be regenerated before release.

The successful static publish artifact contains **only `public/index.html`**.
Never publish the project root or a full source ZIP as static content: `.env`,
migrations, tests, backend source, backups and package metadata stay outside
`public/`. Functions are separately bundled from their configured directory.
The actual static `src`/`href`/CSS URL references are HTTPS-hosted, while local
fetches target `/.netlify/functions/`; no additional local assets are needed.
This checks reference locations, not the availability of third-party assets.
Runtime-supplied image URLs remain outside this packaging check.

## Verification completed locally

- `npm test`: 54/54 passing tests, no skipped tests. PGlite is in memory only.
- 8 deployment-gate tests cover unmigrated databases, atomic receipts,
  reruns, schema drift, missing indexes/receipts, absent credentials, redacted
  connection failures and the successful read-only check. The CLI was also
  checked with the database environment variable removed; it exits 1 without
  connecting. The gate was not run against production from this workstation.
- 22 API tests: hashed passwords; registration cannot assign roles; cookies,
  bearer tokens, expired/revoked sessions; origin checks; catalogue privacy;
  inert seeding route; booking ownership/conflicts; prescribing/scheduling/
  revocation; patient/doctor/admin isolation; analyses and chat; malformed
  results; atomic completion; cancelled/completed care relationships; legacy login upgrades;
  password changes and simulated stale-session issuance; admin revocation
  and clinical-identity deletion guards.
- 8 dedicated clinic tests: independent of DB credentials; own-property city
  allowlist; complete/empty responses; malformed/partial/network/timeout
  errors; rate-limit Retry-After; warm-instance caching/coalescing; safe links
  and coordinates; explicit HTTPS upstream configuration and fail-closed
  invalid configuration with no fallback. An additional API test covers
  partial clinic results.
- 5 migration tests: rerun/backfill preservation; duplicate email and slot
  rollback; conflicting/orphaned legacy mapping refusal; executing the
  documented read-only preflight before and after migration.
- 6 website tests: both inline JavaScript blocks compile with `node:vm.Script`;
  the shared `escapeHTMLtext` helper preserves text while escaping HTML
  syntax/entities; incoming/outgoing history, both `sendMessage` variants,
  AI replies and legacy chat previews/opening render malicious message
  fixtures as escaped text. API requests preserve the original message text.
  The rendering functions run in a VM with DOM stubs, and assertions check
  that injected script/image/SVG markup is absent, not a full browser test.
- `node --check` passed for all 16 backend modules (15 functions plus security).
- 5 packaging tests: deterministic byte-identical HTML-only output; synthetic
  `.env`/source/migration exclusion; refusal of stale output files without
  deleting them; symlink/junction refusal; fixed Netlify settings; and static
  reference checks. Fixture cleanup is limited to known paths, never recursive.
- `npm run build` succeeds on Node v24.13.1. The real output directory contains
  only `index.html`, identical to the source. The real `.env` was not read or
  printed. No dependencies were added for packaging.

## Known limitations

- A direct read-only Astana query to `https://overpass-api.de/api/interpreter`
  returned HTTP 406 with an Apache HTML error page on 2026-09-24. The updated
  local handler still returns 503 with `code: upstream_http_error`,
  `upstreamStatus: 406`, `Retry-After: 60`, and no invented results. The cause
  of the upstream refusal is not established. There are no proxy, identity,
  automatic alternate-provider or retry workarounds. Optional operator-owned
  HTTPS upstream configuration is described above; it is not a fallback and
  does not imply a live working catalogue.
- Successful clinic data is cached for five minutes per warm instance and
  advertises one-hour shared-cache freshness. Failures are not publicly
  cached, but each warm instance observes a cooldown and upstream Retry-After.
  Cold instances do not share a global cooldown. Fixed city rectangles and
  named/geolocated OSM facilities are not an exhaustive or medically verified
  directory. The existing website still contains a static clinic list, outside
  the scoped chat-rendering fix.
- Public Overpass capacity is not a production SLA. Its operator documents
  load shedding and recommends an owned instance for sustained application
  backends: [Overpass resource policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
  Bounding boxes follow the documented south/west/north/east order:
  [Overpass bounding boxes](https://dev.overpass-api.de/overpass-doc/en/full_data/bbox.html).
- **Push FCM is not configured.** This backend stores schedules, not push
  registrations or jobs; it does not deliver remote/background reminders.
  Revoked prescriptions are returned with reminders disabled, but an offline
  client cannot learn about revocation until it synchronizes.
- PGlite tests do not establish actual Neon concurrent-transaction behavior,
  live schema compatibility, Netlify bundling, browser behavior or Android
  device integration. The login race tests simulate interleaving and stale
  session versions, not a live concurrent PostgreSQL workload.
- Registration validates IIN format but does not verify identity or email
  ownership. Completed/upcoming appointments grant the assigned doctor access
  to the patient's analyses; cancelled-only relationships do not. Confirm
  these access/onboarding policies before admitting real patient data.
- Legacy clinical tables still use IIN/email keys without full foreign-key
  coverage. Deletion guards protect known existing clinical identities but
  are not a substitute for archival/identity-retention design or concurrency
  constraints. Authentication rejects stale session versions; a request
  already authorized before revocation may still finish.
- The identified chat-message XSS sinks are fixed in `index.html` using shared
  HTML text escaping: history `msg.text`, optimistic user `text`, AI
  `data.reply`, and legacy last-message previews/opening. Both the legacy
  support sender and the main asynchronous sender are covered. This source
  currently names both sender implementations `sendMessage`; there is no
  separate `sendChatMessage` function. The change is deliberately scoped to
  chat text, not a full frontend security audit. Other rendering contexts,
  URL/attribute handling and inline event handlers remain unreviewed. No
  Android edits were made. Publish the updated HTML alongside secure functions.
- Expired session/throttle rows have no scheduled cleanup yet. The default
  session lifetime is 30 days. Administrative password recovery, MFA and
  comprehensive audit logging are outside this patch.
