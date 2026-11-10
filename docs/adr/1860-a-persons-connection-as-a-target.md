# 1860. A person's connection as a target

- Status: Accepted
- Date: 2026-11-10

## Context
In a team of three to five, each person connects their own agent (an OAuth/MCP grant or a personal
API token). Since 0.12 a connection has a key, `grant:<id>` / `token:<id>`, used by claims,
suggestions, catch_up markers and auto-accept rules. Hand-offs (ADR 1863) and agent assignments
(ADR 1864) need to name "Bob's Claude Code" as a target, and say what happens when that connection is
gone.

## Decision
- The value is `<person uuid>/<connection key>`, e.g. `0b9d…/grant:7a6b…`. The person comes first and
  is always recoverable from the value itself, so a gone connection means the person without a scan
  or a rewrite.
- A connection is a target in workspace W while it is **live there**: the grant's refresh token has
  not expired (revoking deletes the grant) or the token exists and has not expired; its person is a
  member of W (guests' connections never are); its range includes W (ADR 1200: all, W in a
  `workspaces` range, or a `subtree` range rooted in W); and an owner/admin has not blocked that
  client of that person in W (ADR 0947). One SQL predicate (`connectionLiveSql`) and one list
  (`workspaceConnections`) implement it; writers refuse anything else with 400 `AGENT_NOT_AVAILABLE`.
- A connection whose range is a subtree is a target only for pages inside that subtree: a hand-off or
  assignment about a page outside it is refused (a chip there goes to the person), because that
  connection would never see the item.
- The person in front must be the connection's owner. `<Bob>/grant:<Alice's grant>` is refused on
  write and read as Bob (the person) everywhere else.
- Agents and REST clients may also write `grant:<id>`, `token:<id>` or the short `g:1a2b3c4d` that MCP
  output prints (unique prefix within the workspace's live connections).
- A connection target grants nothing. The agent acts with its person's token, so everything it can do
  is still bounded by that person's membership, visibility, locks and range.

## Alternatives considered
- **A new `agents` table with stable ids**: one more thing to create, keep in sync with grants and
  tokens, and clean up; the existing connection key already identifies the connection everywhere.
- **The connection key alone (`grant:<id>`)**: after a revoke the grant row is deleted and the person
  can no longer be found, so "falls to the person" would need eager rewrites of every value.

## References
- packages/shared/src/teamAgents.ts, apps/server/src/teamAgents.ts
