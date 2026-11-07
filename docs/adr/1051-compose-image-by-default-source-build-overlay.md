# 1051. compose.yaml runs the published image; source builds stay one flag or one overlay away

- Status: Accepted
- Date: 2026-11-07

## Context
With release images on GHCR (ADR 1050), new installs should not have to build. Existing installs
and the operator's own server deploy with `docker compose up -d --build app` or
`docker compose build app` (the production server adds a `compose.override.yaml`), and those
commands must keep working after a `git pull` with no other change. Compose behaviour measured with
Compose v5.5 (2026-11-07):
- `image:` + `build:`, image not present: `up` pulls, and builds if the pull fails.
- `image:` + `build:`: `up --build` and `build` build from source and tag the result with `image:`;
  `pull` replaces that tag with the registry image (it only warns when the pull fails).
- `image:` only: `build app` prints "No services to build" and exits 0; `up --build` pulls.
- `pull_policy: never` + `build:`: `pull` skips the service, `up` builds only when the image is
  missing, `up --build` builds.

## Decision
- `compose.yaml` `app` gets `image: ghcr.io/prove1352/inkling:${INKLING_VERSION:-latest}` and keeps
  `build: .`. `INKLING_VERSION` (`.env`, without the `v`) pins a release; empty means `latest`.
- New overlay `compose.build.yaml` sets `image: inkling:local` and `pull_policy: never` for people who
  deploy from source on purpose. Those two lines can go into an existing `compose.override.yaml`
  instead, since Compose only reads the override automatically when no `-f` is given.
- Upgrades become backup → `git pull` (compose files and scripts) → `docker compose pull app` →
  `docker compose up -d app` (docs/OPERATIONS.md "Upgrades", deploy/DEPLOY.md §5).

## Alternatives considered
- **Drop `build:` from compose.yaml, build only via the overlay**: the cleanest split, but the
  production server's `docker compose build app` would silently do nothing and the next `up` would
  pull a release instead of the checked-out code. A deploy that quietly runs different code is the
  failure mode this change must not introduce.
- **Keep `build:` only, document `docker run`**: leaves the compose stack (backups, Caddy, env
  pass-through) building on small servers.
- **`pull_policy: build` in the overlay**: rebuilds on every `up`, including after a `.env` edit;
  `never` rebuilds only on `--build`, which is what source deployers already type.
- **Overlay with a different service name**: breaks the `deploy/*.sh` scripts, which address `app`.

## Trade-offs
- Without the overlay, a source build carries the published name; a later `docker compose pull`
  replaces it with the release. Documented in compose.yaml, DEPLOY.md and here; the overlay removes it.
- Installs that used plain `docker compose up -d` (no `--build`) used to keep their old `nodian-app`
  image; after this change the first such `up` pulls `latest`. For installs on a release this is the
  intended upgrade path; installs running `main` past the latest release must use the overlay.
- `latest` moves with every release; pinning `INKLING_VERSION` gives repeatable deploys.

## Consequences
- Existing commands (`up -d --build`, `build app`) behave as before; only the local image name changes.
- The operator's production server should add the overlay's two lines to its `compose.override.yaml`
  if it keeps deploying from source, or switch to `pull` + `up` once releases are published.
- A machine with no access to GHCR still works: the failed pull falls back to building.
