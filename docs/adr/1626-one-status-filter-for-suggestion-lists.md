# 1626. One status filter for both suggestion lists; withdraw says why

- Status: Accepted
- Date: 2026-11-10

## Context
Found on 0.12 in use: `list_suggestions(pageId)` used the web history view (everything but
superseded, so withdrawn rows showed), `list_suggestions()` showed open plus decided in 7 days (no
withdrawn), and superseded rows showed nowhere. `withdraw_suggestion` on a superseded suggestion
answered 409 with the generic "content changed; re-read and retry" hint.

## Decision
- `status` on `GET /pages/:id/suggestions`, `GET /suggestions` and `list_suggestions`: `open`
  (default), `decided` (accepted, accepted_partial, rejected), `all`, or one status. Both lists use
  the same SQL condition. `all=1` stays for the web history (everything but superseded).
- Superseded rows name their successor (`supersededBy`, the next suggestion of the same connection
  for the same section); list lines read `replaced by <id>`.
- A suggestion that is no longer open is refused per state: `SUGGESTION_SUPERSEDED` ("replaced by
  your newer suggestion <id>"), `SUGGESTION_WITHDRAWN`, `SUGGESTION_DECIDED` ("already rejected by
  Alice"); the MCP hint for these codes says there is nothing to retry.

## Consequences
- `list_suggestions()` no longer shows decided suggestions by default; agents pass `status`.

## References
- apps/server/src/suggestions.ts, apps/server/src/routes/suggestions.ts, apps/server/src/mcpTools/collabTools.ts, core.ts
