# 1230. Server status summary for admins

- Status: Accepted
- Date: 2026-11-08

## Context
An admin learns that backups stopped, the disk is filling up, the app keeps restarting or a security
release is out only by opening Admin › Backups, reading boot logs or watching the repository. The
facts exist in several places (the sidecar's `status.json`, boot warnings, `/api/version/latest`,
the database) but nothing puts them in front of the admin when they open the app.

## Decision
- `GET /api/admin/status` (admins, browser session only: `requireAdmin` refuses bearer tokens and the
  route is also in `tokenPolicy.ts` SESSION_ONLY, docs/adr/1204-*). Rate limit 30/min.
- Five groups — backup, storage, app, security, update — of items `{ key, group, level, data }`.
  Levels: `ok`, `warn`, `error` and `off`. `off` means "not configured, switched off or not
  applicable here" (no sidecar in development, no off-site copy, `UPDATE_CHECK` unset). It is shown
  in grey on the admin cards and never counts as a problem, so a development instance or an
  operator's deliberate choice does not keep a banner up.
- Production-only settings (APP_SECRET_KEY, PUBLIC_URL, Secure cookies, signup policy, database
  password, missing sidecar) are `warn` only when `NODE_ENV=production`, `off` otherwise. Functional
  breakage is reported everywhere (sealed secrets without the key, failed backups).
- Each group carries its worst level and `summary`, the key of its worst warn/error item; the
  response lists all warn/error items as `issues` (errors first) for the banner.
- The server sends keys and structured data only (numbers, ISO times, booleans, short enums); the
  web client writes every sentence in English or Korean. No secret value, file system path,
  database URL or remote name leaves the server; the only URL is a github.com release link.
- Heavy probes (statfs of DATA_DIR and the backup volume, `pg_database_size`, `sum(files.size)`,
  the site-wide large-page count, the stored-secret count, applied migrations) are cached for
  5 minutes with one in-flight computation; `?refresh=1` recomputes. Live facts (sidecar
  `status.json`, process counters, env flags) are read on every request: they cost microseconds and
  a finished backup must not look stale for five minutes.
- The only outbound request stays the opt-in release check (docs/adr/0994-*, 1232-*).

### Criteria

| Item | ok | warn | error | off |
|---|---|---|---|---|
| backup.service | sidecar reports | no `status.json` yet; no sidecar / `BACKUP_ENABLED=0` in production | heartbeat older than 10 min (`currentAlert` kind `sidecar`) | no sidecar / disabled outside production |
| backup.lastRun | newer than 2 × schedule interval + 1 h | older than that (one run missed); no success although the sidecar has run longer than one interval + 1 h; manual-only schedule and older than 7 days | failed run newer than the last success (`currentAlert`); older than 7 days | — |
| backup.verify | last verification passed | — | last verification failed and is not older than the last success | never ran |
| backup.restoreTest | passed within 2 × `BACKUP_RESTORE_TEST_DAYS` | older than that, or never although a backup exists and the sidecar has run that long | last test failed | `BACKUP_RESTORE_TEST_DAYS=0` |
| backup.next | next run time | — | — | `BACKUP_SCHEDULE=off` |
| backup.remote | last copy ok | — | last copy failed | no `BACKUP_RCLONE_REMOTE` |
| backup.encryption | `BACKUP_PASSPHRASE` set | unencrypted sets copied off-site | — | unencrypted, local only |
| storage.dataDisk | otherwise | free < 2 × (DB + uploads) or < 10 % | free < 512 MB or < 3 % | statfs failed |
| storage.backupDisk | otherwise | free < 2 × last set + `BACKUP_MIN_FREE_MB` | free < last set + `BACKUP_MIN_FREE_MB` (the next run fails) | no sidecar |
| storage.database / uploads / largePages | facts (size, files, count of pages ≥ 1 MiB state or ≥ 50k tokens, ADR 1103) | — | — | query failed |
| app.uptime | fact | — | — | — |
| app.restarts | otherwise | ≥ 1 unclean exit in 24 h; ≥ 3 clean restarts in 24 h (production) | ≥ 3 unclean exits in 24 h (crash loop) | boot log not writable; ≥ 3 clean restarts outside production (dev reloads) |
| app.errors | otherwise | ≥ 10 records at level ≥ 50 in 24 h | ≥ 50 in the last hour | — |
| app.migrations | applied = journal entries | — | applied ≠ journal entries | journal or table unreadable |
| security.mode | production | — | — | not production |
| security.secretKey | set | unset (production; plaintext copy count in data) | unset while sealed values exist (they cannot be read) | unset outside production |
| security.publicUrl | set | unset (production) | — | unset outside production |
| security.cookies | Secure | not Secure (production) | — | outside production |
| security.signup | key required / delegated | open signup, or OIDC auto-create without allowed domains (production) | — | outside production |
| security.dbPassword | not weak | empty, same as the user, a common default, or < 12 characters (production) | — | outside production |
| update.check | up to date | newer release | newer release with a Security section | check off, or GitHub unreachable |

## Alternatives considered
- **Reuse each screen's own endpoint in the client** (backups, version, large pages): several
  requests per app load, and boot-time facts (plaintext secrets, restarts) have no endpoint.
- **Push alerts only (notifications/mail, like docs/adr/0607-*)**: right for failures, wrong for
  settings an operator should fix once; and it does not answer "is everything fine?".
- **Three levels only**: development instances and deliberate choices (no off-site copy, restore test
  off) would be a permanent warning, and a banner that is always there is ignored.
- **Server-side sentences**: a second translation table on the server; the web client already owns
  en/ko strings.
- **Cache everything for 5 minutes**: a backup that just finished or a failure that just happened
  would not show until the cache expires.

## Consequences
- Admins see one line when something needs attention and a card overview on the admin page.
- New checks are a fact in `probes.ts`, a rule in `evaluate.ts` (unit-tested) and a text in
  `i18n/*/admin-status.ts`.
- The admin page's Updates card replaces the separate release notice (docs/adr/0993-*: one notice).

## References
- apps/server/src/status/evaluate.ts (rules), probes.ts (facts, cache), routes.ts
- apps/server/src/tokenPolicy.ts, apps/server/src/secretsAtRest.ts (`countSecretsAtRest`)
- apps/web/src/status/ (cards, banner, texts), docs/OPERATIONS.md "Reading the status summary"
- Tests: apps/server/src/status/evaluate.test.ts, status.db.test.ts
