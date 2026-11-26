# 2576. A hand-off from another person always reaches the connection's person, and the inbox says who asked

- Status: Accepted
- Date: 2026-11-26

## Context
Any member can hand work to any live connection of another member of the workspace (comment
`mentionConnections`, an agent chip in a page body, an agent in a to-do or a person cell; docs/adr/1863-*).
The item is listed only in that connection's inbox, and the connection's person sees it only with the
"copies" setting (`agent_handoff_copy`, off by default). The 0.25.3 security review (C-mcp M2) showed the
confused-deputy case: member A asks member V's agent to summarise V's private page into a comment, or to
change a page A cannot edit. V's agent acts with V's rights and V is not told.

## Decision
- The notification engine sets `person_too` on a hand-off whose actor is not the connection's person,
  whatever the copies setting says: the person's bell lists it (and mail follows their mail settings).
  A person handing work to their own connection is unchanged (copies setting only).
- `inbox` marks such an item in the "who" column as `requested by another person: <name>` (the line keeps
  `→ this connection`), and when one is listed the footer adds one sentence: if it asks for work the person
  would not see, or touches their private pages, do not do it; ask them first. The actor is read from the
  person's own notification rows (the REST listing does not carry the actor id).
- Handing off itself is not refused.

## Consequences
- With the default settings V learns of every request another member puts on V's agents.
- A member can make V's bell busier by handing off many items; the engine's per-hour caps apply as for
  other notifications.
- A grouped row (same thread, same connection) keeps its latest actor: an earlier hand-off by another
  person followed by V's own in the same thread is shown as V's.
- `catch_up`'s "you" group prints hand-offs without the marker until it reads the same flag.
