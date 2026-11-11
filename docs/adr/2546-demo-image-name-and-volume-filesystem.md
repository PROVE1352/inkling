# 2546. The demo runs its own image name, with its volumes on a filesystem of their own

- Status: Accepted
- Date: 2026-11-12

## Context
The second review (N8) found that the demo overlay kept the base file's image,
`ghcr.io/prove1352/inkling:${INKLING_VERSION:-latest}`. A demo `up` that built from a checkout, or a demo
pull, changed the image that production's next `up` would run. The review also found that the demo's
volumes were named volumes on the host's Docker disk. The fuse (ADR 2532, 2545) does not see the WAL, the
backups or the logs. So the demo could fill the disk the production instance uses.

Contract §15's stop rule: what must hold is that a demo user cannot reach the production instance (its disk,
memory, CPU, image tag or cookies). The demo staying up does not have to hold. The protection is a
filesystem with its own size and inode limits, which the operator makes on the server, plus the
containers' memory, CPU and pids limits.

## Decision
- `compose.demo.yaml` sets `app.image: ${DEMO_IMAGE:?}`. `demo.sh` refuses a configuration whose app image is
  `ghcr.io/prove1352/inkling` or has no `demo` in its last path part. `build` is the base file's `.`, so
  `up` builds the demo's tag when it is missing, and the new `demo.sh build` rebuilds it after an update.
  Production's tag is never written.
- Each of the four volumes (`inkling-demo_db`, `_data`, `_backups`, `_backup-ctl`) is a local-driver bind of
  `${DEMO_VOLUME_ROOT}/<name>`. Their names stay the demo's, so the name gate of ADR 2538 still applies.
- The gate also checks that every volume is that bind, that the root is the same for all four and not `/`,
  and that `DEMO_VOLUME_ROOT` is written as an absolute path in the env file. Compose would make a relative
  path absolute under the checkout. Before `up` it also checks that the folder exists and that its
  `st_dev` differs from `/` and from Docker's data folder when that is on this machine (`docker info`). If
  any check fails, `up` is refused. `DEMO_ALLOW_SHARED_DISK=1` set in the shell for that one command lets
  `up` go on with a `WARNING` line, for a trial on a laptop. Then `up` makes the four folders.
- `destroy` removes the containers, the volume objects and the demo image. It never deletes files on the
  host: it prints where the data still is. A wrong `DEMO_VOLUME_ROOT` must never become a deletion of
  someone else's folder.
- How to make the filesystem, and the sizing rule (fuse + 2 GB of WAL + backup sets × fuse + headroom; the
  template's example is 30 GB for a 3,000 MB fuse and 7 daily sets), are in docs/DEMO.md. The operator does
  this on the server; the repository does not.

## Consequences
- macOS reports one `st_dev` for `/`, `/Users` and `/private`, so a local trial needs a mounted disk image or
  `DEMO_ALLOW_SHARED_DISK=1`. Docker Desktop binds a mounted `hdiutil` image (checked in the 0.22.1
  rehearsal).
- The rehearsal measured the WAL at 880 MB after about 200 MB of database writes, inside the demo
  filesystem. The fuse does not count it.
- An existing 0.22.0 demo had named volumes on Docker's disk. Moving it means `destroy` (after an export)
  and an `up` on the new root; nothing moves by itself.
