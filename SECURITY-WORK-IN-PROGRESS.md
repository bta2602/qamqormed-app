# Security review checkpoint, 2026-09-25

Latest verification: [release readiness, 2026-11-09](RELEASE-READINESS-2026-11-09.md).
The older verification counts below are retained as a historical checkpoint;
the release report supersedes those counts, not the unresolved security findings.

**Real-patient release remains blocked.** The original checkpoint below predates
the 2026-11-09 demo migration. That migration encrypted covered clinical fields,
rotated 43 legacy user passwords and the old database-owner credential, and
configured a restricted server role. See the release report for deployment status.
The separate Android workspace is `C:/AndroidProjects/QamqorMed/android`.

## Implemented locally

- Server-enforced patient/doctor/administrator roles and account deactivation.
- Shorter staff sessions and revocation following sensitive identity changes.
- Separate administrator medical-record read with password confirmation, purpose
  and fail-closed audit logging. Administrators cannot use ordinary doctor-write/chat APIs.
- Doctor-only official analyses, stable author IDs, completed-record protection,
  prescription schedule/revocation checks and booking conflict constraints.
- Explicit AI transmission consent; no AI transmission if encryption is unavailable.
- Patient recovery request, admin password-confirmed review, 15-minute approval,
  original-request capability, atomic one-time consumption and session revocation.
  No direct email/IIN login, staff recovery or administrator-chosen replacement password.
- AES-256-GCM for clinical text, analysis results, prescription descriptions,
  chat and blood group, with row/table/field authentication and versioned server keys.
- Schema migration plus a separate dry-run-first encrypted-data migration utility.
  The utility verifies round trips, uses compare-and-update within serializable batches,
  and restores completed-record protection in the same transaction.
- Current-source and local-history secret scans with redacted findings, ignore rules
  for secrets/backups/signing material, and an explicit public-asset build allowlist.
- Cookie-based modular website and Android staff/recovery workspaces, RU/KK interfaces,
  dark theme, duplicate-submit protection and back-navigation fix.
- Website upgrade removes known legacy identity/email/notification localStorage caches,
  without clearing unrelated storage or trusting a saved role.
- Read-only deployment gate requires keys, schema and absence of legacy clinical
  plaintext; the normal build does not run SQL migrations or data conversion.

## Critical findings and publication blockers

1. A Google API key occurs in local Git history: commit `42b629415068`,
   `netlify/functions/chat.mjs:30`. Its value was not printed or exercised.
   The owner confirmed revocation on 2026-11-09; no live validation of the old
   credential was attempted. The restored Gemini integration requires a
   new server-only `GEMINI_API_KEY`; never reuse the revoked credential.
   Ignore rules do not remove old commits. History was not rewritten.
2. Previous legacy password disclosure was remediated for the 43 affected demo
   accounts on 2026-11-09; saved new credentials were checked against their hashes.
   The old database-owner credential was rotated and other owner sessions closed.
   Legacy deployments cannot authenticate to the database using that credential.
3. Identity enrollment is still unverified: public registration accepts a supplied IIN.
   It must not grant access to real historical medical records without independent
   proof of ownership. This remains a real-patient release blocker. On 2026-11-09
   the owner confirmed the current database contains only synthetic demo data;
   that does not authorize introducing real patient records into this workflow.
4. Manual recovery approval is not identity proof. An attacker can submit another
   person's email/IIN from their own device. Mistaken approval would grant access.
   The user chose a hobby/demo workflow without an email service, not a verified
   recovery channel. Use synthetic data until independent verification exists.
5. Production encryption keys are now configured, with a verified encrypted vault
   and DPAPI copy. Covered fields in existing clinical records were migrated and
   round-trip verified. Copy the encrypted backups to independent storage; the
   local disk and a snapshot in the same Neon account are not independent copies.
6. IIN, name, email, relationships, schedules and metadata are NOT field-encrypted.
   A separate compatibility/search/linkage migration is required. Do not call this
   whole-database encryption or rely on it as comprehensive PHI protection.

Read [the operator guide](DATA-PROTECTION-RU.md) before any schema/data changes.
Do not create fake migration receipts, delete conflicting clinical data or disable
the build gate to publish this draft.

## Verification

- The complete local Node suite passes: 99 tests, zero failures/skips. It covers API authorization, session/recovery lifecycle,
  migrations, encryption, deployment gates, secret-output redaction, public assets
  and Chromium workflows using synthetic fixtures.
- Browser endpoints are mocked. Recovery, admin review, XSS-safe message rendering,
  history Back, RU/KK/dark layouts and legacy cache removal are covered.
  Mobile home and recovery screenshots were inspected; this is not a complete
  visual or functional audit of every redesigned screen.
- Android `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` succeeds:
  62 unit tests, zero failures/errors/skips. Lint has zero errors and 31 warnings,
  including dependency, orientation, API and unused-resource advisories.
- Current website source scan: zero pattern findings. Android source scan:
  111 Kotlin/Gradle/XML/TOML files, zero pattern findings.
- Local Git history scan: one finding above, expected nonzero exit status.
- npm dependency audit: zero reported vulnerabilities. This is not proof that
  the application is secure, and it does not audit the Android dependency graph.
- Debug APK was built, not published or installed on a physical device this turn.
  It expects the changed server API; do not distribute it as a production update.

## Remaining engineering checks

- Test real PostgreSQL two-connection clinical-write/revocation/recovery interleavings.
  PGlite tests are not evidence of production concurrency guarantees.
- Verify migration/backfill, key rotation, key-loss recovery and protected backup
  restoration on a staging database. Restrict runtime DB privileges separately
  from the operator role that performs ALTER and maintenance.
- Test complete website/Android workflows against the same staged API and on
  physical devices, including keyboard, accessibility, process recreation,
  permissions, notifications and denial/revocation while a request is in flight.
- Review trusted initial staff activation; an admin-set initial password is not
  independent evidence of a doctor's identity.
- Extend schema checks to every base-column/foreign-key dependency and verify
  index/trigger definitions, not only their names/presence. Review row-level
  database controls and bounded medical-record pagination.
- Current booking hours are a validation grid, not a doctor's availability feed.
- UI refresh is a local draft, not a verified claim of complete website/Android
  feature parity. 90-120 FPS and every-screen reliability have not been measured.

## Unavailable integrations

No eGov identity verification, ID-document upload/OCR, email-code verification,
automatic recovery email or new push provider was connected. OCR by itself cannot
prove document ownership. Before handling ID documents, agree trusted verification,
access, consent, storage, retention and deletion rules. Do not send document images
or private signing keys in chat.

Smart Bridge organization onboarding and access to the required service remain
external prerequisites; no provider credentials or technical contract are available.

- https://sb.egov.kz/blog/ru/post/cmjr7d64g0004n7z3mjuwru82
- https://sb.egov.kz/blog/ru/post/cmnoga9y5000007p4tc93wxmx
