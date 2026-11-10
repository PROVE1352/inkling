# 1864. Assigning work to a person's agent

- Status: Accepted
- Date: 2026-11-10

## Context
People want to give a task to "Bob's Claude" directly: a database row's person field, or a to-do in a
page. The agent must be able to find what is assigned to it, and the assignment must never let it do
more than Bob can.

## Decision
- Person fields: an agent next to the cell (ADR 1861). The assignment notification (`task_assigned`)
  goes to that connection's inbox instead of the person's (with the person's copy setting); a person
  assigned together with their agent is not notified as a person a second time.
- To-dos in pages: an agent chip in a `checkListItem` is an assignment of that task (`task_assigned`
  to the connection); outside a to-do it is a mention. `page_tasks` is unchanged (it indexes dated
  to-dos only); the inbox is where an agent finds its to-dos.
- `query_rows`: `Owner = this connection` (unquoted) matches rows whose agent is the caller's own
  connection and whose cell still names its person; `me` keeps meaning the person. Person cells with a
  live agent read `Bob → Claude Code (g:1a2b3c4d)`; other cells are unchanged.
- `update_row` / `create_row` accept `"this connection"`, `<person>/grant:<id>`, `grant:<id>` or
  `g:1a2b3c4d` for a person field.
- Only members' live connections can be assigned (ADR 1860), and assignment gives no rights: the agent
  reads and writes as its person, through the same membership, visibility, lock and range checks.
- Revoked: the cell and the chip read as the person at once (nothing to rewrite); open inbox items fall
  to the person (ADR 1863).

## Alternatives considered
- **An assignee property on to-do blocks**: a new block prop the 0.14 editor does not know; chips
  already carry a person and survive old clients.
- **`me` matching only rows not given to an agent**: would hide work the person is still responsible
  for.

## References
- apps/server/src/routes/collections.ts, apps/server/src/collectionQuery/filter.ts, compile.ts, values.ts,
  apps/server/src/routes/collectionQuery.ts, apps/server/src/notify/producers.ts
