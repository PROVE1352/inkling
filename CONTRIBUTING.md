# Contributing to Inkling

Thanks for helping. This file covers the development setup, tests, commit and ADR conventions,
and the dependency policy. Security problems are **not** reported through issues or pull
requests — see [SECURITY.md](SECURITY.md).

## Development environment

Requirements: Node 22 or newer, pnpm (the exact version is pinned in `package.json`
`packageManager`; `corepack enable` picks it up), and Docker (OrbStack or Docker Desktop on macOS).

```bash
pnpm install        # never run with --no-frozen-lockfile unless you are changing dependencies
pnpm db:up          # Postgres 16 in Docker, listening on localhost:55432
pnpm dev            # server on :3001 (tsx watch) + web on :5173 (Vite)
```

Open http://localhost:5173 and sign up; the first account becomes the admin. Migrations run
automatically when the server boots; `pnpm db:migrate` applies them without starting the server.
Defaults work without a `.env`; copy `.env.example` to `.env` to change them.

Layout: `apps/server` (Fastify, Hocuspocus, Drizzle), `apps/web` (React, BlockNote),
`apps/cli` (`inklingctl`), `packages/shared` (zod schemas and DTOs shared by server and web).

## Tests

Tests use the built-in `node:test` runner through `tsx`; there is no Jest or Vitest. A test is a
`*.test.ts` file **next to the code it tests**, anywhere under a package's `src/`. The runner
(`scripts/run-tests.mjs`) discovers them, so there is nothing to register.

```bash
pnpm test                       # every package, no database needed
pnpm --filter @inkling/server test
pnpm --filter @inkling/server test -- --test-name-pattern=safeFetch   # args after -- go to node --test
pnpm -r typecheck
pnpm check:pins                 # editor dependency pins, see below
```

### Database tests

Suites whose name starts with `[db]` need a migrated scratch database and skip themselves when
`DATABASE_URL` is unset (see `apps/server/src/perf.test.ts`). `pnpm test:db` runs the server suite
with them and **fails** instead of skipping when `DATABASE_URL` is missing. Use a throwaway
database, never your development or production one — the tests insert rows and do not clean up.

```bash
docker run -d --rm --name inkling-test-db -p 55643:5432 \
  -e POSTGRES_USER=inkling -e POSTGRES_PASSWORD=inkling -e POSTGRES_DB=inkling_test postgres:16
export DATABASE_URL=postgres://inkling:inkling@localhost:55643/inkling_test
pnpm db:migrate
pnpm test:db
docker rm -f inkling-test-db
```

### Writing tests

- Keep unit tests free of network, timers longer than a second, and global state; tests run in
  parallel processes, one per file.
- A test that needs Postgres goes in a suite named `[db] …` with `{ skip: !process.env.DATABASE_URL }`
  and imports `./db` lazily inside the suite, so the file still loads without a database.
- Web tests are plain Node tests (no DOM). They start with `// @ts-nocheck` because the web
  `tsconfig` does not include Node types, and they run with the server's `tsx` (web has no `tsx`
  dependency of its own). Test pure logic — brokers, reducers, Yjs helpers — not components.
- Security-relevant code (URL fetching, plugin sandboxing, permission checks) gets tests for the
  rejected inputs, not only the accepted ones.

### Running CI locally

CI (`.github/workflows/ci.yml`) runs, in order: `pnpm install --frozen-lockfile`,
`pnpm check:pins`, `pnpm -r typecheck`, `pnpm -r test`, the server and web builds; a second job
runs migrations and `pnpm test:db` against a Postgres 16 service; a third job builds the Docker
image without pushing it. The commands above reproduce the first two jobs; `docker build .`
reproduces the third. [`act`](https://github.com/nektos/act) should also work, but is not tested.

The upgrade-path workflow (`.github/workflows/upgrade.yml`, docs/adr/1052-*) needs only Docker and
Node. Build the old release and the current tree from git (not from the working tree, so local edits
stay out), then run the same script CI runs:

```bash
git archive v0.2.0 | docker build -t inkling-upg:old -
git archive HEAD   | docker build -t inkling-upg:new -
scripts/upgrade-test/run.sh inkling-upg:old inkling-upg:new    # KEEP=1 keeps the containers
docker rmi inkling-upg:old inkling-upg:new
```

v0.1.0 has no tag; use its commit `9dc9a9bf1bb9823ead79e65d9bd79d6ca5f05d3c`. The script creates its
own `postgres:16` container, network and volume (named `inkling-upg-*`) and removes them on exit; it
never touches the `nodian` compose project.

## Commits and pull requests

- One logical change per commit. Subject line in the imperative, at most 72 characters, with an
  optional scope: `server: close collab sockets when a member is removed`,
  `web: cap the undo stack at 500 captures`, `ci: cache the pnpm store`.
- The body says *why*, and references the issue (`Fixes #123`) and ADR when there is one.
- Schema changes: edit `apps/server/src/db/schema.ts`, run `pnpm db:generate`, and commit the
  generated SQL and `meta/` together with the code. Migrations run inside a transaction at boot,
  so `CREATE INDEX CONCURRENTLY`, `VACUUM` and `REINDEX` are not allowed in them.
- Pull requests must pass CI. Fill in the template; keep unrelated formatting changes out.

## Architecture decision records

Decisions with real alternatives — data formats, protocols, security boundaries, dependencies,
performance trade-offs — are recorded in `docs/adr/NNNN-short-title.md`. Numbers are grouped by
area in blocks of a hundred (for example 01xx accounts and auth, 02xx vault sync, 06xx backups,
07xx performance); look at `docs/adr/` and take the next free number in the block for your area.

```markdown
# NNNN. Title in the form of a decision

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Alternatives considered
## Trade-offs
## Consequences
```

Keep it short and concrete: name files, functions and numbers. An ADR is not edited after it is
accepted except to change its status; a new decision supersedes it.

## Dependency policy

- Do not add a dependency for something the platform or an existing dependency already does.
  New runtime dependencies on the server need a reason in the pull request.
- `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`. If you change a
  `package.json` dependency, run `pnpm install` and commit the lockfile in the same commit.
- Dependabot opens weekly npm and monthly GitHub Actions updates; the editor stack below is
  excluded and upgraded by hand.

### Why BlockNote is pinned

`@blocknote/*` is pinned to an exact version (currently 0.51.4) in both `apps/web` and
`apps/server` (`@blocknote/server-util` renders documents on the server), because:

1. `patches/@blocknote__core@0.51.4.patch` (wired through `patchedDependencies` in
   `pnpm-workspace.yaml`) makes `getBlockFromPos` convert the node it already has instead of
   calling `editor.getBlock(id)`, which walks the whole document — O(n²) when a large document
   builds its node views. The patch is keyed to the exact version; after a bump pnpm stops
   applying it.
2. `apps/web/src/lib/codeBlockOptions.ts` mirrors the language table of `@blocknote/code-block`,
   and `apps/web/src/lib/perf.test.ts` checks it matches verbatim (ADR 0704).
3. The server converts Yjs documents with the same schema the editor writes; web and server
   must agree on the BlockNote version or stored documents can be misread.

`prosemirror-view` is forced to one version with a pnpm `overrides` entry so that BlockNote,
Tiptap and y-prosemirror share a single copy. It moves together with BlockNote.

### Upgrading the editor

1. Bump every `@blocknote/*` entry in `apps/web/package.json` and `apps/server/package.json` to
   the same exact version (no `^`).
2. Re-create the patch for the new version: `pnpm patch @blocknote/core@<new>`, re-apply the
   change, `pnpm patch-commit <dir>`; delete the old patch file and its `patchedDependencies` key.
   If upstream fixed the problem, drop the patch instead and say so in the commit.
3. Check which `prosemirror-view` the new BlockNote and Tiptap releases expect and update the
   override in `pnpm-workspace.yaml`.
4. `pnpm install`, then verify the lockfile:
   - `pnpm check:pins` — every `@blocknote/*` package resolves to exactly one version, the patch
     key matches it, and `prosemirror-view` resolves only to the override;
   - `pnpm why prosemirror-view` and `pnpm why @blocknote/core` show a single version;
   - `git diff pnpm-lock.yaml` touches only the editor packages and their transitive
     dependencies — anything else means the install resolved more than you intended.
5. `pnpm -r typecheck && pnpm test`, then test by hand: typing in a large document, real-time
   collaboration in two browsers, code-block highlighting, Markdown export/import, and opening an
   existing document created with the old version.
