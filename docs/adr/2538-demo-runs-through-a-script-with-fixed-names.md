# 2538. The demo runs through a script, with its names written out

- Status: Accepted
- Date: 2026-11-12

## Context
The demo overlay (ADR 2521) took its project, volume and database names from `COMPOSE_PROJECT_NAME`,
`INKLING_DATA_NAME` and friends. Compose lets the shell override the env file, so in a shell with
production's `COMPOSE_PROJECT_NAME=inkling INKLING_DATA_NAME=inkling` the documented command resolved to
production's project, volumes and database, and the documented `down -v` would delete production's
volumes.

## Decision
- The overlay writes the demo's names out: project `inkling-demo`, volumes `inkling-demo_db`, `_data`,
  `_backups`, `_backup-ctl`, network `inkling-demo_net`, database and role `inkling_demo`. Secrets and the
  host port have demo-only names (`DEMO_POSTGRES_PASSWORD`, `DEMO_APP_SECRET_KEY`,
  `DEMO_BACKUP_PASSPHRASE`, `DEMO_PORT`). The base file still needs `INKLING_DATA_NAME` and
  `POSTGRES_PASSWORD` to read; the env file sets them, and the overlay replaces every use.
- `deploy/demo/demo.sh` is the only way to run it: `-p inkling-demo`, both files and the demo env file on
  every call, under `env -i` with only `PATH`, `HOME` and Docker's connection variables; it stops when
  `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` or `INKLING_DATA_NAME` is set. Before `up`, `down` and `destroy`
  it checks `docker compose config` (project, every volume and network prefix, database name in the db,
  app and backup services, no port 3000, no published database port; `up` also no `CHANGE-ME`) and
  refuses otherwise. `down` never deletes volumes; `destroy` does after the project name is typed.
- The overlay requires a variable only the script sets, so plain `docker compose` with it stops.
- With `--env-file`, Compose (v5.5.0, checked) does not read the project folder's `.env`; the demo is still
  deployed from its own checkout, so production's `.env` and habits are not in that folder.

## Consequences
- The gate needs `python3` on the host to read the JSON configuration.
- A test runs the script against copies of the files with `docker compose config` only (a stand-in for
  `docker` records every other command).
