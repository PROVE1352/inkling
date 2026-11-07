# 0605. App ↔ sidecar via shared files; read-only settings in the UI; restore is CLI only

- Status: Accepted
- Date: 2026-11-07

## Context
Admins should see backup health and start a backup from the web UI. The app must not get database superuser tools or the passphrase, and a web-triggered restore (which drops the database the app is serving from) is too dangerous for v0.

## Decision
- Two volumes: `nodian-backups` (sets + `status.json`) mounted **read-only** in the app, and `nodian-backup-ctl` (read-write in both) for `run.request` (trigger) and `app-info.json` (app version + newest migration, written at app boot).
- The sidecar writes `status.json` atomically (tmp + rename, perl JSON::PP) with `running`, `heartbeatAt`, `nextRunAt`, `lastSuccess`, `lastFailure`, `lastVerify`, `lastRestoreTest`, `remote` and its effective `config`; the app only reads it.
- "Back up now": `POST /api/admin/backups/run` creates `run.request` with `O_EXCL` (`flag: 'wx'`) → two clicks or two admins queue exactly one run (409 `BACKUP_QUEUED`); 409 when running, 503 when the sidecar's heartbeat is older than 10 minutes. The sidecar renames it to `run.processing` while working.
- Download: `GET /api/admin/backups/:id/download` streams `tar -cf -` of the set directory (stored files as-is, so encrypted sets stay encrypted). Set ids are validated against `^\d{8}-\d{6}$` before any path is built. Admin + browser-session only (`requireAdmin` rejects MCP tokens).
- Settings are env-only and displayed read-only (from `status.json.config`); editing them in the UI is out of scope for v0.
- Restore only via `deploy/restore.sh` (verify → migration check → app must be stopped → automatic pre-restore backup → DROP/CREATE + pg_restore → swap data volume contents → row/entry count checks, `--dry-run`).

## Alternatives considered
- Status in a DB table written by the sidecar: works, but downloads still need file access, and it couples the sidecar to the app schema.
- HTTP API in the sidecar: needs a server in the postgres image (none available without new packages).
- Docker socket in the app to run commands: equivalent to root on the host.
- UI-editable settings (stored in the DB, read by the sidecar): more surface (validation, secrets in the DB for the passphrase/remote) for little gain.
- UI restore: one mis-click replaces all data while users are connected; recovery would also need the app to be stopped.

## Trade-offs
- `compose.yaml`'s `app` service gains two mount lines (the only change to an existing service).
- Status is eventually consistent (heartbeat 60 s, UI polls 4 s while running, 60 s otherwise).

## How others solve it
- Discourse: admin UI can both back up and restore, but restore first puts the site into read-only mode and is disabled by default (`allow_restore` setting).
- GitLab: backups and restores are CLI only (`gitlab-backup`), the UI shows nothing.

## Consequences
- The web UI can never destroy data; the CLI path is documented and dry-runnable.

## References
- compose.yaml:76-79 (app mounts), :90 (backup)
- apps/server/src/backup/store.ts:120 (`currentAlert`), :231 (`writeTrigger`, `wx`)
- apps/server/src/backup/routes.ts:84 (tar stream)
- deploy/restore.sh, deploy/backup/restore-helper.sh:46 (`DROP DATABASE … WITH (FORCE)`)
