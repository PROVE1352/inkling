# 0803. Forced account deletion: private pages visible to nobody, sole owner blocks

- Status: Accepted (supersedes the P-server "transfer to acting admin" variant)
- Date: 2026-11-07
- Audit: C-H1, TODO #1/#2

## Context
`pages.created_by` is ON DELETE SET NULL and `visibleTo` treated "private AND created_by IS NULL" as shared, so a deleted user's private notes (trash included) became readable by every member, shareable and publishable. The interim fix handed them to the acting admin — an admin reading someone else's private notes.

## Decision
- `visibleTo` = `scope = 'shared' OR (scope = 'private' AND created_by = me)`. An ownerless private page is visible to nobody, admins included. Live collab connections to such pages are closed.
- The deletion transaction (admin lock + `ws-members` locks of the user's workspaces) refuses with 409 `SOLE_OWNER` and the list of workspaces where the user is the only owner. Otherwise it moves the user's private pages to the trash (`deleted_at = coalesce(deleted_at, now())`) and deletes the user; the 30-day trash purge (which does not look at the author) removes them.
- Existing ownerless private rows (two in production) are not migrated or deleted; they are simply hidden.
- Making a shared subtree private assigns ownerless pages in it to the mover (otherwise they would vanish).

## Consequences
Data of a deleted user's private pages is unrecoverable through the app after deletion; admins should offer an export first. UI copy for the 409 belongs to the web.
