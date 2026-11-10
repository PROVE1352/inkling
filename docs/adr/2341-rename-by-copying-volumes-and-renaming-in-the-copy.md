# 2341. Moving an install to the new names: copy the volumes, rename the role in the copy

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 2340 lets an install keep the old data names with `INKLING_DATA_NAME=nodian`. Moving it to
`inkling` means new volume names (Docker cannot rename a volume), a new database role and database
name, and a new compose project, without losing data and with a way back. Facts that shape it:

- The role an install connects as is the cluster's bootstrap superuser (`POSTGRES_USER`). A session
  cannot rename its own role, and the official image has no second superuser.
- Renaming a role clears an MD5 password (the name is its salt) and keeps a SCRAM-SHA-256 one. Postgres
  16 clusters made by the image store SCRAM; one carried over from older settings may not.
- Ownership, grants, default privileges, sequence ownership and extension ownership (`pg_trgm`) point at
  the role's OID, so they follow a rename. A database cannot be renamed while anyone is connected to it.
- `pg_hba.conf` of the image trusts local socket connections and asks every network connection for a
  password, for all roles; a hand-edited one may name the role or database.
- Backup sets are restored with `pg_restore --no-owner` as the sidecar's `PGUSER`, so sets made under
  the old role restore under the new one.

## Decision
`deploy/rename-from-nodian.sh` (`--dry-run`, `--yes`, `--rollback`), run from the install's folder
with its usual compose files (`compose.override.yaml`, `COMPOSE_FILE`, or `COMPOSE="docker compose -f …"`):

1. **Find the stack, refuse a stranger's.** Old and new names come from `docker compose config` with
   `INKLING_DATA_NAME` set either way, so overrides, `-p` and `COMPOSE_PROJECT_NAME` count. Every volume
   whose name differs between the two is paired (database, data, backups, backup control, rclone binary,
   Caddy's certificates when the project name changes, an operator's own volumes). Containers of the old
   project must have been started from this folder (`com.docker.compose.project.working_dir`). A volume
   with another driver or options (a bind mount) is refused with instructions instead of being copied
   to the Docker disk.
2. **Plan**: sizes (`du` in the db image), free space on the Docker disk, expected downtime. It refuses
   with less free space than the copies plus a dump plus 256 MB, and warns under twice the volumes.
3. **Before the stop**: `/api/health/ready`; stop the app (it flushes open documents); a pre-rename
   backup through the sidecar (`backup-run.sh --kind manual --no-remote --no-restore-test --no-prune`),
   or `pg_dump -Fc` into `./backups/rename-<from>-to-<to>/` when no sidecar runs (local trials,
   `BACKUP_ENABLED=0`); every table's row count; `docker compose down` (never `-v`). It checks that no
   container uses an old volume and that the old cluster left no `postmaster.pid`.
4. **Copy** each old volume into a new one created with compose's labels and a
   `io.inkling.renamed-from=<old>` label (`cp -a` in the db service's own image, `--network none`; the old
   volume is mounted read-only), then compares entry counts and byte totals.
5. **Rename inside the copy** on a temporary server (`--network none`, socket only, an hba file of its
   own that trusts local connections, so the copy's `pg_hba.conf` and passwords play no part): create a
   temporary superuser, `ALTER ROLE nodian RENAME TO inkling`, set the password again from `.env`
   (covers MD5; the value is read inside the container from an environment variable, never on a command
   line), `ALTER DATABASE nodian RENAME TO inkling` from the `postgres` database, drop the temporary
   superuser. It prints the password type, the database owner, the extensions and their owners, warns
   about tables owned by another role, rewrites `pg_hba.conf` lines that name the old role in the copy,
   and compares every table's row count with step 3.
6. **Switch** `.env` to `INKLING_DATA_NAME=inkling` (and `COMPOSE_PROJECT_NAME` when it was `nodian`),
   keeping a copy of the old `.env`. Override lines that name the old name are listed, not edited.
7. **Start and check**: `up -d --no-build --pull never` (the same image as before; the rename never
   changes the version), `/api/health/ready`; migrations equal to step 3 and accounts, pages, collection
   rows, share links and files not fewer (the exact every-table check was step 5; the app is live now and
   people may already be writing), the data volume's file count, and one backup through the sidecar under
   the new names. It ends with the `docker volume rm` line for the old volumes, which it never runs.

**Resumable and reversible.** Each step is recorded in `./backups/rename-<from>-to-<to>/state` and
checks its own result again: a copy without its record is made again (only into a volume carrying this
script's label; any other non-empty volume is refused), the role and database renames look at the
catalog and skip what is done, a leftover temporary server is replaced. The old volumes are only ever
read, so `--rollback` works from any point: it stops the new stack, writes the old name back into
`.env` and starts the old names; a later run starts over (the copies are made again). If the old stack
was started by hand after an interrupted run, the script notices and starts over too. Only writes made
under the new names are lost by a rollback, and the script says so.

**Recommended order**: upgrade first with `INKLING_DATA_NAME=nodian` (the new release migrates the old
data), check it, then rename. The two risks stay apart, and the migration count is the same before and
after the rename.

## Alternatives considered
- **Keep the old volumes and only map names** (`name: nodian_nodian-db` under the new keys, role and
  database renamed in place): no copy, no extra disk, no copy time. But `nodian` stays in the volume
  names forever, and an in-place role rename leaves no pristine old state: rolling back means renaming
  back by hand, and a failure halfway leaves a cluster neither file can start. For the installs this is
  for (a 65 MB dump), a copy costs seconds and twice a few hundred MB.
- **Rename in place in the old volume**: the same problem; the old volume is the way back.
- **Dump and restore into a fresh cluster** instead of copying files: slower, needs the restore to
  recreate extensions and settings, and loses `ALTER SYSTEM`/`pg_hba.conf` customisations and the
  statistics; a file copy of a cleanly stopped cluster is exact.
- **Rename through the running app's connection**: impossible (own role, connected database).
- **Single-user mode** (`postgres --single`): its session user is the bootstrap superuser, which is the
  role to rename.
- **`docker volume` copy tools** (`docker run … alpine`, rsync images): another image to pull; the db
  service's image is already there and has `cp -a` and `du`.

## Consequences
- Twice the volume size on disk until the operator removes the old volumes (the script prints the
  command). Downtime is about a minute for a small install: app stop, dump, copy, rename, boot.
- A rollback after the operator removed the old volumes is a restore from the pre-rename backup.
- Containers that are not part of the compose project but are named after it (`nodian-backup-1` in a
  cron line or another stack's `external_links`) need the new name; the script warns about such
  containers it can see, not about scripts.

## References
- deploy/rename-from-nodian.sh, deploy/backup/backup-run.sh, deploy/backup/restore-helper.sh
- ADR 2340 (INKLING_DATA_NAME), 2342 (rename test), 0600/0605 (backup sidecar, restore)
- docs/OPERATIONS.md "Upgrading to 0.19", deploy/DEPLOY.md "Upgrading to 0.19"
