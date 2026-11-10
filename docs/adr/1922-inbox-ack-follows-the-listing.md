# 1922. Inbox acknowledgement follows the listing

- Status: Accepted
- Date: 2026-11-10

## Context
`inbox` filters by workspace and kinds and hides items the agent cannot see (private pages, trashed
pages, other ranges, blocked agents, the two-step rule). `ack(cursor)` acknowledged every inbox item
with `seq <= cursor`. An agent that listed workspace A and did what the footer says, `ack(cursor)`,
acknowledged older mentions in workspace B it had never seen.

## Decision
- One SQL predicate (`inboxWhereSql`) describes what a listing with given filters shows, including
  the hand-off rule of ADR 1863 (items for the person and for this connection, never another
  connection's). The listing and the cursor ack both use it.
- `POST /api/inbox/ack` takes the listing's `workspaceId` and `kinds` with `cursor`. Without them it
  acknowledges what the unfiltered inbox shows, which no longer includes hidden items. `ids` still
  acknowledge exactly those items.
- The MCP cursor carries the filters: unfiltered it stays the plain seq (output byte-identical to
  0.15.0); after a filtered listing it is `<seq>;ws=<id>;kinds=a,b`. `ack(cursor)` passes them on, and
  `inbox(cursor)` keeps paging with them unless the call names its own filters.

## Alternatives considered
- **Only new `workspaceId`/`kinds` arguments on `ack`**: correct only when the agent repeats the
  filters, which the footer never told it to do.
- **Remembering each connection's last filter on the server**: state that a second concurrent
  listing silently changes.

## References
- apps/server/src/routes/inbox.ts, apps/server/src/mcpTools/inboxTools.ts, packages/shared/src/notifications.ts
- apps/server/src/mcpTools/inboxAck.db.test.ts
