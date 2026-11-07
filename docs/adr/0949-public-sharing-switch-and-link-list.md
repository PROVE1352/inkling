# 0949. "No public links" switch and public link management

- Status: Accepted
- Date: 2026-11-07

## Context
Publishing pages to the web was owner-only per page, with no way to see every public page in one
place from the settings, nor to stop new publications for a workspace that must stay private.

## Decision
- `workspaces.public_sharing_disabled` (default false, owner setting). On: `POST /pages/:id/share`
  answers 403 `PUBLIC_SHARING_DISABLED` for a page that is not already public; the check reads the
  workspace row `FOR SHARE` in the same transaction that sets the token, while the settings
  update takes it `FOR UPDATE` (apps/server/src/routes/pages.ts:552).
- Turning it on can remove every existing link in the same transaction
  (`unpublishExisting: true`); otherwise existing links keep working and `/s/:token` serving is
  unchanged.
- `POST /workspaces/:id/shared/unpublish { pageIds? }` (owners, admins) removes the given links or
  all of them, one `share.unpublished` audit event per page.
- The Public links tab lists `GET /workspaces/:id/shared` (pages the viewer can see) with per-row
  and bulk removal.

## Alternatives considered
- Disable `/s/:token` serving while the switch is on: surprising for already shared links and
  irreversible-looking; explicit removal is clearer.
- Track public pages in a separate table: `pages.share_token` already is the source of truth.

## Trade-offs
- "Remove all" also removes links on pages the remover cannot see (other people's private pages
  cannot be public, so in practice these are shared pages the viewer filtered out).

## How others solve it
- Notion Enterprise: "Disable publishing sites and forms" and a workspace-wide public pages list.
  https://www.notion.com/help/sharing-and-permissions
- Google Workspace: admins restrict sharing outside the domain; existing shares need a separate
  cleanup.

## Consequences
- Publishing is a manager capability (`WorkspaceDTO.can.publish`), shown in ShareModal.

## References
- apps/server/src/routes/pages.ts:552
- apps/server/src/routes/workspaceAdmin.ts:92, :343
