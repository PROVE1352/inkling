# 1552. Usage per connection: counted in memory since start, numbers only

- Status: Accepted
- Date: 2026-11-09

## Context
With several agents per person, admins and workspace managers ask which connection does how much:
how many calls, how much text it pulls, whether it fails, whether the find_context cache (ADR 1550)
and the changes_since wait (ADR 1551) help. The only stored facts were `last_used_at` on
`oauth_grants`, `api_tokens` and `workspace_agent_access` (written at most once a minute). This step
allows no schema change.

## Decision
**Counted per connection** (`connectionUsage.ts`): agent connections by OAuth grant id, personal API
tokens by token id. Per connection: calls, errors, estimated tokens returned, find_context cache hits,
time spent waiting in changes_since, latency (average, p95 from a 13-bucket histogram, maximum) without
that wait, first and last use. For agent connections also per (workspace, connection), for the calls
that reached the workspace.

**Where it is counted:**
- MCP tools: `meterTools` (`mcpTools/meter.ts`) wraps every tool registered in `buildMcpServer`; the call
  runs in an AsyncLocalStorage frame. Tokens: `estimateTokens` of the result's text blocks (the same
  estimate as the budgets, ADR 0926); errors: `isError` results and throws. Below the tool, without new
  parameters, the frame collects: a cache hit (`noteCacheHit`, contextCache.ts), wait time (`noteWait`,
  changeTools.ts), and the workspaces reached (`noteWorkspaces`: every `assertAgentAllowed`, i.e. every
  membership or page check of an agent request, and find_context's searched workspaces).
- API tokens (REST only, they never reach `/mcp`): an `onResponse` hook; status ≥ 400 is an error,
  `content-length / 4` the token estimate, Fastify's elapsed time the latency. The MCP server's own
  internal requests carry the internal header and are skipped (they are counted as the tool call).

**Kept in memory, since this process started.** Two `BoundedLru` maps (5,000 connections, 20,000
workspace rows). Numbers only: no arguments, queries, page ids, titles or text. The durable "last used"
stays in the existing columns; nothing new is written to the database.

**Shown:**
- Admin page › Server status: a section under the cards (`agents` in `GET /api/admin/status`, live, not
  part of the 5-minute probe cache): totals, find_context cache hits/misses and size, waiting
  changes_since calls, and the 50 most recently used connections with name, person, calls, tokens,
  errors, cache hits, average/p95 latency, last use.
- Workspace settings › Connected agents: per connection, the numbers of the calls that reached this
  workspace (`usage` on `AgentConnectionDTO`, `usageSince` on the response). A manager sees nothing of
  what the member's agent did in other workspaces, only counts here.

## Alternatives considered
- **New table or columns** (persistent counters): not allowed in this step; would also add a write per
  call or a flusher with its own crash window.
- **`plugin_storage` as a generic store:** it belongs to plugins (per install, per plugin id); counters of
  the core in it would be invisible to its owners and break its quota logic.
- **A file under DATA_DIR** (like the boot log, ADR 1231): survives restarts but needs a flush schedule
  and a merge rule; a restart reset is easy to read ("since <time>"), so not now.
- **Global numbers in the workspace list:** simpler, but would tell a workspace manager how much a
  member's agent works elsewhere.

## Consequences
- Numbers reset on restart and are per process (one process is the supported deployment, ADR 1240).
  The screens say "since the server started".
- A call that spans several workspaces (find_context without `workspaceId`) counts in each workspace it
  searched, with its whole token count; cross-workspace lists that do no per-workspace check
  (list_workspaces, changes_since and catch_up without a workspace, inbox) count on the connection only.
- Errors raised by the MCP SDK before the tool runs (invalid arguments) are not counted.
- Tests: `apps/server/src/mcpTools/agentEfficiency.db.test.ts` (calls, tokens, errors, cache hits, wait
  not in latency, per-workspace list, admin summary, API tokens), `apps/server/src/connectionUsage.test.ts`.

## References
- apps/server/src/connectionUsage.ts, apps/server/src/mcpTools/meter.ts, apps/server/src/mcp.ts
  (`buildMcpServer`: `meterTools(server, ctx)`), apps/server/src/agentAccess.ts (`assertAgentAllowed`),
  apps/server/src/status/agentUsage.ts, apps/server/src/status/routes.ts,
  apps/server/src/routes/workspaceAdmin.ts (`GET /workspaces/:id/agents`), packages/shared/src/workspaceAdmin.ts,
  apps/web/src/status/AdminStatusCards.tsx, apps/web/src/pages/WorkspaceSettings.tsx
- ADR 0947, 1230, 1231, 1550, 1551
