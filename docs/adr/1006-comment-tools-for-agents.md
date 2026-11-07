# 1006. Comment thread tools for agents

- Status: Accepted
- Date: 2026-11-07

## Context
People review AI edits with comments, but agents could only start a thread on a page's first block
and could not read threads at all.

## Decision
- `list_comments(pageId, section?, status?)`: one line per thread (`t:<id> | §anchor | open/resolved |
  author (via client) | replies`) and the thread text as untrusted data. Threads are mapped to the same
  section anchors as `read_page`/`find_context` (block → top-level block → section).
- `add_comment(pageId, text|body, section?)`: anchors to the section's heading block; `body` stays for
  compatibility. `reply_comment(threadId, text)`, `resolve_comment(threadId, resolved?)`.
- All go through the REST routes, so visibility, membership and the edit lock's comment bit for
  agents apply unchanged.
- New rule in `PATCH /comments/:id`: an agent may resolve only threads started by the person it acts
  for (`AGENT_RESOLVE_NOT_ALLOWED`); a remark someone else made stays open until a person resolves it.
- An agent's reply in your thread notifies you normally (it answers you); an agent's @mention in a
  comment is quiet (ADR 1002).

## Alternatives considered
- Let agents resolve anything: a reviewer's objection could be closed by the agent it was aimed at.
- A per-workspace policy switch: not needed until someone asks.

## References
- apps/server/src/mcpTools/commentTools.ts, routes/comments.ts
