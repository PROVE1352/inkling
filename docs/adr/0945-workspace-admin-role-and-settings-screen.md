# 0945. Workspace admin role and one workspace settings screen

- Status: Accepted
- Date: 2026-11-07

## Context
Workspace administration was spread over the switcher menu and four modals (members, webhooks,
danger zone, delete/restore), `PATCH /workspaces/:id` (rename) had no UI, and the `icon` column
was never set. Roles were `owner | member`: every administrative task needed an owner, so a
team either had several owners (who can delete the workspace) or one bottleneck. The settings
bundle in this ADR series (audit log, agent blocks, member-add and export policies, public link
control, review) needs a place and a role between the two.

## Decision
- **Role `admin`** (`workspace_members.role`, a TypeScript-only enum, no DB constraint, so no
  data migration; apps/server/src/db/schema.ts:225). Rules live in one module,
  apps/server/src/workspaceAdmin.ts (`isManagerRole`, `roleMeets`, `capabilitiesFor`):

  | Capability | owner | admin | member |
  |---|---|---|---|
  | Name / icon, policy settings, webhooks | yes | read | read (general) |
  | Change roles, transfer, delete / restore | yes | no | no |
  | Remove people | anyone but the last owner | members only | self (leave) |
  | Add existing users | policy (0948) | policy | policy |
  | See / copy / regenerate invite link | yes | yes (if on) | no |
  | Publish / unpublish pages, public link list | yes | yes | no |
  | Connected agents, blocks | yes | yes (not owners' agents) | no |
  | Audit log | yes | yes | no |
  | Delete others' comments / templates | yes | yes | no |
  | Export zip | policy (0950) | policy | policy |
  | Owner / review of pages | any member who can see the page | | |

  Role changes stay owner-only so an admin cannot promote themselves; transfer still demotes
  the old owner to member (0911).
- **`WorkspaceDTO.can`** (additive): the server computes `manage / editSettings / addMembers /
  inviteLink / export / publish` from role + settings (workspaceAdmin.ts:60). The SPA only hides
  what `can` says; every route re-checks on the server.
- **`PATCH /workspaces/:id`** accepts `{ name?, icon? }` (icon: up to 16 characters, null clears)
  in a transaction with an audit row.
- **Screen** `/w/:wsId/workspace-settings?tab=…` (apps/web/src/pages/WorkspaceSettings.tsx): General,
  Members, Public links, Connected agents, Audit log, Review, Slack & Discord, Danger zone; tabs
  follow `can`. The members and webhooks modals became panels (MembersPanel.tsx,
  WebhooksPanel.tsx); the switcher keeps switching, create/join, import and export, and links to
  the screen. Personal settings stay at `/settings` (device and account only).
- The settings API (apps/server/src/routes/workspaceAdmin.ts) answers browser sessions only: an MCP
  token never administers a workspace.

## Alternatives considered
- Notion's full role ladder (membership admin, guest, page-level grants): rejected in the gap
  survey; the shared/private model stays.
- Policy settings editable by admins: an admin could then widen "who can add members" past what
  the owner chose. Owners set policy, admins operate within it.
- Keep the modals and only add tabs for new features: two places to find members and webhooks.

## Trade-offs
- `admin` is invisible to clients older than this change (they render it like a member).
- Moderation (deleting others' comments/templates) moved from owner to owner+admin.

## How others solve it
- Notion: workspace owners, membership admins (members and groups only), members; settings on one
  screen. https://www.notion.com/help/add-members-admins-guests-and-groups
- GitHub organizations: owners vs. members, with per-feature "who can" settings.
- Slack: owners and admins; admins manage members, owners own policy.

## Consequences
- Every former `role !== 'owner'` site was decided explicitly: managers in pages.ts share routes,
  pageTree.ts publish rule, comments.ts, templates.ts; still owner-only in notion.ts upload,
  webhooks, workspaceDeletion.ts.
- Error messages that named "owner" changed; Korean translations follow
  (apps/web/src/i18n/ko/server-messages-a.ts).

## References
- apps/server/src/workspaceAdmin.ts:29, :34, :60, :76
- apps/server/src/routes/workspaces.ts:919 (removal rules), :163 (list with `can`)
- apps/server/src/routes/workspaceAdmin.ts:84 (settings)
- apps/web/src/pages/WorkspaceSettings.tsx, apps/web/src/components/MembersPanel.tsx
- docs/adr/0911-* (transfer), 0804-* (member lock)
