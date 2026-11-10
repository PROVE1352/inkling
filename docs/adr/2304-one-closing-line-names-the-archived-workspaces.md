# 2304. One closing line names the archived workspaces a default answer left out

- Status: Accepted
- Date: 2026-11-10

## Context
An agent that cannot see why a known contest is missing from an answer cannot fix it. ADR 2187's
objection to hidden per-connection state was exactly that. The line must not cost tool-list tokens
or make answers differ between identical calls (ADR 0937).

## Decision
- When a default answer left archived workspaces out, it ends with one line of our own text:
  `Not searched: 2 archived workspaces (1a2b3c4d "Alpha Cup", 5e6f7a8b "Old Contest"); pass
  workspaceId=<id or name> to include one.` (find_context, search). catch_up: `Not included: changes,
  comments and due tasks of 1 archived workspace (…); items for you from them are. Pass
  workspaceId=<id or name> for one.`
- Names sorted by name then id, at most five, the rest counted (`, 3 more`); names through
  `cleanText`, one line, quotes replaced, 40 characters (the format of ADR 2186's errors).
- Placement: find_context after the "Results come from" line and before the dated Verification line;
  search after the "more" line and legend, also after "No pages match"; catch_up before the two
  moving lines (`due window`, `next since`), which stay last. JSON search output adds
  `archivedNotSearched: [{ workspaceId, workspace }]`. REST answers carry `archived: [{ id, name }]`.
- No archived workspace: no line and no field; output bytes are unchanged for everyone else.
- Tool descriptions and SERVER_INSTRUCTIONS are not changed: tools/list stays ~12,777 tokens, the
  instructions ~492 (scripts/mcp-tools-list-cost.ts, before and after).

## Alternatives considered
- **A sentence in SERVER_INSTRUCTIONS** ("archived workspaces are left out"): pays on every session for
  people who archive nothing; the line appears only where it applies.
- **A header line** ("searching 12 of 40 workspaces"): moves the fragments down and changes the
  first line of every answer when the archive changes.
- **Ids only**: agents and people know contests by name; names are already printed in ADR 2186 errors.

## References
- apps/server/src/workspaceArchivedNote.ts (+ .test.ts), mcpTools/contextTools.ts, mcpTools/compactList.ts, mcp.ts, catchUp.ts
