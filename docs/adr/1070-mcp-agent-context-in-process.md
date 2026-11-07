# 1070. MCP agent context in process, not a second REST call

- Status: Accepted
- Date: 2026-11-07

## Context
Every page-level MCP tool (`read_page`, `update_page`, `add_comment`, `find_context`, `read_pages`,
`query_rows`, `patch_section`, …) prints per-page facts: the `can:` line, the `applies:` line,
provenance, injection flags and the large-page hint (ADRs 0975–0977, 1043). Since v0.2.0 they came
from `GET /api/pages/agent-context`, called through `call()` (`app.inject`) after the tool's main
REST call. That second inject repeated the whole request pipeline for facts the server already
had at hand: token lookup with the OAuth client join, rate-limit bookkeeping, hooks, JSON
serialization and parsing, plus five to seven statements in the handler. It doubled the internal
calls per tool call (1 → 2) and was the largest single part of the v0.2.0 MCP regression
(`read_page` p50 7.3 → 12.3 ms, `update_page` 33 → 60 ms; docs/PERFORMANCE.md).

## Decision
- The handler body of `GET /pages/agent-context` is a function, `agentContextFor(userId, ids, { read })`
  in `routes/editLock.ts`. The route calls it; `loadAgentContext` (mcpTools/agentContext.ts) calls it
  directly. One implementation, so the DTO and the tool output stay byte-identical (ADR 0937); a
  [db] test compares the in-process DTO with the injected route for the same ids.
- The function runs inside `runAsAgent(scope)` built from the tool context's user (grant id, client
  id, client name), the same scope `requireUser` enters for an injected bearer request. Agent blocks
  (`agentAllowedSql`), agent lock rules (`actorFor` → `agent: true`) and the taint record therefore
  apply exactly as before. The `/mcp` handler builds `ctx.user` with `getBearerUser`, so the ids are
  always present there; a context without them (tests) resolves them from the token once.
- The ids are validated as UUIDs before the query (the route's zod schema did that before).
- The REST route stays for API compatibility.

## Alternatives considered
- **Return the facts with each tool's main REST response** (`?agentContext=1` on export, section,
  content, …). Same saving, but every route that a tool uses would carry an MCP-only option, and
  tools that call several routes would have to pick one.
- **Wrap the whole `/mcp` handler in the agent scope.** Also correct, but changes the context of
  every direct database call the tools make today; the narrow wrap is enough for this function.
- **Keep the inject and cache its result.** The facts include the last editor and injection flags,
  which change on every edit; a cache would need the same invalidation the direct call avoids.

## Consequences
- One fewer internal request per page-level tool call; the token is not re-validated between the
  tool's main REST call and the facts (same MCP request, a few milliseconds apart).
- Rate-limit accounting no longer counts the facts call (it was never a client-visible request).

## References
- apps/server/src/routes/editLock.ts (`agentContextFor`), apps/server/src/mcpTools/agentContext.ts
- apps/server/src/aclVersion.db.test.ts (in-process vs injected DTO, agent rules, byte-stable output)
- docs/PERFORMANCE.md (MCP rows)
