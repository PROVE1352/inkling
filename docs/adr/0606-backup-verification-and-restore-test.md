# 0606. Verify every set; test-restore weekly into a temporary database

- Status: Accepted
- Date: 2026-11-07

## Context
A backup that cannot be restored is worse than none because it creates false confidence. Checks must be automatic and visible in the UI.

## Decision
- After every run: `pg_restore --list` of the stored (decrypted) dump must list > 0 entries, the archive must list completely (`tar -tz`), and `sha256sum -c` must pass on the written files. Any failure fails the run (no set is published).
- Restore test every `BACKUP_RESTORE_TEST_DAYS` (default 7, 0 = off) after a successful scheduled/manual run, or on demand (`./deploy/backup.sh restore-test`): `CREATE DATABASE inkling_restoretest`, `pg_restore --no-owner --no-privileges --exit-on-error`, compare `count(*)` of every table with the manifest's snapshot counts (exact, ADR 0601), compare the archive entry count, `DROP DATABASE … WITH (FORCE)`. The result is shown in Admin › Backups and a failure raises an alert.

## Alternatives considered
- Only `pg_restore --list`: proves the TOC is readable, not that data loads (constraint failures, truncated data blocks).
- Restore test in a separate Postgres container: isolates load from production but needs Docker access or another always-on service.
- Checksums only: catch bit rot, not a logically broken dump.

## Trade-offs
- The restore test temporarily uses about the database's size again on the DB server's disk and adds a short load spike on the production Postgres.
- It does not test the application against the restored data (documented "restore rehearsal" covers that).

## How others solve it
- pgBackRest: `verify` command checks checksums; restore testing is left to the operator.
- Many SRE guides (and Google's SRE book) recommend automated periodic restore tests over trusting backup success.

## Consequences
- Smoke test: wrong passphrase → `restore test failed: pg_restore failed: … not a valid archive`, banner + alert; correct passphrase → "29 tables, 35 rows match", alert cleared.

## References
- deploy/backup/backup-run.sh (section "3. verification")
- deploy/backup/restore-test.sh
