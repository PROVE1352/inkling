# 1202. The range is enforced at the permission boundary, not in the tools

- Status: Accepted
- Date: 2026-11-07

## Context
docs/adr/1200-* lets a connection see only some workspaces or one subtree. MCP tools call the REST routes
through `app.inject` as the token's user, and API tokens call the same routes from outside. Checking the
range in each tool would miss REST and every future tool; checking it in each route would need dozens of
edits that the next route forgets.

## Decision
- **Carrier**: `requireUser` (as a preHandler) runs a bearer request whose token has a range inside
  `runInRange(scope)` (AsyncLocalStorage, `tokenRange.ts`), the same way 0947 carries the agent scope;
  `loadAgentContext` (the in-process agent context of 1070) enters it too. The scope carries the user id:
  a query about someone else in the same request (a notification recipient) is not narrowed. Without a
  range (browser sessions, background jobs, `all` tokens) no store exists and no SQL is added.
- **Readers**, all existing choke points:
  - `requireMembership` / `requireMembershipAcl`: a workspace outside the range is 403 `OUT_OF_RANGE`.
  - `agentAllowedSql(wsCol)` (every cross-workspace list: `GET /workspaces`, `memberWorkspaceIds` for
    find_context, the change feed, the inbox) also requires the workspace to be in range.
  - `visibleTo(userId)` (every page list, search, backlinks, graph, tags, trash, collections, exports,
    `findVisiblePage`) gains `workspace_id = ANY(range)` and, for a subtree,
    `pages.id IN (WITH RECURSIVE … from the root)`: uncorrelated, so one walk per statement, capped at
    `TREE_MAX_DEPTH`, regardless of `deleted_at` so trash, restore and purge stay consistent.
  - Raw SQL that spells visibility by alias uses `pageInRangeSql(id, ws)`: find_context
    (`retrieve.ts`), the change feed rows (`changeFeed.ts`), the activity list, its client list and the
    change diff (`activity.ts`), the inbox and its ack (`inbox.ts`), `FROM [[title]]` in the query
    language (`query/compile.ts`). Notifications without a page are filtered by workspace; "mark all
    read" and "ack up to cursor" only touch what the token can see.
  - Caches keyed by user include the range (`rangeCacheKey`, query results).
  - The lock state of a page names its lock root above it; outside the range the title is ''.
- **Creating and moving** (subtree): `assertPlacement` requires the subtree root in the parent's
  ancestor chain, and in the moved page's (`assertPlacementInRange`). Every place that creates or moves
  to the top level of a workspace calls `assertTopLevelInRange`: new page, move to the top, duplicate
  and canvas copy of a top-level page, Markdown and folder import without a parent, vault sync create,
  the quick-task "Tasks" document, restore that promotes to the top (except the root itself). Moving out
  of the subtree and moving in from outside are refused (out-of-range pages are not found); nothing is
  moved "and then invisible". A page someone else moves in or out changes the range at once.
- **Links and mentions**: a page in range keeps the text its links were written with; the target's
  current title, id and content are not looked up for an out-of-range target. This is the existing rule
  for links to pages the reader cannot see (Markdown export writes the stored text; vault sync looks
  titles up through `visibleTo`, which now includes the range).
- **Agent instructions** (0975) stay readable to a subtree connection even when the instruction page is
  outside the subtree: they are the workspace's rules for agents, locked and published on purpose, and an
  agent that cannot read them would work without them. Their titles and bodies are what a ranged agent
  sees outside its subtree, by design.
- **Workspace-wide objects** with content from anywhere are refused for a subtree range (templates) or
  any range (creating a workspace, member candidates) in the bearer route table (docs/adr/1204-*).

## Leak checklist (tested in tokenRange.db.test.ts, per path)
Workspaces list; other workspace (403); page list; search; find_context (all and one workspace);
read_pages and single-page reads; stored link text vs renamed target; backlinks; graph; tags; trash;
query block rows, `FROM [[title]]` oracle and the result cache; changes_since; activity; inbox and its
ack; notifications and mark-read; create (in, top level, under outside, duplicate root, quick task);
moves (out, root out, in, inside, someone else's move); database rows and row templates of an outside
collection; templates and member candidates; lock root title; MCP tools (list_workspaces, search,
find_context, list_pages, read_pages, changes_since, inbox, read_page, create_page, list_pages of another
workspace, server instructions); a grant whose root is gone; workspace range across the same reads.

## Alternatives considered
- **Precompute the subtree id set per request** and pass `= ANY($ids)`: one walk per request instead of
  per statement, but a large array per statement and stale within a request that creates pages. The
  per-statement walk measured +0.5–0.8 ms on read_page (docs/PERFORMANCE.md).
- **A materialised path column**: faster prefix checks, but every move rewrites a subtree and every
  writer must keep it right. Not worth it for this.
- **Filter in the MCP tools**: misses REST, which API tokens use directly.

## Consequences
- Every future route that uses `visibleTo`, `findVisiblePage`, `requireMembership` or `agentAllowedSql`
  is range-safe. A new raw query that spells visibility by alias must add `pageInRangeSql`.
- A subtree token cannot use query sources that start at the workspace root (`file.folder`/path
  sources see only the subtree), workspace templates, or create top-level pages.
- `changes_since` does not report a page leaving the range as removed (it cannot know the page was ever
  in range); a client keeping a copy should resync after the range changes.

## References
- apps/server/src/tokenRange.ts, pageDto.ts (visibleTo), helpers.ts (membership), agentAccess.ts
  (agentAllowedSql), pageTree.ts (assertPlacement), editLock.ts (pageLockStatus)
- apps/server/src/context/retrieve.ts, context/changeFeed.ts, routes/activity.ts, routes/inbox.ts,
  routes/notifications.ts, routes/query.ts, query/compile.ts, routes/pages.ts, routes/exportImport.ts,
  routes/sync.ts, routes/tasks.ts
- docs/PERFORMANCE.md (connection range row), apps/server/scripts/range-bench.ts
