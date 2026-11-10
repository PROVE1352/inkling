# 2340. Data names from one required variable: INKLING_DATA_NAME, and compose refuses without it

- Status: Accepted
- Date: 2026-11-10

## Context
Inkling started as Nodian. Up to 0.18 `compose.yaml` fixed the compose project (`name: nodian`), the
volume keys (`nodian-db`, `nodian-data`, `nodian-backups`, `nodian-backup-ctl`, the rclone overlay's
`nodian-rclone-bin`), the database role and the database (`POSTGRES_USER`/`POSTGRES_DB: nodian`, never
read from `.env`), so `docker ps`, `docker volume ls`, the deploy scripts and the docs all said
`nodian`. Renaming them in the file alone is dangerous: Docker has no volume rename, so an install
that pulls the new `compose.yaml` and runs its usual `docker compose up -d` would get project
`inkling`, create new empty volumes and an empty database, and come up as a fresh server with a setup
link, its notes apparently gone. Nothing in that path reads release notes.

Ways an install meets the new file:

| Install | What it runs on upgrade | Old names come from |
|---|---|---|
| clone, source build | `git pull && docker compose up -d --build` | `name: nodian` |
| release `compose.yaml` + GHCR image | new `compose.yaml`, `docker compose pull && up -d` | `name: nodian` |
| `compose.override.yaml` (e.g. `image: inkling:local`, `pull_policy: never`) | as above, the override is read automatically | `name: nodian` |
| `-f deploy/compose.caddy.yaml` / `-f deploy/compose.backup-rclone.yaml` | `docker compose -f … up -d` | `name: nodian`; `caddy-data`/`caddy-config` are `<project>_…` |
| `.env` with `POSTGRES_USER`/`POSTGRES_DB` | (ignored up to 0.18: the file hard-coded `nodian`) | the file |
| `COMPOSE_PROJECT_NAME` or `-p` (incl. `deploy/local.sh` trials, project `inkling-local`) | `docker compose up -d`, `./deploy/local.sh` | volumes `<project>_nodian-*`, role `nodian` |

The only thing all of them carry across an upgrade is `.env` (or the shell environment). The volumes
exist on the Docker host, but compose cannot branch on whether a volume exists.

## Decision
- **One variable names the data plumbing**: `INKLING_DATA_NAME`. It is the default project name
  (`name:`; `COMPOSE_PROJECT_NAME`/`-p` still win as before), the volume names
  (`<project>_<INKLING_DATA_NAME>-db`, `-data`, `-backups`, `-backup-ctl`, `-rclone-bin`, set with
  `name:` so the keys are plain `db`, `data`, …), and the database role and database (`POSTGRES_USER`,
  `POSTGRES_DB`, `PGUSER`/`PGDATABASE` of the db and backup containers, `DATABASE_URL`).
  `INKLING_DATA_NAME=nodian` resolves to exactly the names of 0.17.1 in every row of the table (checked
  with `docker compose config` against v0.17.1's file); `INKLING_DATA_NAME=inkling` gives
  `inkling_inkling-db`, role `inkling`, and no `nodian` anywhere.
- **No default.** `compose.yaml` uses `${INKLING_DATA_NAME:?…}` with a message that says what to put in
  `.env`: `nodian` for an install that ran 0.18 or older (keeps its data), `inkling` for a new one.
  Compose refuses before it creates anything (no container, network or volume), with every overlay and
  with `-p`/`COMPOSE_PROJECT_NAME`, and the running old stack keeps running. `.env.example` sets
  `INKLING_DATA_NAME=inkling`, so a new install made the documented way never sees the message.
- **Old names stay supported**: `INKLING_DATA_NAME=nodian` is a supported setting, not a deprecated
  one, until 1.0; `deploy/rename-from-nodian.sh` (ADR 2341) moves an install to the new names when its
  operator chooses. Removing the old-name path would be announced in the CHANGELOG one minor release
  ahead; the variable itself costs nothing to keep.
- **`deploy/local.sh`** owns the `.env` it writes: a trial `.env` without the variable (made before
  0.19) gets `INKLING_DATA_NAME=nodian` added automatically, so a trial keeps its data with no step at
  all; new trials get `inkling`.
- **`pnpm db:up`** passes `INKLING_DATA_NAME=inkling` and the development password `inkling`, so the
  development container is `inkling-db-1` with role and database `inkling`.
- **Scripts read the names, they do not know them**: `deploy/*.sh` run psql as the db container's own
  `POSTGRES_USER`/`POSTGRES_DB`, so they work on old-name and new-name installs, and on an old stack
  still running from the 0.18 file.

## Alternatives considered
- **Rename everything with defaults `inkling`** (no guard): the empty-server failure above, silently.
- **Keep `nodian` as the default and let new installs opt in to `inkling`**: existing installs need
  nothing, but every new install keeps the old name unless its operator reads about it — the opposite
  of the goal, and a hand-written `.env` gets the old name.
- **Detect old volumes at run time**: compose has no conditional; a guard container that lists volumes
  needs the Docker socket (root on the host), and a guard that mounts the old volume name creates it
  (an empty `nodian_*` volume on every new install). The app cannot tell an empty new database from a
  lost one.
- **Volumes `external: true`**: refuses when the volume is missing, which is backwards: a new install
  would need a setup step first.
- **A compatibility overlay `compose.nodian.yaml`** instead of a variable: works, but every compose
  command (and `COMPOSE` for the scripts) then needs one more `-f`, and forgetting it once is exactly
  the empty-server failure. One `.env` line is read by every command.

## Consequences
- Every install needs the line. Existing ones are told so by compose itself on their first command;
  new ones get it from `.env.example`.
- An operator who reads only "new install: inkling" and sets it on an old server gets the empty server
  after all. The old volumes are untouched then (nothing deletes them), and the documented way back is
  `INKLING_DATA_NAME=nodian` plus `docker compose -p inkling down` and `up -d`; the message names
  `nodian` first. An operator who merges new `.env.example` lines into an old `.env` by hand can do the
  same; the comment above the line in `.env.example` says it.
- Override files that name the old volume keys (`nodian-data:/…`) stop parsing (undefined volume) in
  both namings until they use the new keys; that is a loud error, not an empty volume.

## References
- compose.yaml, deploy/compose.backup-rclone.yaml, compose.local.yaml, deploy/local.sh, .env.example,
  package.json (`db:up`), deploy/signup-key.sh, deploy/reset-password.sh, deploy/cli-token.sh
- ADR 2341 (moving an install), 2342 (rename test), 1051 (published image), 2161 (local trial)
- docs/OPERATIONS.md "Upgrading to 0.19", deploy/DEPLOY.md "Upgrading to 0.19"
