# AGENTS.md

Guide for coding agents working on this repository. Every rule below already lives in the linked
document; follow the source when they differ.

## Layout
- `apps/server` — Fastify 5, Hocuspocus/Yjs collaboration, Drizzle 0.45 + Postgres 16, MCP server (`src/mcp.ts`, `src/mcpTools/`).
- `apps/web` — React 19 + BlockNote editor (PWA).
- `apps/cli` — `inklingctl`.
- `packages/shared` — zod schemas and DTOs shared by server and web.
- `docs/` — API contract (`API.md`, the source of truth for routes), operations, ADRs (`docs/adr/`).

## Commands ([CONTRIBUTING.md](CONTRIBUTING.md))
```bash
pnpm install            # frozen lockfile; never change dependencies casually
pnpm db:up              # Postgres 16 in Docker on localhost:55432
pnpm dev                # server :3001 + web :5173
pnpm test               # unit tests, all packages ([db] suites skip without DATABASE_URL)
pnpm test:db            # server tests incl. [db] suites; needs a migrated throwaway DATABASE_URL
pnpm -r typecheck
pnpm check:pins         # editor dependency pins
pnpm db:generate        # after editing apps/server/src/db/schema.ts
```
CI (`.github/workflows/ci.yml`, Node 22) runs check:pins, typecheck, tests, both builds, then
migrations + `pnpm test:db` against Postgres 16, then a Docker build.

## Hard rules
- **Editor pins**: `@blocknote/*` is pinned to 0.51.4 (server and web), patched via
  `patches/@blocknote__core@0.51.4.patch`; `prosemirror-view` is forced to one version (1.42.4) by a
  pnpm override. Do not bump them outside the upgrade procedure in CONTRIBUTING.md.
- **Dependencies**: no new dependency for something the platform or an existing dependency does;
  lockfile changes only together with a `package.json` change ([ADR 0882](docs/adr/0882-dependency-policy.md)).
- **Migrations**: edit `schema.ts`, run `pnpm db:generate`, commit SQL + `meta/`. Migrations run in a
  transaction at boot: no `CREATE INDEX CONCURRENTLY`, `VACUUM` or `REINDEX`. Never run
  `drizzle-kit push` against production — it drops hand-written indexes ([KNOWN-ISSUES](docs/KNOWN-ISSUES.md)).
- **Tests**: `node:test` via tsx, `*.test.ts` next to the code; database suites are named `[db] …`,
  use `{ skip: !process.env.DATABASE_URL }` and import `./db` lazily ([ADR 0880](docs/adr/0880-test-strategy-node-test-tsx.md)).
  Use a throwaway database; tests do not clean up.
- **Permissions**: page access = workspace membership + `visibleTo` (private pages are the author's
  only) + live page + live workspace (`pageDto.ts`, `workspaceLive.ts`, `helpers.ts requireMembership`).
- **Derived indexes** (`page_texts`, `page_links`, `page_tags`, `page_tasks`, `page_chunks`) are
  rebuilt from `page_docs`; a new writer of documents must reindex ([ADR 0750](docs/adr/0750-collab-store-path-db-side-snapshot-debounced-diffed-indexing.md), [ADR 0926](docs/adr/0926-section-index-and-stable-anchors.md)).
- **ADRs** for decisions with real alternatives: `docs/adr/NNNN-title.md`, next free number in the
  area block, listed in `docs/adr/README.md`.
- **Performance changes** must add a row to [docs/PERFORMANCE.md](docs/PERFORMANCE.md) with
  before/after numbers and the method (data size, conditions, tool), including measured-and-rejected ones.
- **Security reports** go through [SECURITY.md](SECURITY.md), never issues.

## MCP server
- Tools call the REST routes through `call()` (`app.inject` as the token's user) so permissions equal
  the web app; read tools use `GET` routes; write tools use `wrapWrite` (read-only tokens,
  [ADR 0935](docs/adr/0935-oauth-read-write-scopes.md)).
- Tool output is compact text, deterministic for the same input and documents
  ([ADR 0937](docs/adr/0937-prompt-cache-friendly-deterministic-tool-output.md)); errors say what to do next
  ([ADR 0929](docs/adr/0929-agent-facing-instructions-errors-and-repo-guides.md)).
- Agent usage guide: [docs/MCP.md](docs/MCP.md).
- **Edit lock** ([ADR 0970](docs/adr/0970-subtree-edit-lock.md), [0971](docs/adr/0971-lock-evaluation-order-people-and-agents.md)):
  every new write path must call `assertCan`/`assertPageEditable` (`editLock.ts`) after the membership check, and
  anything that creates under a parent goes through `assertPlacement` (its `userId` is required for that reason).
  Comments check the COMMENT bit (`assertPageCommentable`). Lock changes are browser-only.
- **Agent instructions** ([ADR 0975](docs/adr/0975-agent-instruction-pages.md)): designated pages must stay locked;
  `get_instructions` and the `applies:` line are the only way rules reach agents.
- **Untrusted content** ([ADR 0976](docs/adr/0976-data-instruction-boundary-in-mcp-output.md), [0977](docs/adr/0977-injection-signals-and-taint-record.md)):
  member-written text in a new MCP tool's text output goes through `wrapUntrusted`/`cleanText`
  (`mcpTools/trust.ts`); injection heuristics are computed at indexing time only (`context/injectionScan.ts`).
  These are mitigations, not permission checks.
