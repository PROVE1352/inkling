# Backups and restore

Inkling ships a `backup` sidecar service in `compose.yaml`. It is **on by default**: once a day it
dumps the database, archives the data volume (uploaded files, plugins), verifies the result, keeps
a grandfather-father-son (GFS) history, test-restores a set once a week and, optionally, copies
every set off-site with rclone. Admins see the status in **Admin › Backups** and can start a backup
or download a set there. Restoring is deliberately **command-line only** (`deploy/restore.sh`).

Design notes: [ADR 0600–0607](adr/README.md#06xx-backups).

## Quick start

Nothing to do: `docker compose up -d` starts the sidecar with daily backups at 03:00 (container
time zone `TZ`). Check it:

```bash
docker compose logs backup            # "[backup] started: schedule=daily@03:00 next=..."
./deploy/backup.sh                    # take one now
./deploy/backup.sh list
```

Then do the two things nobody else can do for you:

1. **Get a copy off this machine** (3-2-1 rule, below): set `BACKUP_RCLONE_REMOTE`, or copy
   `./deploy/backup.sh copy-out <set> /mnt/usb` somewhere else regularly.
2. **Rehearse a restore** on a spare machine (see [Restore rehearsal](#restore-rehearsal)).

## Settings

All settings are environment variables in `.env`, read by the `backup` service. The admin page
shows them read-only; change `.env` and run `docker compose up -d backup` to apply.

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_ENABLED` | `1` | `0` turns the sidecar into a no-op (no scheduled or manual backups). |
| `BACKUP_SCHEDULE` | `daily@03:00` | `daily@HH:MM`, `hourly@MM`, `every@<N>m`, `every@<N>h`, or `off` (manual only). Uses `TZ`. |
| `BACKUP_KEEP_DAILY` | `7` | Keep the newest set of each of the last N days. |
| `BACKUP_KEEP_WEEKLY` | `4` | … of each of the last N ISO weeks. |
| `BACKUP_KEEP_MONTHLY` | `6` | … of each of the last N months. The newest set is always kept. |
| `BACKUP_RESTORE_TEST_DAYS` | `7` | Test-restore the newest set into a temporary database every N days (`0` = off). |
| `BACKUP_MIN_FREE_MB` | `256` | Safety margin. A run fails up front unless the backup volume has DB size + data size + this much free. Expired sets are pruned *before* this check, so a full volume frees itself. |
| `BACKUP_PASSPHRASE` | empty | Encrypt every set (see [Encryption](#encryption)). |
| `BACKUP_RCLONE_REMOTE` | empty | Off-site target, e.g. `b2:my-bucket/inkling`, `s3:bucket/inkling`, `:local:/mnt/usb/inkling`. Needs the rclone overlay. |
| `BACKUP_RCLONE_CONFIG` | `./deploy/rclone.conf` | Host path of the rclone config file (overlay only). |
| `TZ` | `UTC` | Time zone for the schedule and for GFS day/week/month buckets. |

App side (only if you change the mount points): `BACKUP_DIR` (default `/backups`) and
`BACKUP_CTL_DIR` (default `/backup-ctl`).

## What a backup set contains

Sets live in the backups volume (`inkling_inkling-backups`, in general
`<project>_<INKLING_DATA_NAME>-backups`) under `sets/<id>/`, where `<id>` is the UTC start time
`YYYYMMDD-HHMMSS`:

| File | Content |
|---|---|
| `db.dump` / `db.dump.enc` | `pg_dump -Fc` of the whole database |
| `data.tar.gz` / `data.tar.gz.enc` | tar of the app data volume (`/data`: `uploads/`, `plugins/`, …) |
| `manifest.json` | times, sizes, sha256, app version, newest migration, row count of every table |
| `SHA256SUMS` | `sha256sum -c` compatible checksums of the two payload files |

A set is built in `sets/.tmp-<id>/` and renamed into place only after every step succeeded, so a
failed or interrupted run never leaves a half set behind (leftovers are removed by the next run).

**Consistency.** The database dump is a single `REPEATABLE READ` snapshot: the sidecar exports a
snapshot, counts the rows of every table inside it and runs `pg_dump --snapshot` against it, so the
manifest's row counts are exactly what the dump contains. The file archive is taken *right after*
the dump (the manifest records both times and `consistency.gapSeconds`). In that window a newly
uploaded file is just an extra, unreferenced file in the archive (harmless); a file permanently
deleted in that window (trash purge) is missing from the archive while its row is still in the
dump. Edits typed in the last few seconds before the snapshot may not have been flushed by the
collaboration server yet.

**Verification after every run.** `pg_restore --list` on the stored dump (decrypting it when
encrypted), a full listing of the archive, and `sha256sum -c` of the written files. A run that
fails any of these is a failed run. `pg_restore --list` stops reading after the table of contents,
so the check drains the rest of the stream to the end: a dump larger than the pipe buffer (~64 KiB)
is not misreported as unreadable because of SIGPIPE, and an encrypted `.enc` file is decrypted in
full, so a truncated or corrupt file is detected.

**Restore test (weekly by default).** The newest set is restored into a temporary database
(`inkling_restoretest`) on the same Postgres server, every table's row count is compared with the
manifest, the archive entry count is compared, and the database is dropped. This temporarily needs
about the database's size again on the database server's disk and adds load for a short time.
Run one by hand with `./deploy/backup.sh restore-test`.

**Locking.** Backup runs, restore tests and restores take an exclusive `flock` on
`/backups/.lock`; a second run exits immediately. The kernel releases the lock when a process dies,
so a crash cannot leave a stale lock.

**Server-side timeouts.** Every `psql`, `pg_dump` and `pg_restore` the sidecar runs sets
`PGOPTIONS` to `statement_timeout=0`, `lock_timeout=0` and `idle_in_transaction_session_timeout=0`.
The app uses a 15 s `statement_timeout` on its own connections; backups, restore tests and restores
are not affected by it, nor by a timeout an operator sets at role or database level (client options
win).

**Retention.** The GFS policy is applied at the start of every run, before the disk space check, and
again after a successful run. A volume that filled up therefore frees itself on the next run instead
of failing forever, and the newest valid set is always kept. To skip pruning for one run:
`docker compose exec backup bash /scripts/backup-run.sh --no-prune` (the pre-restore safety backup
of `deploy/restore.sh` does this too).

## The 3-2-1 rule

Keep **3** copies of your data, on **2** different kinds of storage, with **1** of them off-site.
The sidecar alone gives you only copy #2, on the *same disk* as the database: it protects against
mistakes (deleted pages, a bad upgrade) but not against losing the server or its disk. Add one of:

- `BACKUP_RCLONE_REMOTE` (object storage, another server over SFTP, a mounted drive), or
- a host cron job that runs `./deploy/backup.sh copy-out <latest> /some/other/disk`, or
- your provider's volume snapshots of the backups volume.

## Off-site copies with rclone

```bash
# 1. create a config on any machine with rclone installed, then copy it to the server
rclone config            # e.g. a remote called "b2"
cp ~/.config/rclone/rclone.conf /opt/inkling/rclone.conf

# 2. .env
BACKUP_RCLONE_REMOTE=b2:my-bucket/inkling
BACKUP_RCLONE_CONFIG=/opt/inkling/rclone.conf

# 3. start with the overlay (adds the rclone binary to the sidecar)
docker compose -f compose.yaml -f deploy/compose.backup-rclone.yaml up -d
```

After each successful run the new set is uploaded (`manifest.json` last, so a remote set without a
manifest is incomplete and ignored), checked with `rclone check`, and then the **same GFS policy is
applied to the remote on its own**. It is intentionally not `rclone sync`: a fresh or emptied local
volume must never wipe the remote history. A failed upload is reported like a failed backup.
Use `BACKUP_PASSPHRASE` when the remote is not under your control.

## Encryption

With `BACKUP_PASSPHRASE` set, both payload files are encrypted while they are written (nothing
plaintext touches the disk):

```
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt
```

`manifest.json` and `SHA256SUMS` stay readable (they contain no note content, only table names,
row counts and checksums), so sets can be listed and verified without the key. Downloads from the
admin page are the stored, still-encrypted files. To decrypt by hand:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in db.dump.enc -out db.dump
```

> **If you lose the passphrase, your encrypted backups cannot be restored. Nobody can recover it.**
> Store it outside the server: in a password manager, and on paper in a safe place. Do not keep the
> only copy in `.env` on the machine you are backing up. Changing the passphrase only affects new
> sets; keep the old one as long as old sets are retained.

CBC with a checksum is confidentiality, not tamper-proofing: someone who can write to your backup
storage could corrupt a set (the sha256 check would notice, unless they rewrote the manifest too).

## Admin › Backups

- Status: last success and failure, next run, verification and restore-test results, remote copy,
  retention and encryption, plus the effective settings (read-only).
- **Back up now** drops a trigger file (`/backup-ctl/run.request`); the sidecar picks it up within
  a few seconds. The button is disabled while a run is queued or running.
- **Download** streams a set as an uncompressed `.tar` (admins only, browser session only).
- A red banner appears when the newest run failed, the last restore test or remote copy failed, or
  the sidecar has not reported for 10 minutes. Each such problem also creates an in-app notification
  for every admin and, when SMTP is configured, an email.

## Restoring

Restore is CLI only. `deploy/restore.sh` talks to the running `backup` service, which has the tools
and the passphrase.

```bash
./deploy/backup.sh list                         # pick a set
./deploy/restore.sh --dry-run 20261107-030000   # verify + show every step, change nothing
docker compose stop app
./deploy/restore.sh 20261107-030000             # asks you to type the set id
docker compose start app
```

What it does:

1. Prints the manifest, re-checks sha256, decrypts and runs `pg_restore --list`, lists the archive.
2. Compares the set's migration count with this checkout's `apps/server/drizzle`:
   - backup **newer** than the code: warns and asks (check out the matching version first);
   - backup **older**: fine, the app applies the newer migrations on its next start.
3. Refuses to continue while the `app` container is running (or stops it with `--stop-app`).
4. Takes a safety backup of the current state (`kind: pre-restore`) — skip with `--skip-pre-backup`.
5. `DROP DATABASE … WITH (FORCE)`, `CREATE DATABASE`, `pg_restore`, then compares every table's row
   count with the manifest.
6. Extracts the archive next to the current data, swaps it in, and compares the entry count.

Options: `--dry-run`, `--yes` (no prompt), `--stop-app`, `--skip-pre-backup`. With a non-default
compose setup pass the command: `COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/restore.sh …`.

### Restoring on a new server

1. Install Inkling as in [DEPLOY.md](../deploy/DEPLOY.md), same version as the backup if possible.
2. Put the same `BACKUP_PASSPHRASE` in `.env`, `docker compose up -d db backup` (not the app yet).
3. Copy the set into the volume: `docker cp ./20261107-030000 $(docker compose ps -q backup):/backups/sets/`
   (or let rclone fetch it: `rclone copy b2:my-bucket/inkling/20261107-030000 …`).
4. `./deploy/restore.sh --skip-pre-backup 20261107-030000`, then `docker compose up -d`.

### Restore rehearsal

A backup you have never restored is a hope, not a backup. The weekly restore test proves that the
dump loads and is complete, but not that *you* can bring the service back. Every few months:

1. Start a throw-away copy on another machine or a different compose project name
   (`docker compose -p inkling-rehearsal …`, with a different host port).
2. Restore the newest off-site set there, following "Restoring on a new server".
3. Log in, open a few pages and attachments, then `docker compose -p inkling-rehearsal down -v`.

Note how long it took; that is your real recovery time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "not enough free disk space" | Expired sets were already pruned before this check, so the retained sets plus this run do not fit. Free space on the backup volume, lower `BACKUP_KEEP_*` (applied on the next run), lower `BACKUP_MIN_FREE_MB`, or move the volume. |
| "set is encrypted but BACKUP_PASSPHRASE is not set" | Put the passphrase that was used for that set into `.env`. |
| "backup service has not reported" | `docker compose ps backup`, `docker compose logs backup`. |
| "rclone binary missing" | Start with `-f deploy/compose.backup-rclone.yaml`. |
| rclone: "config file … is a directory" | `BACKUP_RCLONE_CONFIG` must point to an existing file before `up`; otherwise Docker creates an empty directory at that path. Remove it, create the file, `up -d` again. |
| pg_dump version mismatch after upgrading Postgres | The sidecar image major version must match the `db` service (both 16). |
