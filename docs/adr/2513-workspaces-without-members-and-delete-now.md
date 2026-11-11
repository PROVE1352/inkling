# 2513. Workspaces without members are deleted; "delete now" for deleted workspaces

- Status: Accepted
- Date: 2026-11-12

## Context
A sole owner could not leave a workspace (400); alone, the only way out was the 30-day soft delete.
A workspace nobody is in can never be reached again, and under LIMIT_WORKSPACES_PER_USER a deleted
workspace keeps its place until the purge.

## Decision
- Leaving as the only member (`DELETE /workspaces/:id/members/:me`) with `{ name }` equal to the
  workspace's name deletes it at once, files included (`account/workspacePurge.ts`), under the member
  lock in the same transaction as the check. Without the name the answer stays 400; with another
  member present it stays 400 too ("transfer first"). The existing tests that pin the 400 send no
  name and pass unchanged. No path of an owner or admin removing someone ends at zero members.
- `DELETE /workspaces/:id/permanent` `{ name }`: owner only, already deleted only (404 otherwise, a
  restore that won the race included), the workspace's 2FA rule as for restore, the name as
  confirmation; then the same purge.
- Both are for browser sessions only: a token or an agent never deletes a workspace this way.
- Blobs are unlinked after the commit; a failure leaves an orphan file and one log line.

## Consequences
- The web leave dialog for a lone member asks for the name and says it cannot be undone, with the
  restorable deletion one click away; the deleted-workspaces list has "Delete now".
- A workspace where only page guests remain counts as empty: guests are not members.
