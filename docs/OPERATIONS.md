# Operations: deployment checklist, performance, caches and database tuning

Companion to `deploy/DEPLOY.md` and `docs/BACKUP.md`. Design records: `docs/adr/0750`–`0759`. Known, accepted issues: [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

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

### Database timeouts

The app sets these on every pool connection: `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 60 s, `lock_timeout` 10 s, and a 10 s `connect_timeout`. Do **not** set them at role or database level: the backup sidecar's `pg_dump` uses the same role. The backup scripts export `PGOPTIONS` with `statement_timeout=0`.

### Shutdown and crashes

- `stop_grace_period: 30s` is set on `app` in `compose.yaml`. On SIGTERM the app stops accepting collaboration upgrades, flushes open documents (10 s cap), closes HTTP (bounded), then closes the database pool. A 25 s watchdog forces exit.
- `unhandledRejection` is logged and the process keeps running. `uncaughtException` is logged and triggers the graceful shutdown above; the container restart policy brings the app back.

### Monitoring

- [ ] `GET /api/health` is liveness only. `GET /api/health/ready` runs `select 1` with a 2 s timeout (cached 5 s) and returns 503 when the database is unreachable; use it for external monitors. The compose healthcheck can keep using `/api/health`.
- [ ] Docker does not restart `unhealthy` containers; use an external monitor or autoheal.
- [ ] Watch for app restarts: a crash loop usually means the database is down or its disk is full.
- [ ] Admin › Backups shows the last success, the last restore test and the sidecar heartbeat.
- [ ] Check free disk weekly.

### Upgrades

Releases are published as a multi-arch image, `ghcr.io/prove1352/inkling:<X.Y.Z>` (also `X.Y` and
`latest`; docs/adr/1050-*). The procedure, with your `-f` files added to each compose command:

```bash
./deploy/backup.sh                 # 1. backup (ends with "ok set=<id> ...")
git pull                           # 2. compose files and deploy scripts of the new release
#    optional: INKLING_VERSION=0.3.1 in .env to pin the release (empty = latest)
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

- [ ] Take a manual backup first: `./deploy/backup.sh`.
- [ ] Do not deploy during the backup window (default 03:00).
- [ ] Never run `drizzle-kit push` against production (see section 1).
- [ ] Single app instance only: reminders, sheet sync, the webhook queue and Hocuspocus state are per process.
- [ ] After an upgrade, check the boot log for migration success and the list of enabled experimental features.

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
- The container's page cache counts against `mem_limit`. Keep `effective_cache_size` below `PG_MEM_LIMIT` minus `shared_buffers` headroom, otherwise the planner assumes cache that the cgroup will evict.
- If you use a `compose.override.yaml` that defines its own `command:` for `db`, it replaces this one entirely — merge the flags there.

### Query statistics (opt-in)

```sh
# .env
PG_PRELOAD_LIBRARIES=pg_stat_statements
docker compose up -d db
docker compose exec db psql -U nodian -d nodian -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
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

No cache holds sessions, memberships or page visibility; those are read from the database on every request. The only long-lived authorisation — an open collaboration socket — is revoked on member removal, a page becoming private, force delete and password change/session revocation (`liveConnections.ts`, ADR 0754).

## 4. HTTP caching

- `assets/*`, `workbox-*.js`: `public, max-age=31536000, immutable`. `index.html`, `sw.js`, `registerSW.js`, `manifest.webmanifest`, SPA routes: `no-cache`. Other static files: one day.
- API: `private, no-store` by default. Large GETs (page tree, graph, due list, collections) carry a weak ETag and `private, no-cache` and answer `If-None-Match` with 304 before doing the work; other GET JSON ≥ 1 KB gets a content-hash ETag.
- Compression happens only in Caddy (`encode gzip zstd`). Quick check through the proxy:

```sh
curl -sI --compressed -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages | grep -i 'etag\|cache-control\|content-encoding'
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: <etag from above>' -H "cookie: inkling_sid=…" https://<host>/api/workspaces/<id>/pages   # 304
```
