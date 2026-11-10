# 1863. Hand-offs go to one connection's inbox

- Status: Accepted
- Date: 2026-11-10

## Context
`notifications` is per person: every connection of a person lists the same inbox. "@Bob's Claude,
take this" must reach that agent only, optionally show the person, and fall to the person when the
agent is gone.

## Decision
- `notifications.connection` (nullable) and `notifications.person_too` (migration 0046). A row with a
  connection lists only in that connection's MCP inbox (and its catch_up "For you"); `inbox`/`ack` of
  other connections never see or acknowledge it. NULL keeps today's meaning.
- Producers: a comment's `mentionConnections` (REST; MCP `add_comment`/`reply_comment` `handoffTo`),
  an agent chip in a page (ADR 1861; in a to-do it is `task_assigned`), an agent next to a person cell
  (ADR 1864). Each target is checked live (ADR 1860); a refused one writes nothing (400). A chip whose
  connection is not live is notified to the person instead.
- Engine: one event per target connection. The person's subscription level does not drop it, the actor
  is not excluded (people hand work to their own agents), the group key is prefixed with the
  connection so it never collapses into the person's own row, and it is never mailed unless copied.
- Copies: the person's setting `agent_handoff_copy` (default off) sets `person_too`; the bell lists
  those rows with "For your <client>" and mails them like any direct item.
- Hand back: when the connection goes away its unacknowledged rows get `connection = NULL` — at once in
  the revoke routes (grant disconnect, token delete, admin token delete), and in the hourly
  housekeeping for everything else (expiry, refresh-token reuse, blocks, a person who left, a range
  change). The person then sees them in the bell and every connection's inbox. Acknowledged rows stay.
- MCP output: an item for this connection reads `… | mention (comment) → this connection | …`; the
  header adds `(N handed to this connection)` only when N > 0. Other lines are byte-identical to 0.14.

## Alternatives considered
- **Two rows (connection row + person row)**: the person row would also appear in every other
  connection's inbox, so the hand-off would not go to one agent only.
- **Resolving liveness on every read**: correct without housekeeping, but adds a grant/token lookup to
  the bell's unread count, which runs on every page load.

## References
- apps/server/src/notify/engine.ts, apps/server/src/routes/inbox.ts, apps/server/src/routes/notifications.ts,
  apps/server/src/teamAgents.ts (handBackConnections), apps/server/drizzle/0046_wave13_team_agents.sql
