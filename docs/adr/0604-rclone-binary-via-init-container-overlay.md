# 0604. Off-site copies with rclone, binary copied in by an init container in an overlay file

- Status: Accepted
- Date: 2026-11-07

## Context
The 3-2-1 rule needs an off-site copy. rclone supports nearly every storage provider, but it is not in the postgres image, and installing packages at runtime (apt) is slow and network-dependent.

## Decision
- Optional overlay `deploy/compose.backup-rclone.yaml`: a one-shot `backup-rclone-bin` service (`rclone/rclone:1.68.2`, pinned) copies its static binary into a small named volume; the `backup` service mounts it read-only at `/opt/rclone` and waits for `service_completed_successfully`. The rclone config file is bind-mounted from `BACKUP_RCLONE_CONFIG` (read-write so OAuth backends can refresh tokens).
- `BACKUP_RCLONE_REMOTE` set but no binary → the run is reported as a remote failure (banner + notification), the local set is kept.
- Default compose has no rclone at all.

## Alternatives considered
- Custom Dockerfile `FROM postgres:16` + `apt install rclone`: needs a build step for every user and Debian's rclone lags behind.
- A long-running rclone sidecar watching the volume: extra process and its own scheduling/status.
- Download rclone at runtime: network dependency and an unpinned binary.

## Trade-offs
- Users must remember `-f deploy/compose.backup-rclone.yaml` on every compose command (documented).
- The binary is updated only when the pinned tag is bumped.

## How others solve it
- Nextcloud AIO, Immich docs: separate backup container or host-side rclone/borg.

## Consequences
- Smoke-tested with an on-the-fly `:local:` remote (upload, `rclone check`, remote GFS prune).

## References
- deploy/compose.backup-rclone.yaml
- deploy/backup/lib.sh:122 (`rclone_bin`), deploy/backup/remote-sync.sh
