# 2302. The list arrangement is not a permission: browser-only writes, no access version

- Status: Accepted
- Date: 2026-11-10

## Context
Archiving narrows what agents search by default, which looks like access control. It must not become
one: an archived workspace is as readable and writable as before, by its id or name.

## Decision
- Access checks are unchanged: `requireMembership`, `visibleTo`, the guest scope, ranges and agent
  blocks decide what may be read or written; the archive only narrows **default** scopes (ADR 2303).
- Nothing here calls `bumpAcl` (ADR 1071): the access version and the caches keyed on it (lock
  chains, agent blocks) do not depend on it. The find_context result cache keys on the list of
  searched workspaces, so an archive change is a different entry at once (tested).
- Routes (`routes/workspaceListing.ts`), browser sessions only (403 for tokens), like the sidebar order:
  `GET/POST /me/workspace-groups`, `PATCH/DELETE /me/workspace-groups/:id`, `PUT
  /me/workspace-groups/order`, `POST /me/workspace-groups/:id/archive`, `PATCH
  /me/workspaces/:id/listing`, `PUT /me/workspace-order`. A workspace must be one the caller can open
  (a member of a live workspace, or a guest of it), else 404; another person's group is 404.
- Agents read the effect (their default scope, `listing` on GET /workspaces, list_workspaces) and
  cannot change it: no MCP tool. A suggest-only token is refused like every token (the route sweep of
  agentTaint.db.test.ts stays green); `requireUser` is the route's preHandler so guests run inside
  their guest scope.

## Alternatives considered
- **Agents may archive** (a tool): an agent tidying its own search scope is the hidden per-connection
  state ADR 2187 rejected, now shared by every connection of the person.
- **Bump the access version on archive**: would flush the person's teams' lock caches for something
  that changes no right.

## References
- apps/server/src/routes/workspaceListing.ts, agentTaint.db.test.ts, guests.db.test.ts, workspaceListing.db.test.ts
