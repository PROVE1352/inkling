# Operations: deployment checklist, performance, caches and database tuning

Companion to `deploy/DEPLOY.md` and `docs/BACKUP.md`. Design records: `docs/adr/0750`–`0759`. Known, accepted issues: [KNOWN-ISSUES.md](KNOWN-ISSUES.md). 한국어: [OPERATIONS.ko.md](OPERATIONS.ko.md).

## 0. Deployment checklist

### Before first deploy

- [ ] Run behind TLS: `docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d`. Never expose the base compose's `3000:3000` to the internet (plain HTTP).
- [ ] Set a strong `POSTGRES_PASSWORD` in `.env` (required; compose does not start without it).
- [ ] Set `PUBLIC_URL` (or `APP_URL`) to the external origin. Example: `PUBLIC_URL=https://notes.example.com`. It is the only source for mail links, the OAuth issuer and `og:url`; the `Host` header is never trusted for them. When SMTP mail is enabled and neither variable is set, the server refuses to boot.
  Browsers opening the app under any other origin (a LAN IP, another domain) can read but every write is refused with 403 `CROSS_SITE_REQUEST` (docs/adr/1062-*).
- [ ] Set `APP_SECRET_KEY` (≥ 32 characters, `openssl rand -base64 32`) before anyone turns on two-step verification, and store it outside the database/data backups. Changing it makes existing two-step setups unreadable (recovery codes and the admin reset still work). From 0.5.0 it also seals the "copy link" copies of share links, invite codes and signup keys and the webhook and sheet-sync URLs; without it those copies and URLs stay in plaintext (boot warning) and are sealed at the first boot after the key is set (docs/adr/1110-*, 1111-*).
- [ ] Cookies: when `PUBLIC_URL` is `https`, session cookies are `Secure` automatically. `COOKIE_SECURE` is passed through from `.env` (default `0`); the Caddy overlay sets it to `1`.
- [ ] Signup keys: with `NODE_ENV=production`, signups require a signup key unless `SIGNUP_REQUIRE_KEY=0` is set explicitly. Create the first admin's key with `./deploy/signup-key.sh new "<name>"` (the server logs this hint at boot).
- [ ] OpenID Connect sign-in (optional, deploy/DEPLOY.md "3-G"): register `<PUBLIC_URL>/api/auth/oidc/callback` at the provider and set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. A half-filled set or a missing `PUBLIC_URL` stops the boot. Signup keys do not apply to it: with `OIDC_AUTO_CREATE=1` also set `OIDC_ALLOWED_DOMAINS`. Keep `OIDC_LINK_EXISTING=0` unless the provider verifies email addresses (docs/adr/1161-*), and decide whether workspace two-step verification may trust the provider (`OIDC_REQUIRE_MFA`, docs/adr/1162-*). Sign in once as the first admin with a password before turning on `OIDC_AUTO_CREATE` on an empty instance.
- [ ] Semantic search (optional, off by default, section 5): set `EMBEDDING_URL` and `EMBEDDING_MODEL` only if you want find_context to also rank by meaning. Chunk text is sent to that endpoint; with a hosted provider that is a third party, so prefer a local model server when notes must not leave the machine. A half-filled set stays off with one boot warning (docs/adr/1740-*).
- [ ] Slack app (optional, section 6): needs `PUBLIC_URL` with a domain name (link unfurls and the `/inkling link` URL) and `APP_SECRET_KEY` (otherwise the bot token and signing secret are stored unencrypted; the settings page warns). No Slack variable is needed: each workspace owner pastes their own app's token and secret in Workspace settings → Slack.
- [ ] Set `TZ` to the users' timezone (reminders, daily notes, the backup schedule and GFS buckets use it). Compose defaults to `UTC`; a Korean deployment sets `TZ=Asia/Seoul`.
- [ ] Set `DEFAULT_LOCALE` (`en` | `ko`, default `en`): language of emails and built-in templates for users who have not chosen one, and the web UI default before the browser language (docs/adr/0901-*, 0903-*). A Korean deployment sets `DEFAULT_LOCALE=ko`.
- [ ] All server environment variables are passed through `compose.yaml` as `${X:-}`, so setting them in `.env` is enough (`.env` itself is not copied into the image). If you use a `compose.override.yaml`, check that it does not replace the `environment:` entries you need.
- [ ] Confirm `NODE_ENV=production` in the running container (it also disables loopback test switches such as `WEBHOOK_TEST_ALLOW_LOOPBACK`).
- [ ] Decide `BACKUP_PASSPHRASE` and store it outside the server; losing it makes encrypted sets unrecoverable.
- [ ] Configure an off-site copy (`deploy/compose.backup-rclone.yaml`); local backup sets live on the same disk as the database.

### Resource limits

- [ ] Host disk: keep at least 2x (database size + data volume) free; backups, the weekly restore test and uploads share it.
- [ ] Raise `BACKUP_MIN_FREE_MB` above the 256 MB default on small disks. Backup prune runs before the free-space check (the newest set is always kept), so a full disk no longer blocks pruning.
- [ ] Container memory: `APP_MEM_LIMIT` / `NODE_OPTIONS` and `PG_MEM_LIMIT` / `PG_SHM_SIZE` (see sections 1 and 2); backup sidecar 256m.
- [ ] Base `compose.yaml` services share the `x-logging` anchor; overlay files (Caddy, rclone) cannot reuse it, so give their services their own `logging:` block.
- [ ] Import limits: folder depth 32, pages created per import capped by `IMPORT_MAX_PAGES` (default 5000), zip entries measured by actual decompressed bytes. Size caps are env-configurable: `IMPORT_MAX_UPLOAD_MB` (25), `IMPORT_MAX_UNPACKED_MB` (50), `IMPORT_MAX_ENTRY_MB` (25), `IMPORT_MAX_FILES` (300). Raising them for Notion exports raises peak memory by about the upload size (twice for nested part archives); see docs/adr/0961-*.
- [ ] Heavy-job cap (docs/adr/1240-*): imports (Markdown, zip, Notion, folder), zip exports and subtree duplicates take one of `HEAVY_JOBS_MAX` slots (default 2; set `1` on containers under 768 MB or when the `IMPORT_MAX_*` caps are raised). Others wait in a fair queue of `HEAVY_JOBS_QUEUE_MAX` (16) for at most `HEAVY_JOBS_WAIT_MS` (60000) and then get `503 HEAVY_JOBS_BUSY` with `Retry-After`; one person may have `HEAVY_JOBS_PER_USER` (2) running or waiting, one more gets `429 HEAVY_JOBS_PER_USER`. A zip export holds its slot until the download ends or the client disconnects. The limits are per process.

### Database timeouts

The app sets these on every pool connection: `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 60 s, `lock_timeout` 10 s, and a 10 s `connect_timeout`. Do **not** set them at role or database level: the backup sidecar's `pg_dump` uses the same role. The backup scripts export `PGOPTIONS` with `statement_timeout=0`.

### Shutdown and crashes

- `stop_grace_period: 30s` is set on `app` in `compose.yaml`. On SIGTERM the app stops accepting collaboration upgrades, flushes open documents (10 s cap), closes HTTP (bounded), stops the optional semantic indexer (2 s; an embedding request in flight is abandoned), then closes the database pool. A 25 s watchdog forces exit.
- `unhandledRejection` is logged and the process keeps running. `uncaughtException` is logged and triggers the graceful shutdown above; the container restart policy brings the app back.
- Since 0.15.1 a document save that failed after its retries is retried in the background (5 s, doubling up to 60 s), and a page with unsaved changes stays in memory until a save succeeds, also after its last editor left. The single-instance lock is released last, after open documents are saved (section 9, docs/adr/1921-*, 1925-*).
- A crash or kill (OOM, power loss, `docker kill`) still loses what was typed in the last 2–10 s (the store is debounced); a graceful stop saves everything first. Pages whose index pass was lost in a crash are re-indexed at the next boot (section 9).

### Monitoring

- [ ] `GET /api/health` is liveness only. `GET /api/health/ready` runs `select 1` with a 2 s timeout (cached 5 s) and returns 503 when the database is unreachable; use it for external monitors. The compose healthcheck can keep using `/api/health`.
- [ ] Docker does not restart `unhealthy` containers; use an external monitor or autoheal.
- [ ] Watch for app restarts: a crash loop usually means the database is down or its disk is full.
- [ ] Admin › Backups shows the last success, the last restore test and the sidecar heartbeat.
- [ ] Check free disk weekly.

### Reading the status summary

Admins see a server status summary at the top of **Admin**, and a one-line banner at the top of the
app when something needs attention (docs/adr/1230-*, 1233-*). The same data is
`GET /api/admin/status` (admin, browser session only; `?refresh=1` skips the 5-minute cache).

- **Colours.** Green = ok, amber = warning, red = problem, grey = switched off or not set up here.
  Grey rows never raise the banner. Outside `NODE_ENV=production` the settings checks (secret key,
  `PUBLIC_URL`, cookies, sign-ups, database password, missing sidecar) are grey: they are meant for
  the production server.
- **The banner** shows the first problem and how many more there are. A problem (item + level) is
  shown at most once a day per admin and browser; a new problem, or a warning that becomes a
  problem, shows at once. Opening Admin counts as seeing them. Closing it hides it for the session.
- **Freshness.** Disk space, database size, uploads, large pages, stored secrets and migrations are
  measured at most every 5 minutes ("Checked … ago", **Check again** to measure now). Backup state,
  restarts, errors and settings are read on every request.

| Card · row | What it means | What to do |
|---|---|---|
| Backups · Backup service | The sidecar's heartbeat (every 60 s). Red after 10 minutes of silence. | `docker compose ps backup`, `docker compose logs backup` (BACKUP.md "Troubleshooting"). |
| Backups · Last backup | Amber when one scheduled run was missed (older than 2 × the schedule interval + 1 h), red when the last run failed or the newest set is over 7 days old. | Admin › Backups shows the failure message; fix it, then **Back up now**. |
| Backups · Verification / Restore test | Red when the last check failed; the restore test is amber when older than 2 × `BACKUP_RESTORE_TEST_DAYS`. | `./deploy/backup.sh restore-test`, BACKUP.md "What a backup set contains" (**Restore test**). |
| Backups · Off-site copy / Encryption | Grey when no `BACKUP_RCLONE_REMOTE` (still worth fixing: 3-2-1 rule). Encryption is amber only when unencrypted sets are copied off-site. The passphrase itself is never shown. | BACKUP.md "Off-site copies with rclone", "Encryption". |
| Storage · Data disk | Free space on the `DATA_DIR` volume. Amber below 2 × (database + uploads) or 10 %, red below 512 MB or 3 %. | Free space or grow the disk before the database runs out (section "Incidents"). |
| Storage · Backup disk | Amber below 2 × the last set + `BACKUP_MIN_FREE_MB`, red when the next run would not fit. "Same disk as the data" means one disk holds both. | Lower `BACKUP_KEEP_*`, move the backup volume, add an off-site copy. |
| Storage · Database / Uploads / Large pages | Facts. Large pages (≥ 1 MiB of state or ≥ 50k tokens, docs/adr/1103-*) are listed per workspace in its settings. | Split long logs into subpages. |
| App · Restarts in 24 h | From `DATA_DIR/status/boots.json`. Amber at any restart without a clean shutdown (OOM kill, crash, `docker kill`), or at 3 clean restarts in production; red at 3 unclean ones (crash loop). Deploys count as clean restarts. | `docker compose logs --tail 200 app`; exit 137 = memory (section 2). |
| App · Errors logged in 24 h | Log records at level error/fatal. Amber at 10 in 24 h, red at 50 in one hour. Only the count is kept. | `docker compose logs app \| grep '"level":50'`. |
| App · Database schema | Applied migrations vs. the ones this server ships. Red when they differ (e.g. a database restored from a newer release). | Upgrade to the release that wrote the database (section "Upgrades"). |
| App · Web push | Devices, failing devices and deliveries given up in 24 h (0.18). Grey with `WEB_PUSH=off`; amber at 20 given up in 24 h, or "Cannot send: VAPID key problem (…)". | Section 12 "Web push": egress to the push services, `APP_SECRET_KEY`, the VAPID env pair. |
| App · Database automations | Rules on, runs queued, runs failed in 24 h (0.18). Grey when there are no rules; amber when a due run has waited 15 minutes or more ("the automation queue is not keeping up"). | Section 12 "Database automations"; look for a rule in a loop or a slow webhook. |
| Security settings | Amber in production when `APP_SECRET_KEY` or `PUBLIC_URL` is missing, cookies are not `Secure`, anyone can sign up (`SIGNUP_REQUIRE_KEY=0`, or `OIDC_AUTO_CREATE=1` without `OIDC_ALLOWED_DOMAINS`), or the database password is empty, equal to the user name, a common default or shorter than 12 characters (judged on the server; the value is never shown). Red when sealed secrets exist but `APP_SECRET_KEY` is gone. | Section 0 "Before first deploy". |
| Updates | Grey unless `UPDATE_CHECK=github`. Amber when a newer release exists, red when a release newer than this server has a "Security" section in its notes (docs/adr/1232-*). | Section "Upgrades". |

### Upgrades

Releases are published as a multi-arch image, `ghcr.io/prove1352/inkling:<X.Y.Z>` (also `X.Y` and
`latest`; docs/adr/1050-*). The procedure, with your `-f` files added to each compose command:

```bash
./deploy/backup.sh                 # 1. backup (ends with "ok set=<id> ...")
git pull                           # 2. compose files and deploy scripts of the new release
#    optional: INKLING_VERSION=X.Y.Z (or X.Y) in .env to pin the release (empty = latest)
docker compose pull app            # 3. fetch the image
docker compose up -d app           # 4. restart; migrations run in one transaction at boot
docker compose logs --tail 50 app  #    check the migration result and "Server listening"
```

- Source builds use `compose.build.yaml` (or its two lines in `compose.override.yaml`) and
  `up -d --build app` instead of steps 3–4 (deploy/DEPLOY.md "Image or source build", docs/adr/1051-*).
- Moving from source builds to the published image changes no data. Do not pull a release older than
  the code that last migrated the database (an install built from `main` after the latest release waits
  for the next release).
- No downgrades: an older release does not know the newer schema. Roll back by restoring the backup from
  step 1 and pinning `INKLING_VERSION` to the old release.
  From 0.5.0 this matters more: page states are written in Yjs V2 and share links, invite codes and
  signup keys are kept as hashes, which 0.4.x cannot read. If newer edits must survive a rollback, stop
  the server, run `apps/server/scripts/states-to-v1.ts` (try `--dry-run` first) and accept that existing
  share links, invite codes and signup keys stop working (docs/adr/1101-*, 1110-*).
- Every release is tested for an upgrade from each earlier release, with data, before its image is
  published (`.github/workflows/upgrade.yml`, docs/adr/1052-*).
- 0.14 → 0.15 applies 4 migrations (43 → 47 rows in `drizzle.__drizzle_migrations`): `0043_v015_slack`,
  `0044_wave13_forms`, `0045_wave13_verify_present_status` and `0046_wave13_team_agents`. All four only add tables,
  nullable columns or columns with a constant default (metadata-only on Postgres 11+) and an index on an all-NULL
  column, with no backfill, so they are safe inside the boot transaction. No new environment variable is required.
- 0.15 → 0.15.1 applies 1 migration (47 → 48 rows): `0047_v0151_index_stamp` adds the nullable column
  `page_chunk_index.doc_updated_at` and fills it from `page_docs.updated_at` for existing rows (one UPDATE, one row
  per page), so the first boot re-indexes nothing. It assumes the 0.15 process stopped gracefully (it flushes its
  queued index passes on SIGTERM); `docker compose up -d app` does that. New, optional: `SINGLE_INSTANCE` and
  `SINGLE_INSTANCE_WAIT` (section 9). Vaults synced with an older server need no action: the first `inklingctl sync`
  after the upgrade re-reads pages changed since the last sync and merges notes edited locally once, without
  overwriting anything or marking a conflict (docs/adr/1920-*).
- 0.15.1 → 0.16 applies 3 migrations (48 → 51 rows): `0048_wave16_taint` (table `connection_taints`, column
  `workspaces.agent_taint_demote` with the constant default `true`), `0049_wave16_agent_tokens` (`oauth_grants.kind`
  with the constant default `'oauth'`, nullable `oauth_grants.token_prefix`) and `0050_wave16_agent_uploads` (nullable
  `workspaces.agent_uploads` and `files.uploaded_via`, and a partial index on `files` over rows where `uploaded_via`
  is set, which is none at upgrade time). No backfill. New dependency `unpdf` 1.9.1 in the image (pure JavaScript, no
  system package). New, optional: `AGENT_UPLOADS`, `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB` (section 10). After
  the upgrade, agents that read suspicious text only suggest for an hour in every workspace (section 10).
- 0.16 → 0.17 applies 3 migrations (51 → 54 rows): `0051_v017_collection_rows` (`collections.row_seq` with the
  constant default `0`; nullable `pages.row_number`, `pages.edited_by` with a foreign key, `pages.edited_via`; a partial
  unique index on `pages (parent_id, row_number)` over rows with a number, which is none at upgrade time; three
  triggers that hand out ID numbers), `0052_page_link_sections` (nullable `page_links.sections`) and
  `0053_v017_snapshot_steps` (nullable `page_snapshots.digest` and `step`). No backfill; building the empty index and
  checking the new foreign key read `pages` once inside the boot transaction. New dependency `mermaid` 12.3.0 in the
  web bundle only (section 11). New, optional: `INKLING_PORT`, `INKLING_DB_PORT` (compose). Every agent write now
  stores a version row (section 11); zip imports refuse unsafe archives; a server with no account prints a setup link
  at boot.
- 0.17 → 0.18 applies 5 migrations (54 → 59 rows): `0054_w18_web_push` (tables `push_subscriptions`,
  `push_vapid_keys`, `push_settings`), `0055_w18_automations` (`collection_automations`, `automation_runs`),
  `0056_offline_doc_gen` (`pages.doc_gen integer not null default 0`, a constant default), `0057_workspace_listings`
  (`workspace_list_groups`, `workspace_listings`) and `0058_row_number_tid` (a new body for the trigger function
  `inkling_row_number()`; no table, index or trigger definition changes). No backfill; they run in milliseconds. No
  new dependency. New, optional: `WEB_PUSH`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
  `WEB_PUSH_ALLOWED_HOSTS`, `OAUTH_CIMD`, `OAUTH_CIMD_ALLOWED_HOSTS` (section 12; `compose.yaml` passes them through).
  After the upgrade: tell people to reload every open tab and installed app before they use button blocks (a 0.17
  client that edits a page with a button deletes it); web push needs outbound HTTPS from the server to the push
  services and makes its VAPID key on first use; `/push-sw.js` is served `no-cache` (section 4); the web clipper's
  "Article text" makes outbound HTTP(S) requests; a 15-minute automation timer runs per process. Nothing else changes
  for people until they turn something on.
- 0.18 → 0.19 needs one line in `.env` before compose starts again: `INKLING_DATA_NAME=nodian` on an existing
  install (see "Upgrading to 0.19" below), then optionally `deploy/rename-from-nodian.sh`. It applies 2 migrations
  (59 → 61 rows in `drizzle.__drizzle_migrations`): `0059_share_allow_download` adds
  `pages.share_allow_download boolean not null default false` (a constant default: metadata-only, no backfill,
  milliseconds), and `0060_onboarding` creates `user_onboarding` and inserts one `{"legacy": true}` row per existing
  account (one INSERT…SELECT over `users`). No new dependency. New: `INKLING_DATA_NAME` (required), and the optional
  `ONBOARDING`, `ONBOARDING_EXISTING_USERS` (section 13). Going back to 0.18.0 after 0059 alone needed no restore:
  0.18.0 started on the 60-row database (the extra column has a default and 0.18.0 does not read it; checked on a
  near-empty database, KNOWN-ISSUES SHARE-5). With 0060 as well it was not checked again (ONBOARD-5).

- [ ] Take a manual backup first: `./deploy/backup.sh`.
- [ ] Do not deploy during the backup window (default 03:00).
- [ ] Never run `drizzle-kit push` against production (see section 1).
- [ ] Single app instance only: reminders, sheet sync, the webhook queue, Hocuspocus state and the hourly cap of public form answers are per process. Since 0.15.1 the server refuses to start while another Inkling process uses the same database (section 9).
- [ ] After an upgrade, check the boot log for migration success and the list of enabled experimental features.

### Upgrading to 0.19: the nodian → inkling names

Up to 0.18 the compose project, the volumes, the database role and the database were all named `nodian`, the
project's old name. From 0.19 they come from `INKLING_DATA_NAME` in `.env` (docs/adr/2340-*): `inkling` gives
project `inkling`, volumes `inkling_inkling-db`, `-data`, `-backups`, `-backup-ctl`, role and database `inkling`;
`nodian` gives exactly the names of 0.18. The variable has no default, so an install that upgrades without
reading this does not come up on new, empty volumes: every compose command refuses before it creates or stops
anything, and the running stack keeps running:

```
error while interpolating name: required variable INKLING_DATA_NAME is missing a value: set INKLING_DATA_NAME
in .env: nodian if this server ran Inkling 0.18 or older (keeps its data), inkling for a new install. ...
```

Two ways on, both supported:

1. **Keep the old names** (no data moves): add `INKLING_DATA_NAME=nodian` to `.env` and upgrade as usual.
   Containers, volumes and backups stay what they were. Supported at least until 1.0; dropping it would be
   announced in the CHANGELOG one minor release ahead.
2. **Move to the new names**, any time after step 1 (recommended order: the upgrade first, checked, then the
   rename, so a migration and a rename never happen in one go):

```bash
./deploy/backup.sh
printf '\nINKLING_DATA_NAME=nodian\n' >> .env       # 1. keep the old names for the upgrade
git pull                                         #    (or copy the new release's files)
docker compose pull app && docker compose up -d  #    or `up -d --build` for source builds
./deploy/rename-from-nodian.sh --dry-run         # 2. plan: volumes, sizes, free disk, downtime
./deploy/rename-from-nodian.sh                   #    the rename (asks once)
```

What `deploy/rename-from-nodian.sh` does (docs/adr/2341-*), with the compose files you use (an override is read
as usual; otherwise `COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/…`):

- Stops the app (it saves open documents), takes a pre-rename backup through the backup sidecar (or a `pg_dump`
  into `./backups/rename-nodian-to-inkling/` when no sidecar runs), records every table's row count, and stops
  the stack (`down`, never `-v`).
- **Copies** every volume whose name changes (database, data, backups, backup control, the rclone binary,
  Caddy's certificates) into a volume with the new name. The old volumes are only read; it never changes or
  deletes them.
- Renames the role and the database inside the copy, on a temporary server with no network, and sets the role's
  password again from `POSTGRES_PASSWORD` in `.env` (renaming clears an MD5 password; a SCRAM one would survive).
  Ownership, grants, sequences and the `pg_trgm` extension follow the role. Row counts must match.
- Sets `INKLING_DATA_NAME=inkling` in `.env` (a copy of the old `.env` stays in
  `./backups/rename-nodian-to-inkling/env.before`), starts the stack with the same image, and checks
  `/api/health/ready`, migrations, accounts, pages, collection rows, share links, files and one backup under the
  new role.

Downtime is the app stop, the dump, the copy and a boot: about a minute for a server with a 65 MB dump;
`--dry-run` prints the estimate for yours. It needs free space for a copy of the volumes plus a dump, and
warns below twice the volumes' size. Interrupted, or failed halfway: run it again and it continues. Back to the
old names at any point, also after it finished: `./deploy/rename-from-nodian.sh --rollback` (what was written
under the new names since then is not in the old volumes). When all is well for a few days, delete the old
volumes with the `docker volume rm …` line it printed.

Notes:
- A local trial (`deploy/local.sh`) needs nothing: the new `local.sh` adds `INKLING_DATA_NAME=nodian` to the
  `.env` it wrote. Plain `docker compose` there before running `local.sh` once asks for the line like anywhere.
- `COMPOSE_PROJECT_NAME` or `-p` keep working: the project stays yours, only the volume, role and database names
  change.
- An override that names old volume keys (`nodian-data:/…`) must use the new ones (`data`, `db`, `backups`,
  `backup-ctl`, `rclone-bin`); compose says "undefined volume" until then. The script lists such lines.
- `POSTGRES_USER`/`POSTGRES_DB` in `.env` were never read by compose and still are not; delete them.
- Cron lines or other stacks that call containers by name (`nodian-backup-1`, `nodian-app-1`) need the new
  names (`inkling-backup-1`, …). The rclone remote path (`BACKUP_RCLONE_REMOTE`) does not change.
- Set `inkling` on an old server by mistake: compose starts an empty `inkling` project next to the untouched old
  volumes. Put `INKLING_DATA_NAME=nodian` back, `docker compose -p inkling down`, `docker compose up -d`, and
  delete the empty `inkling_inkling-*` volumes.
- Servers that run Docker through sudo: run the rename script the way you run compose,
  `sudo ./deploy/rename-from-nodian.sh --dry-run`. It writes `.env` in place (owner and mode kept) and its state
  under `./backups/rename-nodian-to-inkling/` (root-owned when run with sudo). The `printf … >> .env` line above
  needs a shell that may write `.env`: `sudo sh -c "printf '\nINKLING_DATA_NAME=nodian\n' >> .env"` when the file
  belongs to root.

### Client updates

Open tabs learn about a deploy from the `X-Inkling-Build` header on every `/api` response (the id
the web build wrote to `WEB_DIST/build.json`; docs/adr/0990-*). What they do is set by:

| Env | Values | Default | Effect |
|---|---|---|---|
| `UPDATE_MODE` | `prompt`, `force` | `prompt` | `prompt`: a "A new version is available · Reload" banner on every screen. `force`: the tab reloads by itself once its document edits are acknowledged by the server, no request is in flight and the user has been idle 3 s; a freshly opened tab on an old bundle reloads at once; after 2 minutes without a safe moment, or right after an automatic reload, it shows the banner instead (docs/adr/0991-*, 0992-*). |
| `UPDATE_CHECK` | `github` or empty | empty (off) | Once a day (on the first admin visit), compare the server version with the latest GitHub release and show "Inkling X.Y.Z is available" in the Admin screen. Only the repository path is requested; nothing about the instance is sent (docs/adr/0994-*). |
| `UPDATE_CHECK_REPO` | `owner/name` | `PROVE1352/inkling` | Repository for `UPDATE_CHECK=github`. |
| `INKLING_BUILD` | build-time arg / env | build-time hash | Docker: `docker build --build-arg INKLING_BUILD=$(git rev-parse --short HEAD) .` tags the build. At runtime it is only a fallback when `WEB_DIST` has no `build.json`. |

- [ ] `GET /api/version` returns `{ build, version, updateMode }`; `curl -sI <url>/api/health | grep -i x-inkling-build` shows the id the server advertises.
- [ ] A reverse proxy or CDN must not strip `X-Inkling-Build` or cache `/api/*`.
- [ ] Rebuilding without changes still produces a new id (time-based) and one "new version" notice; pass `INKLING_BUILD` to avoid that.

### Backup and restore

- [ ] Restore is CLI only: run `./deploy/restore.sh --dry-run <set>` first. Details: [BACKUP.md](BACKUP.md).
- [ ] Test a real restore into a scratch environment at least once per quarter.

### Accounts

- Forced account deletion (admin): the user's private pages go to the trash with no owner. They are visible to nobody, admins included, and are purged after 30 days. Deletion is refused with 409 while the user is the sole owner of a workspace; transfer ownership first.
- Ownerless private pages created before this behaviour (by older versions) stay hidden and are not deleted.

- OpenID Connect: a person's connected sign-ins are listed in `user_identities` (issuer, subject, user). The app has no "disconnect" yet; remove a wrong connection with `DELETE FROM user_identities WHERE user_id = '<id>' AND issuer = '<issuer>'`. Changing `OIDC_ISSUER` does not move connections: people connect again in Settings › Account (or are linked by verified email with `OIDC_LINK_EXISTING=1`).

### Incidents

- [ ] Database down or disk full: stop the app first, fix the database or disk, then start the app.
- [ ] OOM kill (exit 137): check for concurrent large imports, exports or duplications.
- [ ] Webhook deliveries queued in memory are lost on restart.

## 1. PostgreSQL tuning

All settings are passed as `-c` arguments by the `db` service in `compose.yaml` and can be overridden in `.env`. Defaults are small so the stack still fits a 1 GB host.

| variable | default | example for a 4-core / 24 GB ARM VM shared with other services |
|---|---|---|
| `PG_MEM_LIMIT` | `512m` | `2g` |
| `PG_SHARED_BUFFERS` | `128MB` | `512MB` (≈25% of the container limit) |
| `PG_EFFECTIVE_CACHE_SIZE` | `384MB` | `1536MB` (shared_buffers + page cache the container may keep) |
| `PG_WORK_MEM` | `4MB` | `16MB` (per sort/hash node; 10 app connections) |
| `PG_MAINTENANCE_WORK_MEM` | `64MB` | `128MB` |
| `PG_RANDOM_PAGE_COST` | `1.1` | `1.1` (block volumes are SSD-backed) |
| `PG_EFFECTIVE_IO_CONCURRENCY` | `100` | `100` |
| `PG_SHM_SIZE` | `128m` | `256m` |
| `PG_PRELOAD_LIBRARIES` | *(empty)* | `pg_stat_statements` while investigating |

Notes
- `shared_buffers` and `shared_preload_libraries` need `docker compose up -d db` (container restart). The others can also be changed live with `ALTER SYSTEM` + `SELECT pg_reload_conf()`, but the compose arguments win at the next restart.
- The container's page cache counts against `mem_limit`. Keep `effective_cache_size` at most `PG_MEM_LIMIT` minus `shared_buffers` (both columns above sit exactly there: `512m` − `128MB` = `384MB`, `2g` − `512MB` = `1536MB`), otherwise the planner assumes cache that the cgroup will evict.
- If you use a `compose.override.yaml` that defines its own `command:` for `db`, it replaces this one entirely — merge the flags there.

### Query statistics (opt-in)

```sh
# .env
PG_PRELOAD_LIBRARIES=pg_stat_statements
docker compose up -d db
docker compose exec db psql -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
```

Top statements by total time:

```sql
SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       rows / greatest(calls, 1) AS rows_per_call, left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
-- reset: SELECT pg_stat_statements_reset();
```

### Is the working set in memory?

```sql
-- Buffer cache hit ratio per database (aim for > 0.99 once warm)
SELECT datname, blks_hit, blks_read,
       round(blks_hit::numeric / nullif(blks_hit + blks_read, 0), 4) AS hit_ratio
FROM pg_stat_database WHERE datname = current_database();

-- Per table (heap + index)
SELECT relname,
       round(heap_blks_hit::numeric / nullif(heap_blks_hit + heap_blks_read, 0), 4) AS heap_hit,
       round(idx_blks_hit::numeric / nullif(idx_blks_hit + idx_blks_read, 0), 4)   AS idx_hit
FROM pg_statio_user_tables ORDER BY heap_blks_read + idx_blks_read DESC LIMIT 15;

-- Database size vs shared_buffers
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, current_setting('shared_buffers');
```

### HOT updates (fillfactor)

Migration 0024 sets `fillfactor = 85` on `pages` and `90` on `page_docs` so the frequent `updated_at` bumps can be HOT updates (no index writes). Existing heap pages stay packed until rewritten. Check and, optionally, rewrite once during a quiet moment (takes an exclusive lock for a few seconds on small tables):

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(n_tup_hot_upd::numeric / nullif(n_tup_upd, 0), 3) AS hot_ratio
FROM pg_stat_user_tables WHERE relname IN ('pages', 'page_docs');

VACUUM (FULL, ANALYZE) pages;   -- optional one-time rewrite
```

Measured on a 5k-page seed: 0.1% HOT before, 91% after `fillfactor = 85` + rewrite.

### Never `drizzle-kit push` against production

Push diffs the live database against `schema.ts` and drops anything not declared there. It already removed the hand-written trigram and "perf" indexes once; since migration 0024 they are declared in the schema and recreated with `IF NOT EXISTS`. Always use generated migrations (`pnpm db:generate`, applied at boot).

## 2. Node process

- `APP_MEM_LIMIT` (default `768m`) and `NODE_OPTIONS` (default `--max-old-space-size=512`): keep the heap cap at ~65% of the container limit; Buffers, Yjs documents and code live outside the V8 heap.
- `UV_THREADPOOL_SIZE` (default 4) is shared by argon2 hashing, file streaming and zlib. Consider `8` if logins and large uploads coincide.
- Streaming imports/exports use `DATA_DIR/tmp` (cleared at every boot) and `DATA_DIR/uploads/.upload-*` for in-flight uploads. Keep free disk space ≥ the largest import/export (folder import ≤ 50 MB, zip export ≤ 300 MB of attachments).

## 3. In-process caches and maps (single instance)

| where | content | bound | expiry / invalidation |
|---|---|---|---|
| `linkPreview.ts` | URL → preview card | 1,000 LRU | 6 h (10 min for failures) |
| `routes/query.ts` | query-block results per user | 200 LRU | 60 s; key includes workspace version + index epoch |
| `routes/public.ts` | public page HTML / allowed file ids | 200 entries + 32 MB / 500 + 8 MB | 10 min; key includes `pages.updated_at`; checked after the token/scope gate |
| `docIndexer.ts` | pending index passes / change signatures | 200 pending / 2,000 signatures | 8–30 s debounce / 10 min TTL; flushed at shutdown |
| `snapshotStore.ts` | last auto-snapshot time per page | 5,000 LRU | only used to skip the 10-min throttle check |
| `webhooks.ts` | delivery queue, per-workspace counters | 5,000 jobs (200 per workspace) | lost on restart (by design) |
| `guard.ts` | login failure counters / IP bans | 20,000 per map / bans until expiry | swept every 5 min; reset on restart |
| `collab.ts` | per-IP socket counts and upgrade timestamps | swept above 1,024 IPs | 10 s window |
| `hocuspocus.documents` | open Yjs documents | open documents | unloaded when the last client leaves |
| `context/contextCache.ts` | find_context results per person (ADR 1550), single queries and merged bundles (ADR 1721) | 1,000 LRU + 32 MB (shared) | 5 min; key includes access version, page marker and section index epoch of every searched workspace; a bundle key also the query list, a digest of the extra ranked lists and, with semantic search on, each workspace's vector epoch (ADR 1723) |
| `context/semantic.ts` | semantic search only (off by default): chunk vectors per workspace, query vectors (ADR 1741) | `EMBEDDING_CACHE_MB` (128 MB) for all workspaces; a workspace that does not fit is scored in SQL / 256 query vectors | loaded on the first query, updated after indexer writes / 10 min |
| `context/embeddings.ts`, `semanticIndexer.ts` | endpoint health and backoff, refused chunks (ADR 1742) | one state / 10,000 refused chunk hashes | backoff 5 s → 10 min; refused chunks until restart |
| `connectionUsage.ts` | usage numbers per connection and per (workspace, connection) (ADR 1552) | 5,000 + 20,000 LRU | lost on restart (by design) |
| `context/changeWait.ts` | changes_since calls waiting (ADR 1551) | 256 per process, 4 per connection | 25 s each; released at shutdown |
| `slack/config.ts` | Slack settings per workspace for the notification consumer (ADR 1802) | 10,000 workspaces | 60 s; dropped when the settings are saved or removed |
| `routes/forms.ts` | public form answers per form in the last hour (ADR 1822) | 5,000 forms, oldest forgotten first | sliding hour; lost on restart |

No cache holds sessions, memberships or page visibility; those are read from the database on every request. The find_context cache holds answers, not rights: its key carries the workspace access version and the person's permission inputs, so a membership, lock, block or visibility change makes the next call search again. The only long-lived authorisation — an open collaboration socket — is revoked on member removal, a page becoming private, force delete and password change/session revocation (`liveConnections.ts`, ADR 0754).

## 4. HTTP caching

- `assets/*`, `workbox-*.js`: `public, max-age=31536000, immutable`. `index.html`, `sw.js`, `push-sw.js` (0.18: the service worker imports it, and imports go through the HTTP cache on worker updates), `registerSW.js`, `manifest.webmanifest`, SPA routes: `no-cache`. Other static files: one day.
- API: `private, no-store` by default. Large GETs (page tree, graph, due list, collections) carry a weak ETag and `private, no-cache` and answer `If-None-Match` with 304 before doing the work; other GET JSON ≥ 1 KB gets a content-hash ETag.
- Compression happens only in Caddy (`encode gzip zstd`). Quick check through the proxy:

```sh
curl -sI --compressed -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages | grep -i 'etag\|cache-control\|content-encoding'
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: <etag from above>' -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages   # 304
```

## 5. Semantic search (optional)

Off unless both `EMBEDDING_URL` and `EMBEDDING_MODEL` are set (docs/adr/1740-*). When on, the server sends the text of
every section chunk (page title, heading path, chunk text) to that endpoint, once per change, and find_context also
ranks sections by meaning. With a hosted provider that is a third party: use a local model server if notes must not
leave the machine. Turned off, nothing of it runs: no request, no timer, no query.

| Variable | Default | Meaning |
|---|---|---|
| `EMBEDDING_URL` | — | Base URL of an OpenAI-compatible API (`https://api.openai.com/v1`, Ollama `http://host:11434/v1`, text-embeddings-inference `http://tei:8080/v1`) or the full `…/embeddings` URL |
| `EMBEDDING_MODEL` | — | Model name; stored with every vector, so changing it re-embeds everything |
| `EMBEDDING_API_KEY` | none | Sent as `Authorization: Bearer …`; never logged or shown |
| `EMBEDDING_DIMENSIONS` | model default | Sent as `dimensions` (models that can shorten vectors, e.g. text-embedding-3-*) |
| `EMBEDDING_BATCH_SIZE` | 32 | Chunks per request (1–256) |
| `EMBEDDING_REQUESTS_PER_MINUTE` | 60 | Indexer request rate; one request in flight |
| `EMBEDDING_TIMEOUT_MS` | 30000 | Indexer request timeout |
| `EMBEDDING_QUERY_TIMEOUT_MS` | 3000 | Timeout of the one query embedding per search; on timeout search answers lexically |
| `EMBEDDING_MAX_CHARS` | 4000 | Characters of one chunk sent to the model |
| `EMBEDDING_CACHE_MB` | 128 | In-process vector cache for queries; a workspace that does not fit is scored in SQL (slower) |
| `EMBEDDING_QUERY_PREFIX` | empty | Role prefix put before every search query (0.20, docs/adr/2404-*) |
| `EMBEDDING_PASSAGE_PREFIX` | empty | Role prefix put before every section sent for embedding (0.20) |

`EMBEDDING_QUERY_PREFIX` / `EMBEDDING_PASSAGE_PREFIX` are for models trained with role prefixes (e5:
`EMBEDDING_QUERY_PREFIX="query: "`, `EMBEDDING_PASSAGE_PREFIX="passage: "`; quote them in `.env` so the space is
kept). Vectors are stored under the model name plus a short hash of the prefixes, so setting, changing or removing a
prefix re-embeds every section and the clean-up deletes the old vectors, exactly as after a model change. The admin
status keeps showing the model. `multilingual-e5-small` with these prefixes was measured on 0.20 and not adopted:
page@1 went up on some question sets and down on others, while answers took 1.7 to 7.5 times the tokens
(docs/PERFORMANCE.md, "Rejected / no effect").

`compose.yaml` passes all twelve through, so setting them in `.env` is enough (examples in `.env.example`). A half-filled
set (URL without model or the reverse) stays off and logs one warning at boot. Multilingual models work best for mixed
Korean/English notes (e.g. `bge-m3`, `multilingual-e5-large`, `text-embedding-3-small`).

Docker: inside the container `localhost` is the container. For Ollama on the Docker host use
`http://host.docker.internal:11434/v1` (Docker Desktop) or the host's LAN address, and make Ollama listen on it
(`OLLAMA_HOST=0.0.0.0`). A redirecting `EMBEDDING_URL` (e.g. http → https) is refused and reported as "connection
failed"; configure the final URL.

- **Boot log when on:** `[inkling] semantic search: on — model <model> at <scheme://host/path>, 32 chunks/request, 60 requests/min`.
- **Backfill:** migration 0042 creates `page_chunk_vectors`. The first time it is on, the indexer embeds every live
  chunk in the background (only changed chunks afterwards); search answers from what is already embedded meanwhile.
- **Endpoint failures:** one line `[inkling] semantic index: <host/path>: <reason>; retrying later` per new error;
  requests back off from 5 s to 10 minutes. Searches answer lexically meanwhile; saves are never affected. Chunks the
  endpoint refuses on their own (400/413/422) are skipped until restart; lower `EMBEDDING_MAX_CHARS` if a model has a
  small context.
- **Progress:** Admin › Server status shows "Semantic search" (sections indexed / waiting, chunks refused, last
  error, pause end). `GET /api/admin/status` → `semantic` (docs/API.md, counts cached 30 s).
- **find_context:** each query takes up to 8 semantic candidates, those with a cosine of at least 0.6 × the best one
  (`context/semanticFind.ts`), merged with the word search by RRF (docs/adr/1723-*).
- **Memory:** plan for `EMBEDDING_CACHE_MB` (default 128 MB) on top of the usual process memory (section 2).
- **Health:** `/api/health` and `/api/health/ready` do not depend on the embedding endpoint.
- **Backups:** `page_chunk_vectors` is in the database dump. It is derived data; truncate it before a dump to save
  space (it is rebuilt in the background).
- **Turning it off:** remove the variables and restart. The table stays (nothing reads it);
  `TRUNCATE page_chunk_vectors;` frees the space. Turning it on again embeds only what changed.
- **Switching models:** change `EMBEDDING_MODEL` and restart; every chunk is embedded again in the background, and the
  10-minute clean-up deletes the old model's rows.
- **Size:** query time grows with the chunks of the searched workspaces (about 10 ms per 2,700 cached 768-dim
  vectors, docs/PERFORMANCE.md). Past ~50k chunks per workspace pgvector (docs/adr/1214-*) would be the fix
  (docs/KNOWN-ISSUES.md).

## 6. Slack app (per workspace)

Each Inkling workspace can connect its own Slack app (docs/adr/1800-*). There is no central Inkling app and no Slack
setting in `.env`; a workspace owner creates the app in their Slack workspace and pastes its credentials.

1. Set `PUBLIC_URL` (needed for link unfurls and for the `/inkling link` URL) and `APP_SECRET_KEY` (otherwise the token
   and secret are stored unencrypted; the settings page warns).
2. In Inkling: Workspace settings → Slack (owners). Copy the manifest (JSON).
3. https://api.slack.com/apps → Create New App → From an app manifest → choose the Slack workspace → paste the
   manifest → Create. If Slack rejects a field, create the app by hand with the values listed on the page: slash
   command `/inkling` with the command URL, Event Subscriptions request URL with the bot events `link_shared`,
   `app_uninstalled`, `tokens_revoked`, App unfurl domain = your `PUBLIC_URL` host, bot scopes
   `chat:write chat:write.public commands links:read links:write users:read users:read.email`.
4. Install to Workspace. Copy **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`) and
   **Basic Information → Signing Secret**.
5. Back in Inkling: paste both, enter the channel **ID** (channel details → bottom, `C…`), choose the updates, Save
   (Inkling calls `auth.test`). For a private channel, `/invite @<app name>` there first.
6. Press Test. `not_in_channel` = invite the bot; `invalid_auth` = wrong token.
7. Members: type `/inkling help`. If their Slack email differs from their Inkling email, `/inkling link`.

Slack checks the Event Subscriptions URL when the app is created from the manifest, before the token and secret are
saved in Inkling; Inkling answers that first check for a live workspace without a saved app. If Slack still shows the
URL as unverified, open Event Subscriptions after step 5 and press Retry.

- **Failed posts:** outbox topic `slack`; failed jobs end as `state = 'dead'` with Slack's code in `last_error`:
  `SELECT state, last_error, count(*) FROM outbox WHERE topic = 'slack' GROUP BY 1, 2;`
- **Paused posts:** a revoked token or a bot removed from the channel shows as `blocked_reason` on the settings page;
  saving the settings or a passing Test resumes.
- **Housekeeping (hourly):** queues the daily summary (once per local day) and prunes `slack_request_nonces`
  (older than 15 minutes) and expired `slack_link_codes`.
- **Rotating the token or secret:** paste the new value and Save; omitted fields keep the stored value. If
  `APP_SECRET_KEY` is lost or changed, the stored values cannot be read and must be entered again.
- **Disconnecting** removes links, link codes and pending Slack jobs; the app itself is removed in Slack.
- **Work handed to an agent connection** is not posted to the channel (docs/adr/1870-*).
- **Test hook only:** `SLACK_TEST_API_URL=http://127.0.0.1:<port>/api` with `WEBHOOK_TEST_ALLOW_LOOPBACK=1` (ignored
  when `NODE_ENV=production`).

## 7. Public forms

A form view can get a public link (`/f/<token>`, API `/api/public/forms/<token>`; docs/adr/1821-*, 1822-*). It is the
only route where a visitor without an account writes data.

- **Limits:** 10 answers per minute per IP (the `@fastify/rate-limit` route config), 60 form reads per minute per IP,
  and 300 answers per form per hour counted **in memory per process** (several processes multiply it). A body is at
  most 32 KiB, a text answer 5,000 characters. A filled honeypot field is answered like a success and writes nothing.
- **Guessed tokens** count as failures for the IP ban (`guard.ts`, reason `form-token`), like page link tokens.
- **Closing:** turning public links off in the workspace settings closes every public form at once. A form also
  closes when its collection is trashed or made private, or when the member who turned the link on can no longer add
  rows (removed from the workspace, or the collection locked against them): each answer is made as that member.
- **Labels:** answers are rows created by the publisher `via public form`; activity, the "Written by AI" badge and the
  AI summaries count them as people's input (docs/adr/1870-*).

## 8. Page verification, scheduled links, member status and team agents

- Migration 0045 adds a nullable column (`pages.share_starts_at`) and two small tables (`page_verifications`,
  `user_statuses`); no backfill, no long locks. Verification expiry, scheduled link starts and status clearing are
  compared at read time with the server clock: no new job and no new variable.
- Migration 0046 adds `notifications.connection`, `notifications.person_too` and
  `user_notification_settings.agent_handoff_copy` (constant defaults, metadata-only) and the partial index
  `notifications_connection_idx` on an all-NULL column (empty when built).
- Hourly housekeeping hands back unacknowledged items of connections that are no longer live in their workspace
  (expired grant or token, block, person left, range change) with one UPDATE over that partial index. The disconnect
  and token delete routes do it at once for their connection.

## 9. Single instance, boot re-index and saving (0.15.1)

### Single instance (docs/adr/1925-*)

- Inkling runs one server process per database. At boot, before migrations, the server takes a Postgres advisory
  lock on its own connection (`application_name = inkling-instance-lock`, visible in `pg_stat_activity`) and keeps it
  until it exits; it releases it last, after saving open documents.
- If another process holds it, the log says which and the server waits:
  `[inkling] another Inkling process uses this database (pid …, application "inkling-instance-lock", from …,
  connected since …); waiting up to 60 s for it to stop`. When the other process stops, the boot continues. After
  `SINGLE_INSTANCE_WAIT` seconds (default 60) it exits with `[inkling] refusing to start: another Inkling process is
  running against this database (…)`. With `restart: unless-stopped` the container keeps retrying and starts once
  the other process is gone.
- `docker compose up -d` stops the old container before it starts the new one, so a normal deploy is not delayed. A
  replacement started while the old container is still shutting down (up to its 30 s stop grace period) waits for
  it. Nothing in `compose.yaml` waits on the app's health; the healthcheck (start period 10 s, interval 30 s, 3
  retries) turns unhealthy only after about 100 s, so a replacement waiting the default 60 s still turns healthy.
- The lock is checked every 30 s. After a database restart the server takes it again; if another process took it
  first, the server shuts down (`lost the instance lock to another process`).
- `SINGLE_INSTANCE=0` (also `false`, `off`, `no`) turns the guard off, with a warning at boot. Use it only for a
  deliberate extra process against a live database (a one-off maintenance script), never for a second web server,
  and behind a transaction-mode pooler (PgBouncer `pool_mode=transaction`), where a session lock means nothing.
  Tests are unaffected: they never boot `index.ts`.
- A 0.15.0 process takes no lock, so the guard cannot see one during a mixed-version overlap. A compose deploy never
  overlaps (stop, then start).

### Boot re-index of stale pages (docs/adr/1924-*)

- A crash between a save and its queued index pass used to leave the page's search text, sections, links, tags and
  tasks describing the old content until the next edit. From 10 s after the server listens, a background pass
  re-indexes pages whose stored content is newer than `page_chunk_index.doc_updated_at`, about ten pages a second
  and at most 20,000 per boot, and logs `[inkling] re-indexed N page(s) whose last index pass was lost (crash or
  kill)`. Nothing is logged when nothing was stale.

### Saving documents (docs/adr/1921-*)

- `[inkling] collab store of <page> failed; retrying in the background`, then `collab store retry N of <page>
  failed`: the database refused the document save; retries every 5 s, doubling to 60 s.
- `[inkling] <page> has unsaved changes and the store failed; keeping it in memory`: the last editor left before a
  save succeeded; the page stays loaded until one does.
- At shutdown, `[inkling] shutting down with unsaved changes in N document(s): …` names what could not be saved.
- In the browser, while edits have not reached the server the page's connection dot turns amber and reads "Not saved
  yet", and the tab asks before it is closed or reloaded (docs/adr/1926-*). Without an offline copy of the page (the
  per-device setting in section 12, off by default in a browser tab) nothing is kept in the browser's storage: edits
  made offline survive only while the tab stays open. With the setting on, the edits are also written to the device;
  the dot reads "Not uploaded yet" and they are sent on the next connection (docs/adr/2204-*).

### Vault sync revisions (docs/adr/1920-*)

- Revisions include the document's deletions since 0.15.1, so `inklingctl sync` no longer brings back text deleted on
  the server. Server-only change: old CLIs keep working. A revision from an older server is recognised (no `-` in
  it): a write with it is refused once with the current version and the CLI merges; a delete with it succeeds when
  nothing was inserted or reformatted since. A note deleted locally before the upgrade is still trashed on the
  server.
- A vault write is applied as a minimal edit; when that does not validate the server rewrites the whole document
  and logs `[vault-sync] minimal replace not applied`.

## 10. MCP and AI agents (0.16)

### Tool profiles and the `/mcp` query string (docs/adr/2000-*)

- `/mcp` takes a query string (`?profile=core`). A proxy that drops or rewrites the query turns every connection into
  the full profile (Caddy and nginx pass it through by default). An unknown value is HTTP 400.

### Uploads by AI agents (docs/adr/2044-*, 2045-*, 2065-*)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_UPLOADS` | `on` | `on`: agents may upload unless a workspace turns it off. `off`: only workspaces that turn it on. `never`: off everywhere; the workspace setting is shown disabled with the reason. Any other value boots with a warning and counts as `off` |
| `AGENT_UPLOAD_MAX_MB` | `5` | Largest file an MCP connection, agent token or API token may upload, at most 64 (a larger value is cut to 64 with a warning; 0 or a non-number keeps 5 with a warning) |
| `AGENT_UPLOAD_DAILY_MB` | `200` | Per account per rolling 24 hours, over the files its connections uploaded (`files.uploaded_via`); `0` = no budget. People's uploads in the browser have no budget and are never counted |

- Workspace owners and admins choose "Uploads by AI agents" (server default, on, off) in Workspace settings ›
  Connected agents › File uploads. People's uploads are not affected.
- **Memory.** One upload_file call holds the JSON body, the parsed base64 string and the decoded bytes, about four
  times the file, for each upload in flight; with a 64 MB cap that is ~256 MB per concurrent upload. Above 8 MB the
  `/mcp` body limit grows to base64 of the cap + 1 MB, for upload_file calls only; every other MCP request keeps
  12 MB. API-token uploads (multipart) stream to disk. Raise the cap only with memory to spare.
- The boot log prints the limits in use when they differ from the defaults (per-file cap, MCP body limit for
  upload_file calls, budget); a value that was cut or ignored is a boot warning and a warning in Admin › Status
  (`security.agentUploads`).
- There is still no storage quota for people, and files are never garbage-collected: reverting an agent's upload
  removes the link, not the file.

### Suggest-only after suspicious content (docs/adr/2040-* .. 2043-*)

- A connection (OAuth, agent connection token or personal API token) that is handed text the injection heuristics
  flag writes only suggestions for 60 minutes after the last such read; its other writes answer
  `403 CONNECTION_SUGGEST_ONLY`. On in every workspace after the upgrade.
- Turn it off per workspace: Workspace settings › Connected agents › Suspicious content (owners and admins). Lift it
  early for one connection: its owner in Settings › Connections (**Allow edits again**), or a workspace owner/admin on
  the team agents board (**Allow edits here**, for content that was in that workspace).
- The audit log shows `agent.tainted` (the source page or file and the rules, never the text) and
  `agent.taint_released`. Refused writes are not audited one by one.
- The hourly housekeeping deletes `connection_taints` rows older than 30 days.
- The heuristics are short, English/Korean phrase lists; expect misses and some false alarms (a CSV of long hex ids
  can trip `encoded-blob`). If one workspace's content trips it all the time, switch the rule off there rather than
  for the server.

### Agent connection tokens (docs/adr/2060-* .. 2063-*)

- Agent connection tokens are `oauth_grants` rows with `kind = 'token'` and an `oauth_clients` row `ink_tc_…` each;
  the hourly housekeeping deletes expired ones (by `refresh_expires_at`, which equals the expiry) and client rows left
  without a grant. At most 20 live tokens per account; expiry 7, 30, 90 or 365 days, no "never".
- Secret scanning: `ink_agt_[A-Za-z0-9_-]{43}` (agent connection token, works at `/mcp` only) next to
  `ink_pat_[A-Za-z0-9_-]{43}` (API token). A leaked agent token is revoked by its owner in Settings › Connections or,
  for the whole account, by a password reset (deletes every grant).
- The IP ban (`AUTH_GUARD_*`) also counts unknown `ink_agt_` tokens at `/mcp`; an expired token that exists and OAuth
  access tokens are not counted.

### PDF text (docs/adr/2047-*, 2048-*)

- `read_file` reads the text layer of PDFs with `unpdf` 1.9.1 (bundles pdf.js; Node 22 or newer). In the built image
  the package is about 2.5 MB.
- Each call parses in a short-lived worker thread: 256 MB heap cap, 10 s wall time, at most two PDFs at once per
  process (more wait for a slot); files over 20 MB are not parsed (metadata only), at most 50 pages per call. Nothing
  to configure. No OCR: scanned PDFs have no text.

## 11. Local trial, setup link, zips, versions and diagrams (0.17)

### First-admin setup link (docs/adr/2160-*)

- A server with no account prints, once per boot, a framed block to stdout: "No accounts yet. Create the first
  administrator account here: `<PUBLIC_URL>/setup?code=…`". Find it with `docker compose logs app | grep setup`. A
  restart prints a new code and the old one stops working. The account made with it is the admin; the link closes as
  soon as any account exists. Servers that already have accounts print nothing.
- **Security.** The code is in memory only, works once and counts wrong guesses towards the IP ban, but it is
  readable by anyone who can read the container's stdout until the first account exists. If logs go to a shared
  service, create the first account right after the first start, or use a signup key (`./deploy/signup-key.sh new
  "first admin"`, deploy/DEPLOY.md 3-C). There is no switch to turn the link off yet (KNOWN-ISSUES SETUP-1).

### Local trial (docs/adr/2161-*)

- `./deploy/local.sh` (start; `--build` builds the checkout instead of pulling the image), `./deploy/local.sh stop`,
  `./deploy/local.sh destroy` (deletes the trial's containers and volumes; the `.env` stays). It writes a `.env` marked
  `# made by deploy/local.sh` with a random hex `POSTGRES_PASSWORD`, a random base64 `APP_SECRET_KEY`, `PUBLIC_URL=http://localhost:<port>`,
  `INKLING_PORT=127.0.0.1:<port>`, `BACKUP_ENABLED=0`, `INKLING_DATA_NAME=inkling`,
  `COMPOSE_FILE=compose.yaml:compose.local.yaml` and `COMPOSE_PROJECT_NAME=inkling-local`, so plain
  `docker compose …` and the other `deploy/*.sh` scripts act on that stack. A `.env` without the marker is never
  changed; a marked one from before 0.19 gets `INKLING_DATA_NAME=nodian` (its old volume and role names).
- It is not for a server other people use: http only, reachable from this machine only, no backups, no database host
  port. It needs bash, curl and Docker Compose v2.24 or newer (`!override`); on Windows run it from WSL or Git Bash.
- Without `--build` it pulls `ghcr.io/prove1352/inkling:${INKLING_VERSION:-latest}`; an image older than 0.17 prints
  no setup link, and the script then says to make the first signup key with `./deploy/signup-key.sh`.
- `compose.yaml` reads `INKLING_PORT` (the app's host port or `ip:port`, default `3000`) and `INKLING_DB_PORT` (the
  loopback database port, default `55432`).

### Zip imports (docs/adr/2162-*, 2163-*)

- Every zip import (web and MCP) refuses an archive with a `..` entry or a symbolic link and stops an entry that
  inflates more than 200 times its packed size past 1 MB (400 `ZIP_RATIO`). Names are normalized (NFC, `\`, leading
  `/`, drive letters); names that are not UTF-8 are read as CP949.
- A zip posted with a connection's token (MCP `import_zip`, or a bearer `POST /api/workspaces/:id/import`) is at most
  `min(IMPORT_MAX_UPLOAD_MB, AGENT_UPLOAD_MAX_MB)` (default 5 MB). Its `assets/` attachments follow the agent upload
  switch, the per-file cap, the type check and the daily budget (section 10) and are recorded with `uploaded_via`; a
  bearer `import-folder` does the same for its attachments. Browser imports keep `IMPORT_MAX_UPLOAD_MB` and no budget.
- An `import_zip` call carries the zip as base64 in one MCP request; above 8 MB of `AGENT_UPLOAD_MAX_MB` the `/mcp`
  body limit grows for it as for upload_file (about four times the file in memory per call in flight).

### Versions: AI steps (docs/adr/2180-*)

- Every agent write stores one `page_snapshots` row (an "AI step"): usually a small Yjs diff (median about 0.7 KB in
  the benchmark), a whole state every 10th row of a chain (docs/adr/1100-*). Each client keeps its newest 20 steps per
  page, a page at most 30 steps, and the 50-version cap per page is unchanged; step rows are pruned first, and the
  diffs of dropped rows are merged into the next kept row instead of rebuilding it.
- Storage: 30 agent writes to a 12 KB note keep 21 rows, 34.3 KB on disk (0.16: 1 row, 4.5 KB); to a 4.1 MB log,
  2.37 MB on disk (0.16: 1.07 MB). The bound is the 50-version budget of a page (docs/PERFORMANCE.md). An agent
  appending often to a multi-megabyte page writes about the page's size per 10 writes; logs should use child pages
  (docs/adr/1140-*).
- Write cost: two short transactions and two content digests per agent write, +6–9 ms on small pages.

### Mermaid diagrams (docs/adr/2104-*, 2191-*)

- `mermaid` 12.3.0 is in the web bundle under `assets/lazy/` (about 90 files, 5.16 MB, 1.44 MB gzip, over every
  diagram type) and is not precached by the service worker: a browser fetches it on the first page with a diagram
  (about 246 kB gzip for a flowchart). A browser that has never drawn a diagram cannot draw one offline. Nothing runs on
  the server; public pages draw diagrams in the reader's browser.

## 12. Offline copies, web push, automations, the web clipper and CIMD (0.18)

### Offline copies (docs/adr/2200-* .. 2204-*)

- Offline copies live in each person's browser (IndexedDB `inkling-offline`); the server stores nothing new apart
  from `pages.doc_gen` and answers one `GET /api/pages/:id/sync-check` per open of a page with a copy and per
  reconnect. Nothing to configure.
- The setting "Keep offline copies on this device" is per device: on by default in the installed app, off in a
  browser tab. Copies are not encrypted; anyone with access to the browser profile can read them. On shared or public
  computers tell people to use a browser tab with the setting off (the default) and to log out: logging out, an
  expired or revoked session and another account signing in delete every copy on that device.
- Logging out while offline deletes the copies and the browser's push subscription at once, but cannot end the
  session on the server; it stays valid until it expires (30 days) or is revoked. There is no "sign out everywhere"
  button yet: the person changes their password, or an admin issues a reset code or temporary password in Admin ›
  Users, which signs out every session (KNOWN-ISSUES OFFLINE-LOGOUT).
- After `deploy/restore.sh` (restore from a backup), browsers with unsent edits newer than the backup turn them into
  recovery items on their next connection; tell people to look in Settings › Offline › Recovery.

### Web push (docs/adr/2220-* .. 2223-*)

- **HTTPS is required.** Browsers allow push (and service workers) only on `https://` origins and on
  `http://localhost`. Behind a reverse proxy (Caddy, nginx) serve the app over HTTPS as usual; the proxy needs no extra
  route: `/sw.js`, `/push-sw.js` and `/api/push/*` are ordinary app paths. The server sends `/sw.js` and
  `/push-sw.js` with `Cache-Control: no-cache` (section 4); a proxy must not override it.
- **iPhone and iPad:** push works only in the Home Screen app (Safari → Share → Add to Home Screen), iOS/iPadOS 16.4
  or later; a Safari tab shows how to do that. Apple checks the VAPID `sub` claim: set
  `VAPID_SUBJECT=mailto:you@your-domain` (or rely on an https `PUBLIC_URL`); the placeholder
  `mailto:webpush@inkling.invalid` used when neither is set may be refused by Apple.
- **Outbound connections** (HTTPS, port 443) from the server to the push services browsers use: `fcm.googleapis.com`
  (and the legacy `android.googleapis.com`) for Chrome, Edge on Android, Samsung Internet and Opera;
  `updates.push.services.mozilla.com` / `*.push.services.mozilla.com` for Firefox; `web.push.apple.com` /
  `*.push.apple.com` for Safari; `*.notify.windows.com` for Edge on Windows. An egress firewall must allow them.
  Other hosts are refused unless listed in `WEB_PUSH_ALLOWED_HOSTS` (comma-separated, `host` or `*.suffix`); every
  target must still resolve to public addresses, no redirects are followed and at most 4 KiB of a response is read.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PUSH` | on | `off` switches push off server-wide: nothing is queued, queued deliveries are dropped, the routes answer unavailable |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | empty (a key made on first use, kept in `push_vapid_keys`) | both or neither; base64url raw keys as printed by `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | `PUBLIC_URL` when https, else `mailto:webpush@inkling.invalid` | the VAPID `sub` claim |
| `WEB_PUSH_ALLOWED_HOSTS` | empty | more push service hosts, comma-separated, `host` or `*.suffix` |
| `PUSH_TEST_ALLOW_LOOPBACK` | off | tests only; ignored with `NODE_ENV=production` |

- **The key.** The generated private key is sealed with `APP_SECRET_KEY` (rows written before the key was set are
  sealed at the next boot), like subscription endpoints and their auth secrets. Changing the VAPID key (setting the
  env pair later, or a new generated key) voids every subscription (deliveries to old ones are dropped and the rows removed; devices subscribe again when the person
  opens the app). The key lives in its database: pointing the server at a different database (another instance's,
  or a fresh one) or deleting the row means another key, while restoring this database's own backup keeps it, as
  long as the same `APP_SECRET_KEY` is set (keep a copy off the server, outside the backups). To start over with a new generated key: `DELETE FROM push_vapid_keys;` and restart. If Server status shows
  "VAPID key problem (stored_unreadable)", `APP_SECRET_KEY` is missing or changed: restore it, or delete the row.
  `env_incomplete` / `env_invalid`: fix the env pair.
- **Subscriptions** belong to the login session that made them and are deleted with it (logout, password change,
  an admin's revoke of sessions, the 30-day expiry). At most 20 devices per person.
- **Delivery:** outbox topic `push`, 4 requests at a time per process, retries 10 s → 30 s → 90 s → … (capped at 30
  minutes, 5 attempts, the push service's Retry-After honoured); a device is removed on 404/410 or after 10 failures
  in a row. TTL 24 h at the push service. A burst on one page or thread within 30 s sends one push per device; at
  most 100 pending pushes per person (newer ones are dropped beyond that). Watch Server status › Web push.
- **What pushes.** A push follows a notification row: the person's push kinds (mention, assigned, reply, comment,
  approval, reminder; `updates` is off by default) and the page's visibility are checked again when it is sent.
  Automation notices (a rule's "notify" action, and "turned off after five failures") push as mentions, written
  `Alice via automation: Ping reviewer mentioned you in "Draft 3"` (a failing-rule notice has no person:
  `automation: <rule> mentioned you in "<database>"`). System notices (`workspace_added`, `workspace_deleted`,
  `webhook_disabled`, `backup_failed`, `large_page`) only show in the bell. Archiving a workspace in one's own switcher
  does not stop its pushes.

### Database automations and buttons (docs/adr/2240-* .. 2244-*)

- Rules are queued by the change-log consumer from events writers already log and run through outbox topic
  `automation` (pending and done rows in `outbox`; done rows are kept 7 days, as for every topic, which also serves
  the "date reached" dedupe). Server status shows "Database automations" (section "Reading the status summary").
- A timer per process queues "date reached" rules every 15 minutes (the first 20 s after boot), by the server's local
  date. A rule turned on after the day passed does not catch up.
- Limits per process: 30 runs per rule per minute, 120 per workspace per minute, loop depth 3, 50 runs kept per
  rule, five failures in a row turn a rule off. At most 20 rules per database, 5 actions per rule or button.
- Outbound actions go only to webhooks a workspace owner registered (Workspace settings › Webhooks), through the
  existing webhook queue.
- Nothing to configure. To stop all automations in an emergency: `UPDATE collection_automations SET enabled =
  false;` (authors turn their rules on again in the database menu › Automations).

### Web clipper (docs/adr/2260-* .. 2263-*)

- "Article text" clips make the server fetch the page: an outbound GET through the SSRF guard (public addresses only,
  each redirect checked again, at most 3 redirects, 10 s, 2 MiB read, HTML only, ports 80/443), user agent
  `Mozilla/5.0 (compatible; InklingBot/1.0)`. A server that blocks outbound traffic saves every article as a link
  (`fallback: fetch_failed`).
- Limits, in memory per process: 10 article fetches per person per minute, 2 at once per person, 8 per server; the
  route allows 30 requests per minute. Only browser sessions may fetch articles; tokens save links.
- Extraction runs on the request thread: about 0.3–0.9 s CPU for a 1.6 MB page, bounded by a cut at 20,000 tags and a
  refusal of nesting deeper than 400 levels. Article images stay on the original site (at most 100 per clip).
- `CLIP_TEST_ALLOW_LOOPBACK` is for tests only and ignored with `NODE_ENV=production`. No other variable.
- The Android share target and the bookmarklet only open `/clip` in the app; there is no proxy route to add.

### OAuth Client ID Metadata Documents (docs/adr/2280-* .. 2282-*)

| Variable | Default | Meaning |
|---|---|---|
| `OAUTH_CIMD` | off | `1` = accept OAuth clients whose `client_id` is an https URL of a metadata document |
| `OAUTH_CIMD_ALLOWED_HOSTS` | empty (any public host) | comma or space separated hosts, exact or `*.suffix`; e.g. `claude.ai` |
| `OAUTH_CIMD_TEST_ALLOW_LOOPBACK` | off | tests only: documents on `http://127.0.0.1`; ignored with `NODE_ENV=production` |

- **Outbound connections.** With it on, the server fetches the client_id URL (HTTPS GET, `Accept: application/json`)
  when a signed-in person opens a consent link and when such a connection refreshes its token after its cached copy
  expired. Through `safeFetch`: https only, public addresses only (private, loopback, link-local, CGNAT and metadata
  addresses refused; DNS pinned), no redirects, 5 KB, 5 s. Cached per URL for the response's `max-age` (60 s–24 h; 5
  minutes without one; Claude's: 5 minutes), one cache per process; while the host fails, a copy that was valid is
  used for up to 7 days. A failed URL is not fetched again for 30 s; at most 60 fetches a minute in total. A firewall
  that blocks egress breaks only these clients (they see "could not be loaded"); allow `claude.ai:443` if you limit
  egress.
- `OAUTH_CIMD_ALLOWED_HOSTS=claude.ai` is the narrow setting for a team that uses only Claude.
- Anonymous requests cannot make the server fetch: the consent info route needs a browser session, and the token
  endpoint fetches only for a refresh token it already knows. None of the document's content is logged.
- Turning it off again: connections made through it stop at their next token refresh (within an hour); they stay in
  the Connections list until disconnected. Before relying on it, run the real-client checklist at the end of
  [MCP.md](MCP.md).

### Workspace groups and archive (docs/adr/2300-* .. 2305-*)

- Nothing to configure. The rows go with the account, with the workspace's purge, and when a member leaves or is
  removed; a soft-deleted workspace keeps them for a restore. Downgrading to 0.17 leaves the two tables unused.

## 13. Public page downloads, start-up notices and onboarding (0.19)

### Public page downloads (docs/adr/2360-* .. 2363-*)

- Public links can offer a Markdown download (per link, off by default). Responses are `no-store` and
  `noindex`; they are rate-limited with the other public routes (60/min per route and IP). Downloads are
  not logged beyond the request log. Image and file addresses in the file use `PUBLIC_URL`.
- To find links with downloads on: `SELECT id, title FROM pages WHERE share_token IS NOT NULL AND share_allow_download;`
  To turn them all off: `UPDATE pages SET share_allow_download = false WHERE share_allow_download;`
- Wide view and Save as PDF run in the visitor's browser; nothing to configure.

### Start-up and screen notices (docs/adr/2324-*)

- `index.html` carries a short static notice (English and Korean) with a reload link, revealed by CSS after 12 s if
  the app's script never started. It needs no script, so the shell's `script-src 'self'` is unchanged. A proxy that
  rewrites or caches `index.html` must keep it `no-cache` (section 4) as before.
- A screen that fails to render shows "This screen could not be shown" with a Reload button and the error under
  Details. Ask people who report a blank or broken screen for that Details text.
- In a browser whose IndexedDB never answers, a page with offline copies on opens from the server after 5 s instead
  of waiting on "Connecting…". That tab then works without device copies until it is reloaded, and Settings ›
  Offline says the device storage is unavailable.

### Onboarding (docs/adr/2380-* .. 2383-*)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ONBOARDING` | on | `off` (or `0`, `false`, `no`): no intro, no Getting started card, no sample page, for everyone. Use it when your organisation has its own guide. Accounts first seen while it is off count as existing accounts if you turn it on later. |
| `ONBOARDING_EXISTING_USERS` | off | `once`: accounts that existed before onboarding (and accounts first seen while `ONBOARDING=off`) also see the intro once, on their next app load. Only the intro: their checklist stays off and no sample page is made. Stored per person (`introSeenAt`): restarts with the variable still set do not repeat it; unsetting it later changes nothing. `ONBOARDING=off` wins. |

Both are read per request and passed through by `compose.yaml`; recreate the app container after changing them
(`docker compose up -d app`). The routes are for browser sessions only; agents and tokens never see onboarding.

After setting `ONBOARDING_EXISTING_USERS=once` in `.env` and recreating the container, check that it arrived:
`docker compose exec app printenv ONBOARDING_EXISTING_USERS` prints `once` (an empty line means unset). How many
accounts it will reach: existing accounts that have not closed the intro, minus guests, who never get it ("guest" is
the rule of `audienceOf` in `apps/server/src/onboarding/state.ts`):

```sql
SELECT count(*) FROM user_onboarding o JOIN users u ON u.id = o.user_id
 WHERE (o.state->>'legacy' = 'true' OR o.state->>'off' = 'true') AND o.state->'introSeenAt' IS NULL
   AND NOT (NOT u.is_admin
     AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                      WHERE m.user_id = u.id AND w.deleted_at IS NULL AND m.role <> 'owner')
     AND EXISTS (SELECT 1 FROM page_grants g JOIN pages p ON p.id = g.page_id
                  WHERE g.user_id = u.id AND NOT EXISTS (SELECT 1 FROM workspace_members m2
                                                          WHERE m2.workspace_id = p.workspace_id AND m2.user_id = u.id)));
```

An account counts as having seen it only once it closes the intro (Skip, Esc or the last scene); closing the tab
while it plays shows it again on the next app load (KNOWN-ISSUES ONBOARD-6).

Onboarding state lives in `user_onboarding` (one row per account, deleted with the account). To show the intro
again to one person, the simplest way is theirs: Settings › About › Watch the intro again. By SQL,
`UPDATE user_onboarding SET state = state - 'introSeenAt' WHERE user_id = '…';` plays it again on their next app
load for an account made after the upgrade (or for any account while `ONBOARDING_EXISTING_USERS=once` is set).
Removing `legacy` as well (`state - 'introSeenAt' - 'legacy'`) makes an older account count as new: the checklist
comes back too, and if the account is the server's first account and an admin, its next load also makes the sample
page. The first admin of a new server gets a sample page in their private pages on their first app load; nobody else
gets one unless they press the card's button.

## 14. Columns and tabs of older releases (0.20)

### Upgrading to 0.20
One migration and no required setting: the usual procedure (Upgrades, above). Migration 0061 adds three columns to
`pages` for charts on public links (section 15); a 0.19 database goes from 61 to 62 applied migrations. Every
existing link keeps charts off, so public pages look as before until a manager (a workspace owner or admin) turns them on. Afterwards, ask people
to reload tabs they left open: a tab still running 0.19 or older can read pages with columns but not edit them
(below). Going back to 0.19.1 should need no restore (0.19 does not read the three new columns; starting it on a database
with 0061 was not tried), but 0.19's editor deletes a
group of columns with its content when it opens such a page (it has no guard); do not go back once columns are in
use. A link that showed charts and is published again while 0.19 runs keeps its chart setting (KNOWN-ISSUES SHARE-9).

### Older tabs and the document schema (docs/adr/2425-*)
- Each client sends the document schema it knows on the collaboration socket (`/collab?schema=2` in 0.20; 0.19 and
  older send nothing and count as 1). On a page holding a node type the client does not know (columns for 0.19), its
  connection is read-only. A 0.19 tab then shows the page without the group under its lock line ("Locked … You can
  read and comment, but not edit"); after a reload it runs 0.20 and edits normally. Pages without columns are not
  affected.
- When a group is added to a page a 0.19 tab has open, the server turns that connection read-only in the same
  moment and closes its socket (WebSocket close code 4000, reason `document-schema`); the tab reconnects at once.
  A few such closes in the log after an upgrade are expected.
- Reverse proxies must pass the query string of `/collab` (Caddy and nginx path rules do). Without it every tab
  counts as 0.19 and pages with columns become read-only for everyone in the browser.
- With offline copies on, edits a 0.19 tab kept on the device for a page with columns are not sent after the reload:
  they become a recovery item ("Made by an older version of the app", Settings › Offline).
- Agents and the REST API write through the server's own schema and are not affected.
- Cost: an older client's connection walks the page once (from `page_docs` when the page is not open); current
  clients pay one comparison per message.

## 15. Charts on public links (0.20)

### Charts on public links (docs/adr/2440-* .. 2444-*)
- Public links can show chart aggregates (per link, off by default), computed with the access of the owner/admin
  who turned it on (`pages.share_charts_by`) while they are a workspace member. The public page answer is cached
  per page revision for up to 10 minutes; chart numbers can be that old. Membership and the switch are read on every
  request.
- Only charts of sources approved by a manager (an owner or admin of the workspace; `pages.share_chart_sources`) are aggregated with that manager's
  access; turning charts on and "Publish these charts too" also read the link's documents (as the count below).
  Charts inside columns count and are approved like any other.
- To find links with charts on: `SELECT id, title, share_charts_by FROM pages WHERE share_token IS NOT NULL AND share_include_charts;`
  To turn them all off: `UPDATE pages SET share_include_charts = false, share_charts_by = NULL, share_chart_sources = NULL WHERE share_include_charts;`
- The share dialog's chart count reads the documents of a folder link's pages (at most 300) that contain a chart
  block: about 0.3 s for a folder of 300 large pages that all hold charts; also on every link setting change.
- Each visit of a public page with charts runs the chart aggregates when its render is not cached (the 60 s
  aggregate cache, docs/adr/1602-*, still applies); public routes stay at 60/min per route and IP.
- No new setting. Public page HTML also changed for callouts (icon, then text) and keeps text and background colours
  (docs/adr/2387-*); the in-memory render cache starts empty after the restart, so nothing needs clearing.

## 16. PDF preview (0.21)

### Upgrading to 0.21
No migration (a 0.20 database stays at 62 applied migrations), no new setting and no header change: the usual
procedure (Upgrades, above). The server code is the same as 0.20; the release changes the web app only. Ask people
to reload tabs they left open: a tab still running 0.20 shows PDFs as a file name line until it is reloaded.

### PDF preview (docs/adr/2480-* .. 2483-*)
- A PDF attached to a page shows its pages under the file name, drawn in the browser with pdf.js (`pdfjs-dist`
  6.5.438, its legacy build). The server answers `GET /files/:id` as before: `Content-Disposition: attachment`,
  `nosniff` and its `sandbox` CSP stay, and the app's CSP is unchanged. The preview fetches the file with the
  person's session like a download and runs nothing from the PDF.
- The preview's code, pdf.js, its worker (`assets/lazy/pdf.worker.min-*.mjs`) and its data files
  (`assets/lazy/pdfjs-6.5.438/`: pdf.js's `LICENSE`, cMaps, standard fonts, wasm decoders, an ICC profile and their
  licence files) are
  served by the app from its own origin. No CDN and no outbound request.
- A reverse proxy must pass `/assets/lazy/` unchanged. One that blocks or rewrites those paths stops the preview:
  it shows "The preview could not be loaded." with a download link. A proxy that serves `.mjs` with a type other
  than JavaScript also stops it, with an error message and the download link.
- Page 1 needs the whole file, because `/files/:id` sends no byte ranges. Files up to 10 MB load when the block
  comes near the screen; larger ones load when the reader presses "Load preview" (docs/adr/2482-*). At 20 Mbit/s a
  10 MB file takes about 4 s and a 25 MB file about 10 s ([PERFORMANCE.md](PERFORMANCE.md)).
- pdf.js and its files are not in the PWA precache: they are fetched the first time a preview loads a file, and the
  service worker keeps what was used in a cache of their own, `inkling-pdfjs` (60 entries, 30 days), next to
  `inkling-lazy-assets` (Shiki, exceljs). Pages without a PDF fetch none of it. Offline, the preview cannot ask the
  server for the file: it shows "The file could not be loaded." with the download link and "Try again".
  Attachments are not part of offline copies.
- Browsers: pdf.js supports its legacy build in Firefox ESR, Chrome 125+ (Edge, Opera) and "mostly" Safari 18+.
  The release was checked in Chrome 157 only (KNOWN-ISSUES PDFVIEW-1). An unsupported browser shows the preview's
  error message and the download link.
- Limits against hostile or huge files (docs/adr/2483-*): at most 5,000 pages, a page box of at most 5,000 CSS px at
  100%, one page canvas of at most 8,388,608 pixels and 8,192 px a side, at most 8 pages drawn per pass, no image
  over 2^26 pixels. A download that does not move for 30 s ends in "The file stopped loading." with "Try again". An
  error inside one preview stays in its block.
- No preview on a page with ink strokes or in pen mode (docs/adr/2481-*). A page with a PDF therefore asks for its
  strokes, `GET /api/pages/:id/ink`, when it opens, every 60 s while it is open with pen mode off, and when the tab
  comes back to the front: the server does not announce ink changes.
- No other server cost beyond the file downloads themselves and one `GET /api/files/:id/meta` per preview (kept in
  the tab for a minute).

## 17. Limits and restricted mode (0.22)

### Upgrading to 0.22
One migration, `0062_limits_accounts`, additive only: two tables (`signup_events`, `user_consents`) and four
columns (`users.expires_at`, `workspaces.storage_bytes`, `workspaces.storage_checked_at`, `workspaces.over_storage`,
all null or with a constant default). A 0.21 database goes from 62 to 63 applied migrations. Every new setting below
is optional. With none of them set the server behaves as 0.21.1, except for the changes that 0.22 makes on every
server (CHANGELOG, "What changes on every server"): every account can delete itself, a sole owner who is the only
member can leave a workspace (it is deleted at once), an owner can delete a deleted workspace for good, the
hourly housekeeping deletes `ip_bans` rows whose ban ended more than 30 days ago, the request rate limit counts an
IPv6 client by its /64, the deletion preview answers browser sessions only, account deletion finds the copied names
by the account's id only, and the OAuth token exchange is one transaction.

`compose.yaml` passes all twenty-two 0.22 variables to the app as `${VAR:-}`, and `.env.example` has a commented
example of each, so setting one in `.env` is enough. An empty value means the same as an unset one, for every one of
them. `LEGAL_DIR` is a path inside the container, so the folder has to be mounted as well (the demo overlay,
`deploy/demo/compose.demo.yaml`, shows how).

### Limits and restricted mode (docs/adr/2500-* .. 2521-*)
Restricted mode is a set of settings for two kinds of servers: an install whose operator wants to cap disk use and
the number of people, and a demo server that strangers can sign up to. Setting up a demo server, in order, is in
[DEMO.md](DEMO.md); this section is the reference.

| Variable | Format | Default | Meaning | Error when it applies |
|---|---|---|---|---|
| `LOGIN_ID_MODE` | `email` or `username` | `email` | `username`: sign-up takes an ID and a nickname instead of an email address. An ID is 3–30 characters of `a-z 0-9 . _ -`, starting with a letter or digit, stored lower-cased in the email column; reserved names (admin, root, support, inkling and others) are refused | 400 `LOGIN_ID_INVALID`, 409 `LOGIN_ID_TAKEN` |
| `SIGNUP_MAX_USERS` | whole number ≥ 1 | none | Accounts on the server in total (all `users` rows, admins included), counted again inside the sign-up transaction. The first admin made with the setup code is not refused | 403 `SIGNUP_FULL` |
| `SIGNUP_PER_IP_PER_DAY` | whole number ≥ 1 | none | Sign-ups from one address (an IPv4 address or an IPv6 /56) in 24 hours. While it is set, one address also gets at most 10 "this email or ID is taken" answers in 24 hours (below) | 429 `SIGNUP_IP_LIMIT` |
| `ACCOUNT_LIFETIME_DAYS` | whole number ≥ 1 | none | Accounts that sign up while it is set are deleted this many days after sign-up. Admins and accounts made before it was set never expire | — |
| `ACCOUNT_LIFETIME_DRY_RUN` | `1` or `0` | `0` | `1`: the hourly job logs the accounts it would delete and deletes nothing | — |
| `LIMIT_WORKSPACES_PER_USER` | whole number ≥ 1 | none | Workspaces a person owns: the one made at sign-up and deleted ones that can still be restored count | 403 `LIMIT_WORKSPACES` |
| `LIMIT_MEMBERS_PER_WORKSPACE` | whole number ≥ 1 | none | Members of a workspace, owners included; page guests are not members and do not count | 403 `LIMIT_MEMBERS` |
| `LIMIT_PAGES_PER_WORKSPACE` | whole number ≥ 1 | none | Pages of a workspace: documents, database rows, folders and canvases, the trash included | 403 `LIMIT_PAGES` |
| `LIMIT_FILE_MB` | number > 0, at most 25 (decimals allowed) | none (25 MB) | Size of one uploaded file. Connections and tokens get `min(AGENT_UPLOAD_MAX_MB, LIMIT_FILE_MB)` | 413 `LIMIT_FILE` |
| `LIMIT_WORKSPACE_STORAGE_MB` | number > 0 (decimals allowed) | none | Storage of a workspace (below). One page body may hold at most a quarter of it | 413 `LIMIT_STORAGE` |
| `LIMIT_VERSIONS_PER_PAGE` | whole number 1–50 | none (50) | Versions kept per page. It can only lower the budget of 50; the shares that AI steps may take shrink with it (40 % per connection, 60 % for all connections) | — |
| `DISABLED_FEATURES` | comma-separated names | empty | Features turned off on the whole server (below) | 404 `FEATURE_DISABLED` |
| `WORKSPACE_RESTORE_DAYS` | whole number ≥ 1 | `30` | Days an owner can restore a deleted workspace; housekeeping deletes it for good after that | — |
| `LEGAL_DIR` | path of a folder | none | Terms, privacy policy and sign-up consent (below) | 400 `CONSENT_REQUIRED` at sign-up, 403 `CONSENT_REQUIRED` on other requests |
| `INSTANCE_LABEL` | up to 20 characters, no control characters | none | A label every screen shows, for example `Demo` | — |
| `LIMIT_TRASH_DAYS` | whole number ≥ 7 | none | Upper bound of page trash retention: pages stay in the trash min(the workspace's "Keep trash for", this value) days, and MCP `list_trash` gives the same date. The stored workspace value is not rewritten; Workspace settings show the bound and do not take a larger value | 400 `LIMIT_TRASH_DAYS` when a workspace asks for more |
| `INSTANCE_NOTICE` | up to 500 characters of plain text (not HTML); line breaks allowed | none | An operator notice under the title of the sign-in, sign-up, consent and setup-waiting screens and as a strip above every app screen, which nobody can close. Shown as text, without links. For servers that send no mail: changes, interruptions, incidents | — |
| `SIGNUP_PER_HOUR` | whole number ≥ 1 | none | Accounts the whole server makes in one hour, counted again under one lock inside the sign-up transaction. The setup-code sign-up does not count and is not refused | 429 `SIGNUP_RATE_LIMIT` |
| `OAUTH_UNUSED_CLIENT_HOURS` | whole number ≥ 1 | none | Self-registered OAuth clients that were never used are deleted by the hourly housekeeping this many hours after registering (below) | — |
| `OAUTH_UNUSED_CLIENT_MAX` | whole number ≥ 1 | none | Most never-used self-registered OAuth clients kept: a new registration first deletes the oldest, never one younger than 15 minutes (below) | 503 `temporarily_unavailable` on `/oauth/register` when only younger ones are left |
| `LIMIT_WORKSPACES_TOTAL` | whole number ≥ 1 | none | Workspaces on the whole server, deleted ones that can still be restored included, counted under one server-wide lock. Sign-up makes a personal workspace, so it is refused at the limit too (the setup code is not) | 403 `LIMIT_WORKSPACES_TOTAL`; 403 `SIGNUP_FULL` at sign-up |
| `LIMIT_INSTANCE_STORAGE_MB` | number > 0 (decimals allowed) | none | Storage fuse of the whole server: the database size plus the files under the data folder, measured at most once a minute. At it the server only reads, signs in, exports and deletes (below) | 503 `INSTANCE_FULL`; 503 `temporarily_unavailable` on `/oauth/register` |

- Megabytes are 1,048,576 bytes. A value that is unset or empty means "no limit" (or off); with nothing set the
  server answers as 0.21.1 and runs none of the checks below.
- The limits are checked by the server inside the transaction that creates the page, row, file, member or
  workspace, under a lock, so concurrent requests cannot pass a limit together. Transferring ownership and restoring
  a workspace check the new owner's owned workspaces in their own transaction; the handover when an account is
  deleted does not look at the limit. MCP tools call the same REST routes
  and are refused the same way. Every limit error carries `{ limit, used }` (API.md, "v0.22.0 additions").
- `LIMIT_FILE_MB` without `LIMIT_WORKSPACE_STORAGE_MB` still lets a workspace grow without bound; with both, the worst
  case on disk is about the number of accounts × owned workspaces × the storage limit (with `LIMIT_WORKSPACES_TOTAL`,
  at most that number × the storage limit), plus what is not counted (Postgres index entries and dead rows, audit and
  notification rows, OAuth clients) and the backups. `LIMIT_INSTANCE_STORAGE_MB` is a fuse over the database and the data folder (below), not
  a bound on the disk.

### When the server refuses to start
The log names the variable and the reason. The server does not start when:
- a value cannot be read as written: not a whole number where one is needed, below 1, a decimal written with an
  exponent, `LIMIT_FILE_MB` above 25, `LIMIT_VERSIONS_PER_PAGE` above 50, `ACCOUNT_LIFETIME_DRY_RUN` other than `1`
  or `0`, `LOGIN_ID_MODE` other than `email` or `username`, an unknown name in `DISABLED_FEATURES`, an
  `INSTANCE_LABEL` over 20 characters or with a control character, `LIMIT_TRASH_DAYS` below 7, an
  `INSTANCE_NOTICE` over 500 characters or with a control character other than a line break;
- `LOGIN_ID_MODE=username` is set together with `DELEGATED_AUTH_URL`, OpenID Connect or SMTP mail, or without
  `password-reset` in `DISABLED_FEATURES` (an ID is not an address that mail can reach);
- `LEGAL_DIR` is not a readable folder, has no `signup.json`, or a file in it is malformed (below).

It starts with a warning when `ACCOUNT_LIFETIME_DRY_RUN=1` is set without `ACCOUNT_LIFETIME_DAYS`, when
`SIGNUP_PER_IP_PER_DAY` is set with `TRUST_PROXY=false`, and when a file of `LEGAL_DIR` still has template
placeholders. The start log has one line for the limits that are on, one for the features that are off and, with
`ACCOUNT_LIFETIME_DAYS`, one saying how many existing accounts it leaves alone.

### Features turned off (`DISABLED_FEATURES`)
The routes stay registered and answer 404 `FEATURE_DISABLED` before sign-in is checked. What was set up before
stops working but is not deleted, and the routes that remove it stay open, so an owner can still clean up. The app
hides the menus of a feature that is off.

| Name | Turned off | Still works |
|---|---|---|
| `public-links` | Publishing and changing public links, `/api/public/*`; `/s/:token` serves the plain app shell | Unpublishing |
| `public-forms` | Turning on and reading a form link, the public form and its answers | Removing a form link |
| `webhooks` | Listing, adding, changing, testing webhooks, their secret and deliveries; nothing is sent (queued deliveries wait) | Deleting a webhook |
| `slack` | Slack settings, test, the link flow, `/inkling` commands and events; nothing is posted | Removing the Slack settings and links |
| `link-preview` | Link preview cards (`GET /api/link-preview`) | — |
| `web-clipper` | Saving from the web (`POST /api/clip`) and its lookup | — |
| `ical` | The iCal feed URL in Settings, and `/ical/:file` answers 404 | Revoking the feed |
| `notion-import` | An import that asks for Notion is refused; a zip that looks like a Notion export is imported as plain Markdown | Markdown, zip and folder imports |
| `web-push` | Subscribing, push settings, test, and sending (queued pushes wait) | Unsubscribing a device |
| `password-reset` | Forgot password, reset with a code, and the admin's temporary password, reset code, send credentials and reset request queue | Changing your own password while signed in |
| `email-invites` | Mailing a signup key from Admin; page invitations are not mailed (the link is shown instead) | Copying keys and links |
| `automations-webhooks` | Button blocks and automation actions that call a webhook (the action is skipped, the rule stays on) | Every other automation action |
| `oauth-cimd` | OAuth Client ID Metadata Documents, also with `OAUTH_CIMD=1` | Dynamic client registration |
| `embeds` | Frames from other sites: the app's CSP keeps only `frame-src 'self'` | Page embeds of this server's pages |
| `member-direct-add` | Adding an existing account to a workspace without an invite link, and the candidate list | Invite links |

Not in the list, because they are already off until configured: experimental features (`EXPERIMENTAL_FEATURES`),
semantic search, OpenID Connect and mail. MCP stays on.

### Storage and read-only workspaces
- `LIMIT_WORKSPACE_STORAGE_MB` counts what members can grow without bound: uploaded files, page bodies, version
  history, handwriting, comments, the page rows themselves (titles, properties, icons), database fields, views and
  row templates, custom templates, the texts the change log keeps, and agent suggestions. Pages in the trash count
  until they are purged. Since 0.22.1 it also counts the rows of the search and section indexes built from the
  bodies (`page_texts`, `page_chunks`, `page_chunk_vectors`, `page_tasks`, `page_links`, `page_tags`,
  `page_former_titles`), and every file as at least 5 KB: `max(size, 4,096) + 1,024` bytes, for the disk block and
  the inode it takes (docs/adr/2545-*). Postgres index entries and dead rows, audit events, notifications, the
  outbox, per-person tables, OAuth clients and backups do not count. Without the setting none of this is counted
  (the usage card counts files at their size and leaves the indexes out, as in 0.22.0).
- The count is kept in `workspaces.storage_bytes`. Uploads add their bytes in their own transaction; each save of a
  page body adds the body's growth; housekeeping counts every workspace again each hour; Workspace settings ›
  General counts it again when the stored count is more than a minute old (at most once a minute per workspace);
  deleting for good counts it again.
- **Estimates until a recount sees them** (docs/adr/2548-*). The index rows of a saved body are written 8–30 s
  after the save, so each save also adds 2 bytes per byte the body grew, as an estimate of its index. The estimate
  stays in the count until a recount that starts after an index pass of that save has written its rows; a recount
  runs 0.5 s after such a pass, and 40 s after a save that grew a body. A recount writes what it measured plus the
  estimates it could not see yet, so `storageBytes` of the usage route can include them. The estimates are kept in
  the server's memory only: after a restart the count keeps them as written until the first recount, which counts
  what is stored then. Estimates older than 10 minutes are dropped. A save that finds the count more than 10 minutes
  old recounts the workspace after its own write.
- A workspace that has reached its limit is read-only. Every write that can grow what it keeps is refused with 413
  `LIMIT_STORAGE` (docs/adr/2533-*): new pages, uploads, imports, templates, comments and edited comment bodies,
  handwriting, manual versions, body writes by REST and MCP, quick tasks, vault sync, rows and row properties,
  database fields, views and row templates, a page's title, icon, cover, aliases and date property, and agent
  suggestions; new automations, webhooks and share links too. Live editing connections become read-only. Settings
  of bounded size replaced in place, ticking a task, membership, restoring and removing stay open (API.md lists
  them). Members see a notice above the page ("This workspace has used up its storage,
  so it is read-only. …"). Deleting pages and files,
  emptying the trash, clearing handwriting and exporting always work.
- To make it writable again, delete files or pages and empty the trash, then open Workspace settings › General
  (which counts again) or wait for the hourly count. The count that finds the workspace under its limit closes its
  read-only editing connections; they reconnect at once and can edit (KNOWN-ISSUES LIMITS-3).
- One page body may hold at most a quarter of the limit. Past that, REST and MCP writes to that page are refused
  and its live connections become read-only; splitting it into subpages is the way out (KNOWN-ISSUES LIMITS-2).
- The writes above move the stored count by the request's size at once (an upper bound), so close to the limit a
  large write can be refused although it would fit; before refusing, the server counts the workspace again when its
  count is more than 10 seconds old, which keeps that short.
- Live edits are counted when they arrive, before they are applied (docs/adr/2530-*). Since 0.22.1 an edit is
  counted with its index to come: it passes while `cached count + 3 × (unsaved growth + the edit) + the next version
  copy` stays within the limit (docs/adr/2548-*), and it counts what the document really took in, so a copy of an
  update the page already holds counts 0 bytes (docs/adr/2543-*). An edit that would take the page body past a
  quarter of the limit or the workspace past its limit, that would take the page past 300,000 Yjs structures
  (docs/adr/2540-*), or that arrives while the instance storage fuse is tripped, is not applied and not stored: the
  connection becomes read-only and reconnects read-only, and for the next 10 minutes (or until a count finds room in
  the workspace, or the server restarts) connections to that page are opened read-only. A page refused for its
  structures stays read-only for the 10 minutes even when a count finds room. What the person typed or pasted then
  stays only in their editor and on their device (KNOWN-ISSUES LIMITS-24).
- Because of the factor 3, a workspace filled through the editor stops short of its limit: with the demo preset a
  burst of pastes of about 1 MB ended at 71 % of a 10 MB limit with prose and 91 % with random words after the
  recount. REST and
  MCP body writes are checked against "full" and can end one write past it (KNOWN-ISSUES LIMITS-44, LIMITS-45).
- **When a workspace goes over its limit** (a save or a recount finds it there) or a page body over its cap, every
  editing connection to it becomes read-only at once, gets the stateless message `{"t":"storage","why":"workspace"}`
  (or `"page"`), and its socket is closed with code 4000 `storage-full`. The editor reconnects at once, read-only;
  when a recount finds room, the read-only connections are closed again and come back able to edit, without a reload
  (docs/adr/2549-*). In 0.22.0 they were closed with 4403 `permission-changed`, and the web app showed the page as
  disconnected until a reload. The web app does not show the `storage` message yet (KNOWN-ISSUES LIMITS-3).
- With `LIMIT_WORKSPACE_STORAGE_MB` or `LIMIT_INSTANCE_STORAGE_MB` set, the collaboration socket also bounds what a
  client sends: the sockets of one client address (an IPv6 /64 counts as one address since 0.22.1) share 16 MB,
  refilled at 4 MB a second, and one socket may hold at most 8 MB of messages for documents it has not opened yet;
  past either the socket is cut. With neither setting none of these checks runs, and neither do the structure cap
  and the factor 3 above.

### Instance storage fuse
`LIMIT_INSTANCE_STORAGE_MB` (docs/adr/2532-*) stops writes on a server that strangers could fill, such as a demo.
It is weaker than a filesystem with a size limit (KNOWN-ISSUES LIMITS-27); give a demo one of its own as well (below).
Since 0.22.1 it counts the disk blocks files take, and the workspaces count their search indexes, so 100 full
workspaces of the demo preset fit under its 3,000 MB (docs/adr/2545-*, 2548-*). Dead space and Postgres index entries
are still counted by the fuse and by no workspace (LIMITS-50).

- **What it measures**: `pg_database_size` of the app's database plus what every file and folder under the data
  folder (`DATA_DIR`: uploads, the import and export scratch folder, plugins) takes on disk, `max(size, blocks × 512)`
  (since 0.22.1; before, the size), walked with 64 `lstat` calls at a time. It measures at most once a minute: when a
  check finds the last measurement older than that, from the hourly housekeeping, and in the background while live
  edits arrive. Since 0.22.1 a check answers from the last measurement and measures again in the background, so a
  write never waits for the walk; only the first check after a start (or after the limit changed) waits. A failed
  measurement keeps the last answer. The log has one line when the fuse trips (`[inkling] instance storage fuse
  tripped: …`) and one when the server is under it again (`[inkling] instance storage is under its fuse again: …`).
- **What stops when it is full** (the sum has reached the limit): every POST, PUT and PATCH under `/api` answers 503
  `INSTANCE_FULL` before sign-in is checked, and so does sign-up (not the setup-code sign-up). A new OIDC account is
  refused, `POST /oauth/register` answers 503 `temporarily_unavailable`, and live editing connections become
  read-only and reconnect read-only. The app shows a strip ("This server's storage is full. For now you can only read
  and delete."), and MCP tools tell the agent not to retry.
- **What keeps working**: GET and DELETE always pass, so reading, exporting, and deleting pages, files, workspaces,
  the trash and one's own account work. Of the other writes these stay open (`quota/instanceGate.ts`): signing in and
  out, two-step sign-in, changing and resetting a password, two-step setup, agreeing to the terms, reads sent as POST
  (database query, chart aggregate, vault sync read, unlocking a public link), read marks (inbox, notifications,
  threads), what only removes or hands over (rejecting and withdrawing suggestions, unpublishing, removing guests,
  releasing connections, transferring ownership) and the admin routes (`/api/admin/**`). When a measurement finds the
  server under the limit again, writes work at once and read-only editing connections reconnect and can edit.
  Because a check answers from the last measurement, the first write after you make room can still get 503 once
  (it starts the measurement that finds the room).
- Admin › Status lists **Server storage limit** with use, limit, database and files: red when tripped, amber from
  90 %.

**A tripped fuse usually needs the operator.** Deleting rows does not make the database file smaller: Postgres keeps
the space for reuse inside each table. Measured for 0.22.0 (ADR 2532): 60 × 5 MB took the database from 11.4 MB to
322.6 MB; deleting every row left 322.6 MB; with half the rows deleted, `VACUUM` left 326.2 MB, still tripped;
`VACUUM FULL` of the table brought it to 167.0 MB and released the fuse. So members deleting pages will usually not
release it. In the 0.22.1 rehearsal (demo preset, local Docker) a tripped fuse was released this way: `VACUUM FULL`
took the database from 219 MB to 13.7 MB, and writes worked again after one more refused write. To release it:

1. Find the largest tables (with their TOAST data and indexes). Usually `page_docs` and `page_snapshots` lead.
2. Have what should go deleted: workspaces deleted for good, trashes emptied, accounts that should go deleted.
3. Run `VACUUM FULL` on those tables, one at a time. It locks the table while it runs and needs free disk about the
   size of the table's live data.
4. Or raise `LIMIT_INSTANCE_STORAGE_MB` and restart. Until one of these is done, the server only reads and deletes.

```sh
# a demo (deploy/demo/demo.sh); on a main instance: docker compose exec db psql -c "…"
deploy/demo/demo.sh exec db psql -c "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY pg_total_relation_size(oid) DESC LIMIT 10"
deploy/demo/demo.sh exec db psql -c 'VACUUM FULL page_snapshots'
```

**What the fuse cannot bound.** It does not see the WAL (up to `max_wal_size`, 1 GB by default, more while a backup
or a long transaction holds it), the backup sets, container logs (3 × 10 MB per service), what grows in the minute
between two measurements, or what still grows after it trips (sessions, audit rows of the writes that stay open).
Rewrites bloat the database too: rewriting one 5 MB value 40 times in 8 seconds grew it by 207.5 MB, and one client
address can send 4 MB a second over the collaboration socket (about 240 MB a minute), so a few addresses writing
at full rate for a minute or two can trip a 3,000 MB fuse on a demo holding 2,000 MB of counted data. Only that
server stops, but it stays stopped until the operator acts.

Disk budget for a fuse of `L` MB: live data `L` plus a minute of growth, 2 GB for the WAL (the 0.22.1 rehearsal
measured 880 MB after about 200 MB of database writes), each daily backup set at most `L` (content that does not
compress), and the logs. With the demo preset (3,000 MB, 7 daily sets) that is 3 + 2 + 7 × 3 = 26 GB in the worst
case; [DEMO.md](DEMO.md) sizes the demo's filesystem at 30 GB. Put a demo's Docker volumes on a separate filesystem with a size limit, so
that whatever the fuse misses cannot fill the disk the main instance uses.

### Terms and consent (`LEGAL_DIR`)
- The folder holds `terms.ko.md`, `terms.en.md`, `privacy.ko.md`, `privacy.en.md` (those present) and `signup.json`
  (the notice at the top of the sign-up form and the tick boxes: `id`, `required`, `label`, optional `doc` and
  `details`). [DEMO.md](DEMO.md) describes the files, and `deploy/demo/legal/` has templates.
- The server reads the folder once, at start. It refuses to start for a malformed `signup.json` (not JSON, an
  unknown key, an empty label, a duplicate id, a `doc` whose file is missing, more than 32 items) and for an empty
  document or one over 512 KB. Other files in the folder are ignored and listed in the log.
- The version is the first 12 hex characters of a SHA-256 over the documents and `signup.json`. Any edit therefore
  needs a restart, and after it everyone, admins included, agrees again before they can go on.
- Consent is asked at sign-up and stored per item (`user_consents`, with the version and the address). Accounts
  made another way (delegated sign-in, OIDC) and everyone after a change see a consent screen
  instead of the app. Until they agree, every request of theirs is refused with 403 `CONSENT_REQUIRED`: the browser,
  personal API tokens, MCP connections (the `/mcp` request itself is refused with HTTP 403) and the collaboration
  socket. Signing out, reading the documents, agreeing, and deleting the account still work: the consent screen
  has **Delete my account**, without export (export is not open before consent, and the dialog says so).
  Automation rules set up earlier keep running.
- `/terms` and `/privacy` open without signing in; the sign-in and sign-up screens and Settings link to them.

### Sign-up limits and `TRUST_PROXY`
- `SIGNUP_PER_IP_PER_DAY` needs the client's real address. It is taken from `X-Forwarded-For` only on connections
  from a `TRUST_PROXY` address. The default, `loopback,uniquelocal`, also trusts every private range (10/8,
  172.16/12, 192.168/16, fc00::/7): anyone who can reach the app port from such a network can send a made-up
  address. Set `TRUST_PROXY` to your reverse proxy's address only, and do not publish the app port beyond
  `127.0.0.1`. A sign-up that arrives from a private or loopback address is logged once as a hint that the proxy
  does not send the header.
- The sign-up limits count an IPv6 client by its /56 (one subscriber usually holds at least that much), an IPv4
  client by its address, and an IPv4-mapped IPv6 address as the IPv4 address. The request rate limit of every server
  counts IPv6 by /64; the sign-in failure bans are unchanged.
- While `SIGNUP_MAX_USERS`, `SIGNUP_PER_IP_PER_DAY` or `SIGNUP_PER_HOUR` is set, the sign-up form also has a hidden
  field that must stay empty and must have been on screen for two seconds (400 `SIGNUP_CHECK_FAILED` otherwise).
  These checks stop only simple scripts; the caps are what bound the damage, and they slow filling the server
  rather than prevent it (KNOWN-ISSUES LIMITS-10, LIMITS-28).
- `SIGNUP_PER_HOUR` counts the accounts the server made in the last hour (429 `SIGNUP_RATE_LIMIT`, "Try again in an
  hour"). The setup-code sign-up neither counts nor is refused.
- While `SIGNUP_PER_IP_PER_DAY` is set, a sign-up refused because the email or ID is taken is recorded for the
  address (in `signup_events`, as `taken:` and the address). After 10 such answers in 24 hours the address gets 429
  `SIGNUP_IP_LIMIT` for every sign-up, before the server says whether a name is taken. Without
  `SIGNUP_PER_IP_PER_DAY` nothing is recorded and the answers are not limited.
- Sign-up address records are deleted after 30 days. The hourly housekeeping also deletes `ip_bans` rows whose ban
  ended more than 30 days ago, on every server; an active ban is never touched.
- Open sign-up (`SIGNUP_REQUIRE_KEY=0`) on a server without an admin: the first account becomes the admin. Under
  restricted sign-up (`SIGNUP_MAX_USERS`, `SIGNUP_PER_IP_PER_DAY` or `ACCOUNT_LIFETIME_DAYS` set, or
  `LOGIN_ID_MODE=username`; `SIGNUP_PER_HOUR` alone is not restricted sign-up) a server without an admin refuses sign-ups without the setup code (403
  `SETUP_REQUIRED`, before any other check) and its sign-up screen only says it is waiting for its operator. Create
  the operator account with the setup link from the log (`/setup?code=…`, opened at the `PUBLIC_URL` address); after
  that, sign-up is open as configured. Sign-in still promotes: with OIDC or delegated sign-in on (possible with the
  caps or the lifetime, not with sign-in IDs), and on a server that has accounts but no admin, the first account to
  sign in becomes the admin (KNOWN-ISSUES LIMITS-19, LIMITS-20).

### Unused OAuth clients
`POST /oauth/register` needs no account, and every call stores a client row (up to about 20 KB). Two settings bound
these rows on a server open to strangers (docs/adr/2536-*). Both are off by default; without them nothing is deleted.
- **Never used** means a self-registered client (`ink_c_…`) that nothing points at: no authorization code, no grant,
  no agent access record and no agent block. An expired grant still counts as use until the hourly OAuth purge
  removes it (60 days after its last refresh). Agent connection tokens (`ink_tc_…`) and metadata-document clients
  (whose id is a URL) are never deleted this way, and neither is a client someone has connected with.
- `OAUTH_UNUSED_CLIENT_HOURS`: the hourly housekeeping deletes never-used clients registered more than this many
  hours ago.
- `OAUTH_UNUSED_CLIENT_MAX`: a registration that would pass this many never-used clients first deletes the oldest
  ones. It never deletes one registered in the last 15 minutes (someone may be on the sign-in or consent screen with
  it); when only those are left, the registration is refused with 503 `temporarily_unavailable` and `Retry-After`.
- An app whose client was deleted is refused at the authorization step (400 `INVALID_CLIENT`) and has to register
  again (KNOWN-ISSUES LIMITS-30).
- With the demo values (24 hours, 500) the never-used rows stay under about 500 × 23 KB.

### Account lifetime
- `ACCOUNT_LIFETIME_DAYS` gives an expiry date only to accounts that sign up while it is set, and never to admins.
  Turning it on later leaves existing accounts alone; turning it off stops all deletion, also for accounts that
  have a date.
- **Turning it off and on again** keeps the dates that accounts got earlier: at the next hourly run every account
  whose date passed while it was off is deleted at once. Before turning it back on, look at the dates in Admin ›
  Users and move or lift the ones that should not apply (KNOWN-ISSUES LIMITS-33).
- Each hour up to 50 expired accounts are deleted, oldest date first, each in its own transaction; a failure is
  one log line and the next account still runs. Log lines carry the account id and counts, never a name or ID.
- Start with `ACCOUNT_LIFETIME_DRY_RUN=1`: the job logs one line per account it would delete ("would delete user
  …, N workspace(s) deleted, M handed over") and deletes nothing. When the first accounts pass their date and the
  log lists exactly those, remove the value and restart.
- An expired account goes as if it had deleted itself (below). Backups keep it until they rotate out.
- Admin › Users shows the date and **Lift expiry**. `GET` and `PATCH /api/admin/users/:id/expiry` read, move or lift
  a date; they never give a date to an account that has none.

### Account deletion
- Every account can delete itself on every server (Settings › Account › **Delete account**, `DELETE /api/me`), from
  a browser session only, with the current password (and the two-step code when it is on) or, for delegated and OIDC
  accounts, within ten minutes of signing in. The only admin cannot.
- It is immediate and cannot be undone: workspaces where the person is the only member, and deleted workspaces they
  own alone that could still be restored, are deleted with their files; a shared workspace they own alone goes to its oldest admin-role member, else its oldest member (who gets
  a notification); their private pages are deleted; their shared pages, comments and versions stay without their
  name. Mentions other members wrote, and ids without a name in audit rows, stay (KNOWN-ISSUES LIMITS-8).
- Copied names are found by the account's id only: the name in audit rows (actor, target, and the names write sites
  keep beside an id) and the workspace this account made at sign-up (`<name>'s workspace`). Records of another person
  with the same name never change. A name written without an id beside it stays, also in rows 0.22.0 writes: the
  person of the page access rows (sharing a page with a person, changing or removing that access, accepting a page
  invitation) and the invited address of page invitations; rows written before 0.22.0 also keep the names of
  locking a page, changing a lock's editors, and blocking and unblocking an agent (KNOWN-ISSUES LIMITS-8).
- Since 0.22.1 the page access rows keep `personId` beside the name, so deletion clears them, and deletion also
  clears the invited address of `page.guest_invited` rows whose address is the account's own sign-in email or ID
  (docs/adr/2547-*). Rows written before 0.22.1 keep the name (KNOWN-ISSUES LIMITS-52).
- The preview of what deletion removes (`GET /api/me/delete-preview`) answers browser sessions only.
- The admin's **Delete** in Admin › Users keeps its 0.21 behaviour (409 `SOLE_OWNER`, private pages to the trash).

### Admin status
- The "Security settings" card gains two items. **Account cap**, shown while anyone can sign up: amber in
  production without `SIGNUP_MAX_USERS`. **Account lifetime**, shown while `ACCOUNT_LIFETIME_DAYS` or the dry run is
  set: amber during a dry run.
- With `LIMIT_INSTANCE_STORAGE_MB`, the storage group lists **Server storage limit** (above, "Instance storage fuse").

### Upgrading from 0.22.0 to 0.22.1
No migration and no new setting for the app (docs/adr/2540-* .. 2551-*; CHANGELOG, 0.22.1).
- **With `LIMIT_WORKSPACE_STORAGE_MB`, workspaces count more**: the search indexes and the 5 KB minimum per file are
  new in the count. A workspace near its limit can turn read-only at its first recount after the upgrade (the hourly
  housekeeping, or Workspace settings › General when its count is more than a minute old). Open Workspace settings ›
  General of your largest workspaces after the upgrade to see the new numbers. To make room: delete pages or files
  and empty the trash, or raise `LIMIT_WORKSPACE_STORAGE_MB` and restart. Without the setting nothing changes in the
  count.
- **On every server** the inbox document is read-only, awareness messages have caps (4 client ids of its own per document
  connection, other clients' states sent back not counted; new ids 64 at once then one a second per socket; 1024 ids
  per document; 16 KB per state, 1 MB per message, 256 KB per socket), and the cap of 40 collaboration sockets per
  address counts an IPv6 /64 as one address. The 40 is a constant in the code (`MAX_CONN_PER_IP` in
  `apps/server/src/collab.ts`), not a setting: many people behind one IPv6 /64 who open many tabs can get 429 on the
  socket.
- **New log lines** (every server), when the server cuts a socket that sent what the web app never sends. The line
  names the reason only, not the account or the address:
  - `[inkling] collab socket closed: awareness message` (and `awareness state`, `awareness clients`,
    `awareness new-ids`, `awareness document`, `awareness socket`, `awareness malformed`: the cap that was passed)
  - `[inkling] collab socket closed: an update to the inbox`
- With a storage limit, two new error lines of the reconnect when a workspace goes over its limit:
  `[inkling] storage close: collecting live connections failed` and
  `[inkling] reconnectWorkspaceForStorage failed`.
- **A demo started with 0.22.0** keeps its volumes on Docker's disk until it is moved: docs/DEMO.md, "Moving a demo
  from 0.22.0".

### Memory of large pages
This applies to every server, with or without limits (docs/adr/2550-*, 2551-*).
- The default `compose.yaml` runs the app with a 512 MB heap (`NODE_OPTIONS=--max-old-space-size=512`) in a 768 MB
  container (`APP_MEM_LIMIT=768m`), which leaves about 250 MB outside the heap. Buffers, Yjs documents and the parsed
  documents of a Markdown conversion live partly outside it.
- Since 0.22.1 a replace of a large range has an edit budget, so rewriting about 1 MB of different text no longer
  runs the server out of memory (before: on the second request). But rewriting about 990 KB of ordinary Markdown
  six times in a row still peaked at 832–856 MB of resident memory with a 512 MB heap (production build on macOS,
  not in a container; KNOWN-ISSUES LIMITS-54), which is more than the default container allows: the container would
  be stopped and restarted, and edits not yet saved would be lost.
- If agents or people rewrite large pages on your server, give the app more room outside the heap: for example
  `APP_MEM_LIMIT=1g` with the default heap. That value is not measured in a container; the measurements above were
  made on macOS, where resident memory can differ from a Linux container. In the demo's live-editing runs the server
  used 255–325 MB besides its heap; in the replace runs above resident memory went up to 344 MB past a 512 MB heap.
- The demo preset runs a 448 MB heap in a 768 MB container, and app, database and backup get `memswap_limit` equal to
  `mem_limit`, so a container that runs out is stopped and restarted instead of using the host's swap; `demo.sh`
  refuses a configuration without these limits ([DEMO.md](DEMO.md), "Memory").
