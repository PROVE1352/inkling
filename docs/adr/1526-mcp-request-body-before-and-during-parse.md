# 1526. POST /mcp: token before body, a value cap before JSON.parse

- Status: Accepted
- Date: 2026-11-09

## Context
B-L10: `/mcp` accepts bodies up to 12 MB (import_folder) and Fastify parses them with a synchronous
`JSON.parse` before the handler runs, so before the bearer token was even looked up. Measured on a
laptop (Node 22, `scripts/mcp-body-bench.ts`, longest event-loop delay per request): string-heavy
bodies (Markdown files) stall 3 ms per MB (30 ms at 11.4 MB), value-heavy bodies (many small
objects) 5–6 ms per MB (70 ms at 12.4 MB). Anyone could send the latter without a token.

## Decision
- The token is looked up in an `onRequest` hook of `POST /mcp`; without a valid one the 401 goes out
  before the body is read or parsed. The handler reuses the looked-up user.
- A content-type parser scoped to `/mcp` counts JSON values (commas and opening brackets outside
  strings; strings skipped with `Buffer.indexOf`, stopping at the cap) and answers 413
  `TOO_MANY_VALUES` above 20,000, then hands the text to Fastify's own JSON parser (same
  prototype-poisoning rules). Real tool calls carry at most a few thousand values (import_folder:
  300 files × 2). The count costs ≤ 2.3 ms for any 12 MB body.
- The 12 MB limit stays (import_folder); its description now says "about 12 MB per call", not the
  50 MB of the multipart route.

## Alternatives considered (measured)
- **Parse in a worker thread**: for value-heavy bodies the structured clone back to the main thread
  blocks longer than parsing there (82 ms vs 59 ms at 12 MB); for string-heavy bodies it cuts the
  stall to ~3 ms but adds a thread, an eval'd parser without Fastify's prototype checks and a second
  error path. Rejected for now; it is the next step if import_folder sizes grow.
- **Lower the limit to 4 MB**: caps the string case at ~10 ms but breaks folder imports that work
  today; the value cap removes the expensive case without that cost.
- **Streaming JSON parser**: not available without a dependency (0882).

## Consequences
- Value-heavy 12 MB body: 70 ms stall → 2.3 ms (413); anonymous bodies are never parsed.
- String-heavy bodies are unchanged (~30 ms at 11.4 MB) and need a valid token.
- Tests: `apps/server/src/mcpBody.test.ts`. Numbers: docs/PERFORMANCE.md.

## References
- apps/server/src/mcpBody.ts, apps/server/src/mcp.ts (`registerMcpRoutes`)
