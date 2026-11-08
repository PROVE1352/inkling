# 1250. Guests are people with page rows, not workspace members

- Status: Accepted
- Date: 2026-11-08

## Context
Access was workspace membership plus `scope` (shared, or private to the author). A team moving from
Notion needs "this outside designer may edit this page and nothing else". Every check in the server
(about 250 routes, the collaboration socket, notifications, feeds) answers "is this person a member
of the workspace?" and then "can they see this page?". The guest audit (inventory of every route,
docs/adr/1252-*) found that membership is the only thing standing between a signed-in account and
another workspace's content on all but one path.

## Decision
- **Table** `page_grants(page_id, user_id, level, created_by, created_at, updated_at)`, primary key
  (page, user), index on user. `level`: `view | comment | edit | full`. The nearest row on a page's
  ancestor-or-self path is the person's level there (docs/adr/1251-*). No workspace column: the
  workspace is the page's (a root that moves follows; pages never change workspace), a purged root
  takes its rows along (cascade), a trashed root is ignored until restored.
- **A guest is an account that has rows in a workspace it is not a member of.** Guests are never rows
  in `workspace_members`. Every existing membership check therefore still refuses them, and only
  routes that opt in (`requireMembership(ws, user, { guests: true })`) let them through, narrowed to
  their pages (docs/adr/1252-*). Guests get `view`, `comment` or `edit`; never `full`.
- **Adding people** (share dialog, `PUT /pages/:id/access { userId | email, level }`, browser sessions
  only): members by name or email; someone outside the workspace by an exact email address only (the
  dialog never prefix-searches the instance's accounts). An address without an account gets an
  invitation: `page_invites` (SHA-256 of a random token, docs/adr/1110-*; 14 days; one live invitation
  per address and page), mailed when SMTP is configured, otherwise the link is shown once to copy.
  Accepting needs a signed-in account with that address (verified where the server verifies
  addresses); a forwarded link is refused (`INVITE_EMAIL_MISMATCH`). An invitation never creates an
  account and never bypasses sign-up keys.
- **Who may add a guest**: workspace setting `guest_invite_policy` (`off | owners | admins | members`,
  default `admins` = owners and admins; `members` = any member who can edit the page). `off` means
  nobody, owners included. Members never hand out more than their own level. Changing or removing an
  existing guest's row is allowed to whoever manages the page (docs/adr/1251-*) or may invite.
  Tightening the policy keeps existing guests.
- **Membership changes**: joining (invite code) or being added as a member deletes the person's rows
  in that workspace (they become a plain member); leaving or being removed deletes them too, so a
  removal never leaves the person behind as a guest of some page. Both bump the access version.
- **Workspace screen**: owners and admins list guests with their pages and levels
  (`GET /workspaces/:id/guests`) and remove several at once (`POST /workspaces/:id/guests/remove`),
  which closes their live sockets. Audit actions: `page.access_granted`, `page.access_changed`,
  `page.access_removed`, `page.guest_invited`, `guests.removed`.
- **What a guest's workspace looks like**: `GET /workspaces` lists it with `role: 'guest'`, no rights
  (`can` all false) and no invite code; the page tree is their shared subtrees, each top shown without
  its (invisible) parent.

## Alternatives considered
- **`guest` as a fourth `workspace_members.role`.** One row, one join, and every route would "just
  work" — which is the problem: every route that checks membership and then reads workspace-wide data
  (member list with emails, search, graph, tags, settings, member candidates, exports, feeds) would
  open to guests, and `roleMeets(role, 'members')` treats any role as a member. Fail-open across 250
  routes; rejected.
- **Invitation links that create accounts.** Convenient, but any member allowed to invite could then
  create accounts on an instance whose operator closed sign-up. The invitation waits for an account.
- **Prefix search over all accounts in the dialog.** Lets anyone who may invite enumerate the
  instance's users and emails; exact address only.

## Consequences
- Additive schema (two tables, one column with a default); existing members and pages behave exactly
  as before. `WorkspaceDTO.role` widens to `WorkspaceAccessRole` (`… | 'guest'`).
- Guests do not receive notifications or mentions (recipients must be members; fail-closed), and
  cannot be mentioned or assigned.
- Tests: `apps/server/src/guests.db.test.ts`.

## How others solve it
- Notion: guests per page with view/comment/edit/full, a workspace setting for who may invite guests,
  and a guest list in Settings. https://www.notion.com/help/add-members-admins-guests-and-groups
- Confluence: guests limited to one space; Outline: guests on the paid plan (competitor survey).
