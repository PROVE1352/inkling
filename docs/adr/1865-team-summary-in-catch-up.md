# 1865. Team summary through catch_up, not a new tool

- Status: Accepted
- Date: 2026-11-10

## Context
Agents should be able to see the board's summary (others' claims, what other agents did) in a few
tokens. A new tool, or a new always-on section, costs every session.

## Decision
- `catch_up(team=true)` adds one group, "Team agents (others' claims and agents)", between Comments and
  Pages changed by others: one line per live claim of another connection (section, page by 8-character
  id, person via client with `g:` short id, end time and minutes left) and one line per other agent
  that did something in the catch_up window (edits, new, suggested, open, reverted, last time, up to
  three recent pages). Hidden pages print `(hidden) <id>` without title or section. This connection's
  own claims and agent are left out. The lines go through the same importance packing and budget.
  An agent line lists every live connection with that client name (`g:…, g:…`, at most three), so an
  agent can pass one to `handoffTo`.
- Without `workspaceId` the group covers the caller's first ten workspaces (six indexed queries each),
  inside catch_up's rate limit of 30 calls a minute.
- Default `team` off: catch_up output is byte-identical to 0.14 (prompt cache, ADR 0937).
- Measured (estimateTokens): the group for one person with two claims and one busy agent is 103
  tokens; the DB test's catch_up went from 398 to 511 tokens (+113) with team=true. The schema adds
  27 tokens to catch_up in tools/list; hand-off support adds 52 (add_comment), 51 (reply_comment) and
  19 (inbox description): +149 tokens per session (0.9 % of the tool list).

## Alternatives considered
- **A `team_agents` tool**: about 150 tokens of description on every session, for a call most sessions
  never make, and one more call when an agent comes back.
- **Always in catch_up**: changes every catch_up's bytes whenever a claim's minutes change, which
  breaks the prompt-cache prefix for agents that never coordinate.

## References
- apps/server/src/catchUp.ts (teamItems), apps/server/src/mcpTools/catchUpTools.ts
