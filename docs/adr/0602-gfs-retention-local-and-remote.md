# 0602. GFS retention, applied to local and remote copies independently

- Status: Accepted
- Date: 2026-11-07

## Context
Keeping "the last N" sets either wastes space or loses history. The remote copy must follow the same policy but must never be wiped by an empty local volume.

## Decision
- `BACKUP_KEEP_DAILY=7`, `BACKUP_KEEP_WEEKLY=4`, `BACKUP_KEEP_MONTHLY=6`. Walking sets newest-first, a set is kept if it is the newest of its day / ISO week / month and fewer than N buckets of that kind have been kept (union of the three rules). The newest set is always kept. Buckets use the container `TZ`. Default ≈ 15 sets.
- Only complete sets (with `manifest.json`) and valid ids are considered; anything else in `sets/` is left alone.
- Manual and pre-restore sets are subject to the same policy (they simply compete for their day's slot).
- Remote: upload the new set (manifest last), `rclone check`, then list remote sets that have a manifest, run the same selection, `rclone purge` the rest. Never `rclone sync`.

## Alternatives considered
- Keep last N: simple, but 7 sets cover only a week.
- `rclone sync` of the whole sets directory: free retention, but a new/empty local volume (fresh server, wrong mount) would delete all remote history.
- Bucket lifecycle rules (S3/B2): provider-specific, and they cannot express GFS.

## Trade-offs
- A pre-restore set can displace the scheduled set of the same day (it is newer, so it is the day's representative).
- Remote retention needs list permissions on the remote.

## How others solve it
- restic / borg: `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6`, the same rule set.
- Proxmox Backup Server: keep-last/daily/weekly/monthly/yearly prune options.

## Consequences
- Verified in the smoke test: 200 fake daily sets + 2 real ones pruned to 15 locally; 30 remote sets pruned to 9.

## References
- deploy/backup/lib.sh:91 (`gfs_prune_list`)
- deploy/backup/remote-sync.sh (upload, check, remote prune)
