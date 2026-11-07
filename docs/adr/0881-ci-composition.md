# 0881. CI: three jobs — check, database, Docker image

- Status: Accepted
- Date: 2026-11-07

## Context
There was no CI. The project is a pnpm 11 workspace (exact pin `pnpm@11.25.0` in
`packageManager`; the Dockerfile notes that a floating `pnpm@11` once resolved to a broken
release), targets Node 22 (`node:22-alpine` image, tsup `target: 'node22'`), needs Postgres 16 with
`pg_trgm` for some tests, and ships as a Docker image built from the repository's Dockerfile.

## Decision
`.github/workflows/ci.yml`, on push to `main`, pull requests and manual dispatch:
- **check**: `pnpm install --frozen-lockfile`, `pnpm check:pins` (ADR 0882), `pnpm -r typecheck`,
  `pnpm -r test` with `DATABASE_URL` unset, `pnpm --filter @inkling/server build` (tsup),
  `pnpm --filter @inkling/web build` (Vite).
- **db**: a `postgres:16` service with a health check, `pnpm db:migrate` (drizzle-kit, same
  `drizzle/` journal the server's boot migrator uses), then `pnpm test:db`.
- **docker**: `docker/build-push-action` with `push: false` and the GitHub Actions cache.
- `pnpm/action-setup` without `version:` so it reads `packageManager`; `actions/setup-node` with
  `cache: pnpm` caches the store keyed on the lockfile.
- `permissions: contents: read`; concurrent runs of the same pull request are cancelled.

## Alternatives considered
- One job doing everything: the database and Docker steps are the slowest and fail for different
  reasons; separate jobs run in parallel and report separately.
- Running migrations by booting the server: needs a full server environment and a readiness
  probe; drizzle-kit applies the same files with the same journal table.
- Pushing the image from CI: no registry or release process is defined yet; building it is
  enough to catch Dockerfile breakage.
- A Node version matrix: only Node 22 is deployed.

## Trade-offs
- Each job installs dependencies separately (cached store, so mostly linking time).
- The Docker job repeats the web and server builds inside the image; it only checks that the
  image builds, not that it starts.

## Consequences
- A pull request cannot merge with a lockfile that disagrees with `package.json`, an editor pin
  drift, a type error, a failing unit or database test, a broken migration, or a broken image build
  (once branch protection requires the three jobs).
- CONTRIBUTING.md documents how to reproduce each job locally.
