# 1300. The two-step requirement also covers cross-workspace reads and notification mail

- Status: Accepted
- Date: 2026-11-09

## Context
docs/adr/1112-* enforces "require two-step verification" at the two choke points
(`requireMembership*`, `findVisiblePage`) and the collaboration socket. Reads that span every
workspace of the user do not pass through either: they filter with their own
`workspace_members` join. 1112 left the in-app notification list and the iCal feed covered and
listed the rest as known issues. A security pass found four of them reachable today:

- `changes_since` without `workspaceId` (`context/changeFeed.ts` `loadRows`) returned section text
  of pages in a workspace that blocks the caller;
- the agent inbox without `workspaceId` (`routes/inbox.ts` `readInbox`) listed its items with page
  titles and excerpts;
- `find_context` without `workspaceId` and `read_pages` (`context/retrieve.ts`
  `memberWorkspaceIds`) returned page bodies;
- notification mail (`notify/mailer.ts` `pending`, instant and digest) mailed titles and excerpts.

A sweep of the remaining routes found the same gap in five more places:

- `GET /pages/agent-context` (MCP output facts: editors, `can`, instruction titles) filters with
  its own `workspace_members` join;
- the notification list held back page notifications of a blocked workspace but not its
  workspace-level ones (`page_id` null), and an AI summary (`agent_digest`) lists page titles in
  its excerpt;
- member candidates (`GET /workspaces/:id/member-candidates`) searched the members of every
  workspace the caller shares, a blocked one included, so its members could be found (and added)
  through another workspace;
- `GET /me/notification-settings` listed subscriptions of a blocked workspace with the root page
  title;
- `DELETE /workspaces/:id` and `POST /workspaces/:id/restore` read the role with `memberRoleTx`
  instead of `requireMembership`, so a blocked owner (or someone holding only the password) could
  delete or restore the workspace.

A blocked member could read the workspace through any of them, so the policy only held for the
web app's own screens.

## Decision
- Every cross-workspace read adds `NOT twoFactorBlockedSql(<workspace>, user)` next to its existing
  membership / live-workspace / agent-block filter, the same predicate 1112 uses. A blocked
  workspace is left out, as the notification list and the iCal feed already do; no 403 is raised,
  because the request is not about that workspace.
  - `read_pages`: a page of a blocked workspace is listed under `missing`.
  - `find_context` without `workspaceId`: the workspace is not searched.
  - The workspace-scoped forms (`?workspaceId=`) keep answering 403 `TWO_FACTOR_REQUIRED` through
    `requireMembership`.
- **Mail: drop, not hold.** At send time an item of a blocked workspace is "not ok", like an item
  whose page is no longer visible: its `mail_state` is cleared, it is never mailed, and it stays in
  the app (it shows up in the list again once the member turns 2FA on). Holding it until then would
  keep the user in the hourly digest query forever and could mail a burst of stale items weeks
  later. The instant mail of a member who satisfies the policy is unaffected.
- The same predicate is added to agent context, the notification list's workspace-level rows
  (except `workspace_deleted`), the member-candidate search (a blocked workspace does not count as
  shared) and the subscription list.
- Workspace delete and restore check `isTwoFactorBlocked` after the owner check and answer 403
  `TWO_FACTOR_REQUIRED` like every other workspace route.
- `POST /inbox/ack` is not filtered: it only marks the user's own rows and returns a count.

## Alternatives considered
- Refuse the whole cross-workspace request with 403 while any workspace blocks the user: one
  workspace's policy would break search and the feed for all the others.
- Hold blocked mail items (`mail_state` unchanged) until the user complies: see above.
- One shared "workspaces this user may read now" function for all of them: the four queries have
  different shapes (a subquery, a coalesce over two columns, a CTE input, a send-time flag); the
  predicate is already the shared part.

## Consequences
- One more correlated `EXISTS` per row group in these queries; it reads the workspace row by key
  and, only while a requirement is on, the user's TOTP row.
- A `workspace_added` notice of a workspace that blocks the member at once (grace 0) stays hidden
  until they turn 2FA on; the workspace list still shows the workspace, marked blocked.
- Outgoing webhooks are still not filtered: they are the workspace's, not the member's
  (docs/KNOWN-ISSUES.md).
- Tests: `accessLeaks.db.test.ts` (inbox, find_context, read_pages, agent context, notification
  list, member candidates, subscriptions, workspace delete/restore), `context/changeFeed.test.ts`
  (feed), `notify/notify.db.test.ts` (mail).
