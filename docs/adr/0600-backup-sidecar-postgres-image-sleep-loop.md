# 0600. Backups run in a postgres:16 sidecar with a sleep loop, not in the app or cron

- Status: Accepted
- Date: 2026-11-07

## Context
The old `deploy/backup.sh` relied on the operator adding a host crontab; most self-hosters never do, and nothing told anyone when it stopped working. Backups need `pg_dump`/`pg_restore` matching the server's major version, must keep running when the app is restarting or broken, and must not add npm dependencies.

## Decision
- A `backup` service in `compose.yaml`, enabled by default, `image: postgres:16` (Debian): it already contains `pg_dump`/`pg_restore` 16, GNU `date`/`tar`/coreutils, `flock`, `openssl` and `perl` with core `JSON::PP` (verified in the image). Scripts are bind-mounted read-only from `deploy/backup/`.
- Entrypoint `backup-loop.sh`: a bash loop that wakes every 5 s, computes the next run from `BACKUP_SCHEDULE` (`daily@HH:MM`, `hourly@MM`, `every@Nm|h`, `off`) with GNU `date` in the container `TZ`, watches the trigger file, and writes a heartbeat. `BACKUP_ENABLED=0` makes it idle (compose cannot include a service conditionally on an env var without profiles).
- One-shot `backup-run.sh` does the work; `restore-test.sh`, `remote-sync.sh`, `restore-helper.sh` are separate so the host wrappers (`deploy/backup.sh`, `deploy/restore.sh`) can `docker compose exec` them.
- The pg_dump major version must match the `db` service (both 16); upgrading Postgres means bumping both.
- Exclusive `flock -n` on `/backups/.lock` for backup, restore test and restore. The kernel drops the lock when the holder dies, so there is no stale-lock heuristic; the lock file content (pid, kind, start) is informational.

## Alternatives considered
- Backups inside the Node app (spawn pg_dump): the app image is node:alpine without a matching pg_dump, and a crashed or upgrading app would also stop backups.
- Host cron + `deploy/backup.sh`: invisible to the app, easy to forget, no status.
- `postgres:16-alpine` (same image as `db`, smaller): busybox `date` cannot do `date -d "tomorrow 03:00"`, no `flock` by default; Debian is ~200 MB more disk once.
- cron inside the container (supercronic, crond): an extra binary or package and log plumbing for a single daily job.
- Off-the-shelf images (e.g. prodrigestivill/postgres-backup-local): no files backup, no restore test, no status channel for the UI.

## Trade-offs
- A sleep loop drifts by up to 5 s and misses a run whose time passes while the container is down (the next one runs on schedule; "Back up now" covers the gap).
- One more container (`mem_limit: 256m`) and a 470 MB image pull.

## How others solve it
- GitLab Omnibus: `gitlab-backup create` from cron, separate from the app process.
- Mastodon / Discourse: Discourse runs backups in-app (Sidekiq) because it ships its own pg_dump in the image; Mastodon documents host cron + pg_dump.
- Nextcloud AIO: a dedicated borg backup container driven by the master container.

## Consequences
- Backups work out of the box; operators only need to add an off-site copy (docs/BACKUP.md).

## References
- compose.yaml:90 (`backup` service), compose.yaml:78 (app read-only mount)
- deploy/backup/backup-loop.sh:23 (`next_run`), :76 (trigger), :92 (sleep)
- deploy/backup/backup-run.sh:42 (`flock -n 9`)
