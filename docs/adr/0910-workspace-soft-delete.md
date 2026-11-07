# 0910. Workspace deletion: owner-only soft delete, 30-day restore, purge by housekeeping

- Status: Accepted
- Date: 2026-11-07

## Context
A workspace could not be deleted. The only path that removed one was the forced account deletion
(0813), which drops the user's personal workspaces immediately. Owners need to close a workspace
themselves, and a mistyped click must not destroy a team's notes.

## Decision
- `DELETE /api/workspaces/:id` with body `{ name }`: owner only (403), the typed name must equal
  the current name (400). Inside one transaction holding `ws-members:<ws>` it sets
  `workspaces.deleted_at = now()` / `deleted_by` with `WHERE deleted_at IS NULL RETURNING`
  (0801 §1), so a second concurrent delete gets 404 and only one notification per member is
  written. Other members receive an in-app `workspace_deleted` notification (the name comes from
  the joined workspace row). No webhook is sent.
- Hidden at once from every read path. The single choke point is `requireMembership`, which now
  joins `workspaces` and answers 404 for a deleted one; every `/workspaces/:id/*`, page, comment,
  snapshot, file, template, query, sync, export and plugin route goes through it (MCP tools call
  those routes). Paths that do their own lookup use the `liveWorkspace(col)` fragment from
  `workspaceLive.ts`: `findLivePage`/`findVisiblePage`, public share tokens (`/api/public`,
  `/s` meta), collab `onAuthenticate`, notifications, reminders (both scans), webhook delivery
  (cache read and the queued-job reload; the cache is invalidated on delete and restore) and the
  sheet-sync scheduler. `GET /workspaces`, join by invite code, invite preview, member-candidate
  search and the iCal feed filter `workspaces.deleted_at IS NULL` directly. Open collaboration
  sockets of the workspace are closed after commit (`closeWorkspaceConnections`), and every member
  gets an inbox ping so the web refetches the workspace list and leaves the workspace.
- Restore: `POST /api/workspaces/:id/restore`, owner only, under the same member lock, with
  `WHERE deleted_at IS NOT NULL AND deleted_at > now() - 30 days RETURNING`. Nothing else was
  touched by the delete, so members, roles, pages, share tokens and the invite code come back as
  they were. The `workspace_deleted` notifications are removed. `GET /api/workspaces/deleted`
  lists what the caller can still restore; the web shows it in Settings and on the
  zero-workspace screen.
- Purge: housekeeping (hourly) takes up to 50 workspaces deleted more than 30 days ago. Each runs
  in its own transaction: `ws-members` lock, re-check `deleted_at < cutoff` under the lock (a
  restore that won the race leaves nothing to do), then `purgeWorkspacesTx` — tree locks in id
  order, statement timeout lifted, file ids collected, `DELETE FROM workspaces` (every
  `workspace_id` FK cascades). Blobs are unlinked after commit. The forced account deletion (0813)
  now calls the same `purgeWorkspacesTx` / `unlinkUploadBlobs`; its policy is unchanged, except
  that a soft-deleted workspace whose only owner is the deleted user is purged with the account
  (nobody else could restore it) instead of blocking with `SOLE_OWNER`.
- Migration `0027_workspace_soft_delete`: two nullable columns and a foreign key; transaction-safe.

## Consequences
- A request that passed `requireMembership` just before the delete committed may still write;
  the write lands in the hidden workspace and is restored or purged with it.
- Members who lose their last workspace land on the existing empty-state screen (create or join);
  they cannot see the `workspace_deleted` notification until they are in some workspace again.
- `/s/:token` for a deleted workspace returns the plain SPA shell (no preview meta) and the viewer
  then gets 404 from `/api/public`, same as an unknown token.
- Files of a deleted workspace pasted into other workspaces stop resolving at once and are gone
  after the purge.
- Tests: `workspaceDelete.test.ts` (403/400, hidden everywhere then restored, purge rows + blobs,
  concurrent delete/restore, restore vs purge race, forced deletion through the shared purge).
