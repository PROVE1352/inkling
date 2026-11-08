# 1252. Guest visibility at the permission boundary, opt-in routes, leak checklist

- Status: Accepted
- Date: 2026-11-08

## Context
A guest must not learn anything about the workspace outside the pages shared with them: other pages
in the sidebar, search, graph, backlink titles, members, comments elsewhere, files, feeds, exports.
The connection range (docs/adr/1200-*, 1202-*) already narrows every visibility check to a subtree
for tokens, through `visibleTo`, `pageInRangeSql` and placement checks. An audit of every route
before this change (≈250 routes) showed that membership (`requireMembership`, membership joins)
gates every path except one (a canvas export named another workspace's page titles by id).

## Decision
- **Two locks, both fail-closed.**
  1. *Membership*: guests are not members, so every existing route refuses them. A route opens to
     guests only with `requireMembership(ws, user, { guests: true })` (or `requireMembershipAcl`,
     `gateWrite(…, { guests: true })`), which answers role `'guest'` only inside the request's guest
     scope for that workspace, with the workspace's live and 2FA checks.
  2. *Visibility*: `requireUser` enters a guest scope (AsyncLocalStorage, like the range) for an
     account with rows. `visibleTo` and `pageInRangeSql` add, for the guest's workspaces only,
     `scope = 'shared' AND id IN (recursive walk from their rows, not through private pages)`. The
     same `findVisiblePage` that every page route starts with therefore answers 404 for a page
     outside their trees, before any membership check. Placement refuses the top level and parents
     outside their trees (`GUEST_OUTSIDE`).
- **No SQL for anyone else.** Whether an account has rows is one `EXISTS` folded into the user
  lookup statement that every request already runs (session, API token, OAuth). Without rows the
  scope only records that fact: no statement, and `visibleTo`, list and search SQL are unchanged to
  the character (unit test). With rows, one indexed statement loads the scope per request.
- **The guest surface** (the only routes with `guests: true`): `GET /workspaces` (lists guest
  workspaces), `GET /workspaces/:id/pages`, `GET /pages/:id/lock`, comments (list, add, edit and
  delete own), `POST /pages` (under an editable shared page), `PATCH /pages/:id` (title, icon, cover,
  full width only), `GET /pages/:id/backlinks` (sources narrowed, no parent ids), `POST /files` (with
  an editable page), `GET /files/:id` (files of visible pages; legacy files without a page are
  refused), and the collaboration socket (read-only below `edit`). Everything else is member-only.
- **Collaboration socket**: `onAuthenticate` runs its page lookup inside the guest scope, accepts a
  non-member only as a guest of that workspace, applies the 2FA rule, and sets `readOnly` from
  `capsFor` (level and lock). Row changes close the person's sockets in the subtree; bulk removal
  closes their sockets in the workspace.
- **Fixed on the way**: the single-canvas export now reads referenced titles from the canvas's own
  workspace only (`md/exporter.ts`).

## Leak checklist (tested in guests.db.test.ts, per path)
Workspace list (role, rights, invite code); page tree (only shared trees, tops without parent);
member vs stranger; 403 for search, graph, islands, tags, trash, members, member candidates, settings,
activity, workspace export, templates, bookmarks, public link list, due, agent instructions, large
pages, webhooks, audit, guest list, notification level, changes, context, inbox, query, quick task,
import; cross-workspace feeds (context, changes, inbox, notifications, read_pages) without guest
workspace content; 404/403 for lock, comments, backlinks, export, share, access, snapshots, size,
outline of outside pages; member-only page routes inside the tree (export, access list, public link,
history, unlinked, content write, duplicate, trash, lock, bookmark); backlinks inside; levels in the
lock status; create (inside, top level, outside, under view); rename, move, scope, view page; comments
by level; files (upload, download, no page, view page, outside page, legacy); socket (edit, view,
outside, stranger); access list and publishing refused; canvas export across workspaces; outbox
payloads of a guest comment; API token and MCP (`list_workspaces`, `read_page`); member rows
(view, comment, full; version bump; trash of an ancestor); policy (off, members, levels); candidates
(exact email only); guest list and bulk removal with audit; email invitations (mismatch, accept,
once); member removal and join drop rows; 2FA for guests (REST and socket); last row removed.

## Alternatives considered
- **Open `requireMembership` to guests everywhere and rely on `visibleTo`** (the range approach): the
  range only narrows a *member*; workspace-wide data that is not pages (members with emails,
  settings, audit log, webhooks, agent lists, policy) would need a deny table that every future
  route must remember. An allow-list of a dozen routes is reviewable.
- **Check grants inside `findVisiblePage`/`visibleTo` without a scope**: one more join on every page
  read for everyone.
- **Precompute the guest's page ids per request**: a large array per statement and stale after
  creating a page in the same request; one uncorrelated walk per statement (as for ranges) is
  measured instead (docs/PERFORMANCE.md).

## Consequences
- A new route that guests need must opt in explicitly and add a line to the checklist test.
- A new raw query that spells visibility by alias must add `pageInRangeSql` (as for ranges); it now
  covers guests too.
- A page moved out of a guest's tree, or made private, disappears for them at once on REST; an open
  socket on it stays until it reconnects (the same window as role changes in docs/adr/0970-*).
