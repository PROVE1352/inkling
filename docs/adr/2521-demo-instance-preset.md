# 2521. Demo preset: an overlay on compose.yaml that cannot start without its limits

- Status: Accepted
- Date: 2026-11-12

## Context
The demo runs on the same machine as an instance with real accounts. Started by mistake with the
production environment it would share the volumes; started without its settings it would be a public
server with no limits. `compose.yaml` passes only the variables it lists, and none of the 0.22 ones.

## Decision
- `deploy/demo/compose.demo.yaml` is an overlay on `compose.yaml` (same image, backup sidecar and health
  checks). Its project name comes from `INKLING_DEMO_PROJECT`, which only the demo env file sets, so with
  the production `.env` interpolation fails. Every demo setting is written `${VAR:?…}`: a missing line
  refuses to start.
- It passes the 0.22 settings, mounts the terms folder read-only at `/legal`, publishes no database port
  (`!override []`), names its network after the project, sets memory, CPU and process limits on the app,
  database and backup containers, and keeps backups 7 daily, 0 weekly, 0 monthly.
- `deploy/demo/demo.env.example` has the values of the contract (section 11) with secrets as placeholders;
  `demo.env` is git-ignored. `deploy/demo/legal/` holds the templates with their four placeholders.
- `docs/DEMO.md` gives the order: separate instance on localhost, operator account with the setup code,
  terms folder, proxy, checks.

## Consequences
- Run from the repository root with `--env-file deploy/demo/demo.env -f compose.yaml -f
  deploy/demo/compose.demo.yaml`. A new 0.22 setting has to be added to the overlay to reach the demo.
