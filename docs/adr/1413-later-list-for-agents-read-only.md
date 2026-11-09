# 1413. Agents read the Later list; they do not write it, and threads get no tool

- Status: Accepted
- Date: 2026-11-09

## Context
Agents act for a person through OAuth connections and API tokens (0935, 1200). The person's Later
list says what they meant to come back to and when; an agent planning their day or answering "what
did I leave for later?" needs it. Saving, completing and reminders change what the person is
reminded of and mailed.

## Decision
- Read-only MCP tool `later(workspaceId?, state?, budget?)` over `GET /api/later` (read-only tokens
  may call it), in the inbox tool's format (1003, 0937): one fixed line per item
  (`id | kind | page/thread "title" §anchor | by | remind … (due) | saved …`), the preview wrapped as
  untrusted data (0976), a header with open and due counts, byte-identical for the same state.
- Items the person cannot open now are listed as `not accessible to the person now`, without title
  or preview; items outside the token's range or in a workspace that blocks the agent are not
  listed (`agentAllowedSql`).
- No write tool: an agent should not decide what the person is reminded of, and a reminder mails
  the person. The REST write routes stay open to personal API tokens (scripts the person writes).
- No threads tool: the inbox already lists replies in followed threads (`reply`); the Threads view
  is a reading aid for people.

## Alternatives considered
- **Expose save/done:** useful for "remind me tomorrow" through a chat, but it lets any connected
  client set reminders that mail the person; revisit with per-tool consent.
- **No tool at all:** the list would be invisible to agents acting for the person, unlike the inbox.

## Consequences
- docs/MCP.md lists `later` with the read tools.
- Tests: `apps/server/src/later.db.test.ts` (format, determinism, untrusted wrapper, redaction).

## References
- apps/server/src/mcpTools/laterTools.ts
