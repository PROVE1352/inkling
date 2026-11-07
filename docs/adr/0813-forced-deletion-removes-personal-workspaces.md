# 0813. Forced deletion removes the user's personal workspaces

- Status: Accepted
- Date: 2026-11-07
- Audit: C-H1 follow-up (TODO #2)

## Context
Since 0803 a forced deletion (`DELETE /api/admin/users/:id`) is refused with 409 `SOLE_OWNER`
while the user is the only owner of a workspace. Every account owns its auto-created personal
workspace alone, so in practice the deletion was always refused.

## Decision
Inside the existing transaction (admin lock, then `ws-members` locks of all memberships):
- Workspaces where the user is the **only member** are deleted together with the account. Their
  tree locks are taken in id order and the statement timeout is lifted for the cascade. Every
  `workspace_id` foreign key is `ON DELETE CASCADE` (pages, files, members, templates, tasks,
  notifications, webhooks, sheet syncs, collections), and pages cascade further (docs, ink,
  snapshots, links, comments, bookmarks). File ids are collected first, and their upload blobs are
  unlinked best-effort **after** commit, as the trash purge does. A refused or rolled-back deletion
  keeps everything.
- Workspaces with other members where the user is the only owner still answer 409 `SOLE_OWNER`
  with the list.
- `GET /api/admin/users/:id/delete-preview` returns `{ personalWorkspaces, personal, soleOwnedShared }`
  so the confirm dialog can say what will be deleted. It is a separate endpoint so that
  `AdminUserDTO` (packages/shared) stays unchanged. The DELETE response adds `deletedWorkspaces`.

## Consequences
- Attachment URLs from a deleted personal workspace that were pasted into other workspaces stop
  working.
- The admin web dialog still has to call the preview endpoint (web follow-up).
- Tests: `fixphase.test.ts`, "forced deletion: personal-only user → 200 …" and the extended
  "forced deletion: sole owner → 409 …".
