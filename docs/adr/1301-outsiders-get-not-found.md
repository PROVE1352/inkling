# 1301. Someone outside a workspace gets "not found" for its ids

- Status: Accepted
- Date: 2026-11-09

## Context
Pages, comments, change rows, templates and files are addressed by UUID. Several routes looked the
row up first and only then ran `requireMembership`, so a signed-in account that is not in the
workspace got 404 for an unknown id and 403 (`FORBIDDEN`, or `TWO_FACTOR_REQUIRED` with the
workspace id) for an id that exists elsewhere. `findVisiblePage` made it worse after
docs/adr/1112-*: its `visibleTo` filter does not look at membership, so it threw
`TWO_FACTOR_REQUIRED { workspaceId }` to any outsider who sent the id of a shared page in a
workspace with the requirement on, before the caller's membership check. Found in a security pass:

- `findVisiblePage` (every page route, `PATCH`/`DELETE /comments/:id`, MCP `read_page` and the
  tools behind it);
- `GET /api/changes/:seq/diff`, `DELETE /api/templates/:id`, `GET /files/:id`;
- MCP `reply_comment`, whose own "Thread not found" differed from the REST error text for a thread
  it could not see;
- found in the follow-up sweep: `/webhooks/:id` (all its routes), `POST /pages/:id/restore`,
  `DELETE /pages/:id/purge`, `PUT /pages/:id/sync/md`, `DELETE /pages/:id/sync`, and
  `PATCH /pages/:id { parentId }`, where a parent in another workspace answered 400
  "Invalid parent page" and a missing one 400 "Parent page is invalid".

UUIDs are hard to guess, but they travel in links, mails, exports and agent transcripts; the answer
should not confirm that one is real or name its workspace.

## Decision
- `memberOrGuestSql(wsCol, userId, guests = true)` (`pageGrants.ts`): the user is a member of the
  workspace, or a guest there (docs/adr/1252-*). Inside a request's guest scope the scope decides
  (token requests never count as guests, 1253); without one (routes that call `requireUser`
  directly, jobs acting for someone) a live `page_grants` row of the user in that workspace does.
- `findVisiblePage` adds it to its `WHERE`: an outsider gets `null` → 404, the same body as a
  missing id. Members and guests still get 403 `TWO_FACTOR_REQUIRED` when blocked (they can act on
  it). Callers keep their `requireMembership` call for the role, range and agent checks.
- The id lookups listed above add the same predicate (member-only where the route is member-only).
  The move check looks the new parent up in the page's own workspace.
- `reply_comment` maps a 404 from the REST route to its own "Thread not found" text.

## Alternatives considered
- Catch `FORBIDDEN` from `requireMembership` and rethrow 404 in each route: a second, easy-to-miss
  step per route, and it still runs the 2FA check before knowing the caller is a member.
- 403 for everything: changes every "not found" in the API and the web app's empty states.

## Consequences
- Page routes answer 404 instead of 403 to outsiders (`GET /files/:id`: 404 instead of 403 for a
  non-member). A former guest whose last row was removed is an outsider.
- `findVisiblePage` now means what its comment said ("visible to `userId`"), which also tightens
  callers that used it without a membership check (parent checks on create/import, template
  sources, range validation, split-page mentions, sheet sync).
- Routes behind the per-file `requireSessionUser` helpers (page access, edit lock, workspace
  administration, notification settings, sidebar) run without the request's guest scope, so a
  guest there is matched by the `page_grants` fallback and is not narrowed to their shared trees
  (unchanged from before; docs/KNOWN-ISSUES.md).
- One more primary-key `EXISTS` per page lookup.
- Tests: `accessLeaks.db.test.ts`; `guests.db.test.ts` ("removing the last row" now expects 404).
