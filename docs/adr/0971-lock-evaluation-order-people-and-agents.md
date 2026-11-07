# 0971. Lock evaluation order: deny then allow, nearer wins, people and agents apart

- Status: Accepted
- Date: 2026-11-07

## Context
A single "locked" bit cannot say "people may edit, agents may only comment", and the same member
must be treated differently when they type in the browser and when their agent writes through
MCP. Comments must survive a lock. The calculation has to be deterministic and explainable in one
paragraph.

## Decision
- Two bits: EDIT (1) and COMMENT (2). Base for a member who can see the page: both.
- A lock node (a page with `edit_locked`) carries rows in `page_access_overrides (page_id,
  subject, user_id, allow, deny)` for subjects `everyone` (people), `user:<id>` and `agents`
  (any MCP / OAuth request). The node's `owner_id` gets an implicit user-layer allow EDIT.
- Walk the lock nodes from the top level down to the page (nearer later). At each node apply:
  `everyone`, then `user:<me>` (both skipped for workspace owners/admins), then `agents` (only for
  agent requests, owners' and admins' agents included). Each layer is
  `caps = (caps & ~deny) | (allow & ~deny)`: deny first, then allow; within one layer a bit in
  both deny and allow stays denied. A node that does not mention a bit leaves it as inherited
  (field-wise inheritance).
- The API exposes presets, not raw rows: `people: editors | everyone`, `agents: same | comment |
  read`, `editorIds`. They map to rows: editors → everyone deny EDIT + user allow EDIT per editor;
  agents comment → agents deny EDIT; agents read → agents deny EDIT|COMMENT.
- Agent detection is the request, not the user: `currentAgent()` (ADR 0947) is set for bearer
  requests, so one person is a person in the browser and an agent through MCP.

## Alternatives considered
- Discord's rule that an allow from one role beats a deny from another role: makes the result
  depend on how many roles a member holds; we have three roles and want "more specific wins".
- Discord's ADMINISTRATOR bypassing every overwrite: kept for people (owners/admins skip the
  people layers) but not for agents; the agent layer is an accident guard that must also hold for
  an owner's agent.
- Discord's category sync, where editing one permission on a channel detaches it from the
  category entirely: we inherit per bit, so a nested lock that only restricts agents keeps the
  outer people rule.
- Separate role subjects (`role:admin`): not needed with three roles; can be added as a layer
  between everyone and user without changing the order.

## Trade-offs
- Owners/admins cannot lock themselves out as people (by design), but can restrict their own
  agents.
- `people: everyone` with `agents: same` is a lock that does nothing; allowed and shown as such.

## How others solve it
- Discord permission overwrites: @everyone deny→allow, role deny→allow, member deny→allow.
  https://docs.discord.com/developers/topics/permissions
- GitHub fine-grained tokens and Copilot coding agent: an agent's access is the intersection of
  the user's access and the token's grant; the agent cannot change its own permissions.
  https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations

## Consequences
- `PageLockDTO` reports `people`, `agents`, `canEdit`, `canComment` for the caller's request kind.
- MCP read tools print `can: read,comment[,edit]` so an agent knows before it writes.

## References
- apps/server/src/editLock.ts:70, :104, :342
- apps/server/src/agentAccess.ts:43
- apps/server/src/mcpTools/trust.test.ts:130
