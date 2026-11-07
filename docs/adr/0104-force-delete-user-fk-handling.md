# 0104. Force-deleting a user: rely on FK SET NULL, guard the last admin

- Status: Accepted
- Date: 2026-11-07

## Context
Admins need to remove an account while keeping workspace content. Every FK to `users.id` was audited.

## Decision
- `DELETE /admin/users/:id` deletes the `users` row. Content FKs are already `ON DELETE SET NULL` (pages, files, comments.author, page_snapshots, templates, workspaces.created_by, page_ink.updated_by, notifications.actor, signup_keys.created_by). Personal rows cascade (sessions, workspace_members, bookmarks, notifications.user, oauth_codes, oauth_grants, and the new reset/verification tables). No content cascades, so the route does no extra copying.
- The user's signup key gets `used_count = greatest(used_count - 1, 0)`.
- Self-delete and deleting/demoting the last admin are refused. Admin-set changes (delete, demote, bootstrap promote) run inside a transaction holding a `pg_advisory_xact_lock`, re-check that the caller is still admin, and count remaining admins — two admins deleting each other concurrently cannot both succeed (verified in smoke).

## Alternatives considered
- Soft delete (`deleted_at`): reversible, but every auth/query path would need filtering.
- Reassign content to the deleting admin: changes authorship and private-page ownership silently.

## Consequences
- Orphaned private pages (`created_by IS NULL`) are visible to the workspace's members by the pre-existing rule in `pageDto.ts`, and workspaces where the user was the only member become unreachable. Both are stated in the confirmation dialog.

## References
- apps/server/src/routes/admin.ts:262 (delete), :287 (`used_count` refund), :226 (demote guard)
- apps/server/src/accounts.ts:41 (`withAdminLock`)
- apps/server/src/pageDto.ts:92 (orphan private rule)
- apps/server/src/db/schema.ts (all `references(() => users.id …)`)
