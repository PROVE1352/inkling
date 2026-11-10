# 1861. Agent refs sit next to person values

- Status: Accepted
- Date: 2026-11-10

## Context
A person cell holds a member's uuid (or, from imports, an array of them). A to-do or a mention in a
page is a mention chip `{kind, id, label}` in the Yjs document. Both must be able to name a person's
connection (ADR 1860) without breaking 0.14 clients, which keep reading and writing the same rows and
documents during an upgrade, nor the twenty-odd server paths that read person values (filters,
charts, CSV, reminders, row templates, relation checks).

## Decision
- **Person cells**: the cell keeps the person's uuid where it always was. The connection is stored
  under a sibling key `agent:<fieldId>` as the full ref `<person>/<connection>`. It counts only while
  its person is in the cell (`agentRefOfCell`) and its connection is live. Every existing reader keeps
  reading a person; `Owner = me` still finds rows assigned to my agents (they are mine).
- The props route (`PATCH /pages/:id/props`, also MCP `update_row`) checks the key: a person field, a
  live member connection, the cell's person = the connection's person. Assigning an agent sets the cell
  to its person. A write that moves the cell to another person and does not name the key drops it; a
  0.14 client that bypasses this (bulk edit, which drops unknown keys) leaves a stale key that never
  counts. Bulk and create routes ignore agent keys; MCP `create_row` writes them with a follow-up props
  write.
- **Mention chips**: same node, `kind: 'agent'`, `id: <person>/<connection>`, `label: "Bob · Claude
  Code"`. No new attribute, so the 0.14 editor's schema keeps the node intact; the 0.14 chip renderer
  shows every non-page kind as a person chip, so it reads `@Bob · Claude Code`.
- **Agent notation**: `@[Bob · Claude Code](agent:<person>/grant:<id>)`. Like person chips, agents
  keep, move or delete existing ones and cannot create new ones (ADR 1002).

## What a 0.14 client shows (checked against the 0.14 web code in this tree)
- Table, board, gallery, right panel: the person (FieldValue reads `props[fieldId]`); no agent.
- Editing the cell: writes `{fieldId: id}` only; the server drops the agent when the person changes.
- Agent chip in a page: `@Bob · Claude Code` in the person-chip style; copying or exporting gives
  `@Bob · Claude Code`.
- Bell and settings: the additive `forAgent` / `agentHandoffCopy` fields are ignored.
- MCP agents: inbox lines of items for the person are byte-identical; only hand-offs carry a marker.

## Alternatives considered
- **Value becomes an object `{user, agent}` or a string `<uuid>/grant:<id>` in the cell**: 0.14 shows
  "Unknown person", and every person reader on the server (reminders' `uuid[]` casts among them) would
  have to learn the new shape at once.
- **A new attribute on the mention node**: y-prosemirror rewrites attributes the 0.14 schema does not
  know when that client edits the line, so the connection would vanish silently.

## References
- packages/shared/src/teamAgents.ts (agentRefOfCell), apps/server/src/teamAgents.ts (normalizeAgentProps),
  apps/server/src/notify/mentionScan.ts, apps/server/src/md/notation.ts
