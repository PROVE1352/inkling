# 0601. Backup set = dump + data archive + manifest, one exported snapshot, DB before files

- Status: Accepted
- Date: 2026-11-07

## Context
A restore needs the database and the uploaded files from (nearly) the same moment, a way to prove a set is complete, and enough metadata to warn about version mismatches. Postgres and the file volume cannot be snapshotted atomically together.

## Decision
- One directory per set, `sets/<UTC YYYYMMDD-HHMMSS>/`: `db.dump[.enc]` (`pg_dump -Fc`), `data.tar.gz[.enc]` (tar of the whole `/data` volume: uploads, plugins), `manifest.json`, `SHA256SUMS`.
- Built in `sets/.tmp-<id>` and renamed into place only after every step and check succeeded; any failure (ERR/INT/TERM trap) deletes the temp dir; the next run removes leftovers under the lock. Incomplete sets are never visible to the app, retention or restore.
- Snapshot: a long-lived psql coprocess runs `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY; SELECT pg_export_snapshot()`, counts the rows of every table in that snapshot, and `pg_dump --snapshot=<id>` dumps exactly that state. The manifest's `db.rowCounts` therefore describe the dump, which makes the restore test (ADR 0606) an exact comparison.
- Order: database first, then files. Window documented in the manifest (`consistency.*`, `gapSeconds`). An upload during the window is an extra unreferenced file (harmless, housekeeping removes it); a hard delete during the window (trash purge) leaves a row without its file. Uploads are far more frequent than purges, so DB-first loses less.
- GNU tar exit 1 ("file changed as we read it") on the live volume is a warning; exit ≥ 2 fails the run.
- Manifest also records app version and newest migration tag (written by the app into `/backup-ctl/app-info.json`, ADR 0605) and `drizzle.__drizzle_migrations` count/last timestamp read from the DB itself, used by `restore.sh` to warn about version mismatches.
- Disk check before writing: free space on the backup volume ≥ DB size + data size + `BACKUP_MIN_FREE_MB`, otherwise the run fails with a clear message.
- Files are created with `umask 077`.

## Alternatives considered
- `pg_dumpall` / plain SQL: larger, no selective restore, slower `--list`.
- Physical backups (pg_basebackup + WAL archiving, pgBackRest): point-in-time recovery, but far more moving parts for a single-node note app.
- Files first, then DB: every upload in the window becomes a dangling reference.
- Filesystem/volume snapshots: not portable across hosts and providers.

## Trade-offs
- Not point-in-time: RPO is the schedule interval (default 24 h).
- Uploads deleted in the window are missing from that set.

## How others solve it
- GitLab: `gitlab-backup` tars DB dump + uploads/repos into one archive with `backup_information.yml` (version, timestamp) and refuses to restore across versions.
- Discourse: one `.tar.gz` with `dump.sql.gz` + uploads and a meta file; restore checks the migration version.

## Consequences
- Every set is self-describing and verifiable without the app (`sha256sum -c SHA256SUMS`).

## References
- deploy/backup/backup-run.sh:91 (coproc), :104 (`pg_export_snapshot`), :141-143 (`pg_dump --snapshot`), :159-172 (tar), rename into place after `sha256sum -c`
- deploy/backup/lib.sh:7 (`umask 077`)
- apps/server/src/backup/store.ts (`writeAppInfo`)
