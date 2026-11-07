# 1003. Agent inbox: the person's direct items, a cursor and an explicit ack

- Status: Accepted
- Date: 2026-11-07

## Context
MCP cannot push into an agent's turn. Agents learn about edits through `changes_since`, but not about
"someone asked you something": mentions, replies, assignments. Inkling has no agent identities: an
OAuth connection acts as its person.

## Decision
- "A mention for the agent" = a direct item addressed to the person the connection acts for. The
  inbox lists the person's notifications of inbox kinds (`mention`, `reply`, `comment`, `assigned`;
  reserved `source_changed`, `approval_result`), not yet acknowledged, in `seq` order, only for pages
  the person can still see and workspaces where this connection is not blocked. The agent decides
  what to act on; nothing is routed to a specific connection.
- `notifications.seq` (bigserial) is the cursor; a collapsed row gets a new `seq`, so new activity on
  an old item reappears after the cursor.
- `ack(ids | cursor)` sets `acked_at`, separate from the person's `read`: an agent working through its
  queue does not clear the bell, and reading the bell does not hide work from the agent. Ack is per
  person (any of the person's agents consuming an item consumes it for all) to avoid two agents
  doing the same work.
- Output: one fixed-format line per item (`seq | kind | page §anchor | who (via client) | ×count |
  can: edit/comment/read | seen | time`), member text in `<untrusted_content source="inbox">`, budget
  in tokens, cursor on the last line; byte-identical for the same state (ADR 0937). `can:` comes from
  the edit lock evaluated for agents (ADR 0970), so locked pages say so before the agent tries.
- `inbox` is a GET (read-only tokens can list); `ack` is a write tool.

## Alternatives considered
- Per-connection ack state: allows several agents to each see everything, at the cost of duplicated
  work and a table keyed by grant; revisit with agent identities.
- Reusing `read`: would silently clear the person's notifications.

## Trade-offs
- Followed-page edits (`page_update`) are not inbox items; agents use `changes_since` for those.

## How others solve it
- Kiro steering "consumed ids", Aside system messages for routine triggers; GitHub notifications'
  separate "done" from "read".

## References
- apps/server/src/routes/inbox.ts, mcpTools/inboxTools.ts
