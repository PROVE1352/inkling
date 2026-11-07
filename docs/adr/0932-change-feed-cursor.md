# 0932. Change feed for agents: cursor, merge window, permissions, retention

- Status: Accepted
- Date: 2026-11-07

## Context
An agent that works with someone's notes across sessions has two bad options today: re-read every
page it cares about at the start of each session (thousands of tokens per page, most of it
unchanged), or trust a stale memory. It needs "what changed since I last looked", with the
content of the change, at a cost proportional to the change and not to the notes.

The MCP endpoint is Streamable HTTP and stateless: a new `McpServer` and transport per request
(apps/server/src/mcp.ts header comment). Agents connect for one session, disconnect, and come
back hours or days later, possibly from a different client. Anything that relies on the server
remembering a session, or on the agent being connected when the change happens, does not fit.

The section index (docs/adr/0926-*) already diffs each page's sections on every reindex
(apps/server/src/context/chunkIndex.ts:195 calls `recordSectionChanges` with the section lists
before and after). Live typing reaches it through the debounced indexer; REST/MCP writes are
indexed immediately inside the request, with the actor known through `currentEditActor`
(apps/server/src/context/attribution.ts:42, docs/adr/0936-*).

## Decision
**Log.** Table `page_changes` (migration 0028): one row per section change or page-level event,
with `seq bigserial` as the log position.
- Section rows come from the reindex: `computeSectionChanges` (apps/server/src/context/sectionChanges.ts:68)
  compares the before/after section lists by anchor and section hash. Kinds: `added`,
  `modified`, `removed`, `renamed` (a removed and an added section that are the same section:
  same heading block id first (:93), else identical body (:103); a parent heading rename
  cascades to its children), `moved` (sections on both sides whose relative order changed:
  everything outside the longest increasing subsequence of old positions taken in new order,
  O(n log n) with patience sorting, sectionChanges.ts:44 and :137 — inserting or deleting a
  section never makes the others "moved").
- The first index of a page that had no section rows logs ONE `page_added` row instead of one
  row per section (changeLog.ts:152, guarded by `NOT EXISTS` so a page is "added" once).
- Page-level rows come from the page routes, after their own transaction, best effort
  (`logPageEvents`, changeLog.ts:313; never fails the request): `page_renamed` (title),
  `page_moved` (parent), `page_visibility` (every page of the subtree whose scope changed),
  `page_trashed` (subtree), `page_restored` (subtree), `page_added` (subtree duplicate).
- Content, not just "changed": rows store the section body before and after, each capped at
  16 KB (`MAX_TEXT_BYTES`, changeLog.ts:51). A larger side is stored as NULL with
  `large = true`; the reader says "large change, read section".
- Provenance: `actor_id` and `via_client` from `currentEditActor` (section rows) or the route's
  `req.user` (page rows). The feed shows `by <name> via <client>` per page, never emails.

**Ordering.** Every write goes through one process-wide promise chain (`serialized`,
changeLog.ts:64) and each statement autocommits, so seq order equals commit order: a reader that
has seen seq N has seen every row ≤ N. The reader takes its end position through the same chain
(`reserveCursor`, changeLog.ts:93), so a cursor never has gaps behind it.

**Merge window.** Consecutive edits of the same section within 10 minutes
(`MERGE_WINDOW_MS`, changeLog.ts:52), with the same visibility and the same actor/client,
collapse into one row: the first row's `before`, the new `after`, a NEW seq (one `UPDATE … SET
seq = nextval(…)`, changeLog.ts:223, so the row moves to the end of the log). Editing back to
where an unseen row started deletes it. A merge is only allowed for rows above the high-water
mark — the highest seq ever handed out in a cursor (changeLog.ts:74, :206). The mark is
in-memory and initialised to `max(seq)` at first use after boot (every existing row may be
behind a cursor), single-instance like the rest of the collab state. Result: a merge never
rewrites a row an agent has already passed, so it can never hide a change.

**Cursor.** Opaque `base64url("c1.<seq>.<at>.<workspaceId?>")` (changeFeed.ts:67). `seq` is the
log position; `at` is a database time no later than the change time of any row after `seq`
(the reserve time for a caught-up cursor; for a continuation cursor the change time of the
last row at or before `seq`, which is safe because seq order is commit order, changeFeed.ts:692;
floored to the hour, changeFeed.ts:450);
`workspaceId` binds a cursor issued for one workspace to that filter (a global cursor may be
narrowed, a narrow cursor may not be widened — it would skip the other workspaces' rows before
it). No cursor → the tool returns only the current cursor ("start tracking from here").

**Read (`changes_since`, GET /api/changes).** Rows after the cursor up to the reserved end,
at most 2,000 per call (`FEED_MAX_ROWS`, changeFeed.ts:29; the returned cursor continues).
They are folded into NET changes per (page, anchor): the state at the cursor (before of the
first row) against now (after of the last row), following renames across anchors; add-then-
delete cancels, edit-and-revert cancels (md5 of the texts), repeated edits collapse
(`foldRows`, changeFeed.ts:181). Output is greedy in log order within the token budget
(default 3,000, max 12,000; 25% kept for the one-line list of what does not fit): the entry
that overflows is cut, the rest are listed without detail, and when even the list does not
fit, output stops and the cursor points just before the first unlisted entry (changeFeed.ts:687). It never cuts before the entry holding the
smallest seq is listed (:635): a page-level entry precedes its section entries but can be newer,
and cutting between them would return the same cursor and loop the agent.

**Deterministic, cache-friendly output.** The same cursor over the same document state gives
byte-identical text except the last line, which is always the cursor (`next cursor:`,
`cursor:` or `fresh cursor:`, changeFeed.ts:716). Order is explicit — pages and entries by
first seq with pageId/anchor tie-breakers in code-unit order (changeFeed.ts:270, :313), actors
sorted — never Map/Set or locale order; no clock, request id or timing reaches the text (the
diff caps are a work counter, not a clock, docs/adr/0933-*); stable page headers come before the
variable entries; the tool description is a fixed string. The cursor's time is floored to the
hour, so even the cursor line repeats while nothing is logged in that hour. Rows the caller cannot
see (other workspaces, others' private pages) never change the text.

**Permissions (all SQL, changeFeed.ts:472).**
- Only workspaces the caller is a live member of now (`workspace_members` + `liveWorkspace`,
  :492); `workspaceId` given → `requireMembership` in the route (routes/changes.ts:23).
- Rows carry the page's visibility at log time (`scope`, `owner_id`). Rows the caller could not
  see then are skipped entirely (:493): another member's private page never shows, not even as
  an id.
- Detail (title, anchors, text) only for pages the caller can see now (`visibleTo` +
  `deleted_at IS NULL`, :474). A page seen then but not now (trashed, made private, purged)
  collapses to `page <id>: removed (no longer visible)`. A page created and gone within the
  window is dropped.
- `page_visibility` rows store the union of both sides (changeLog.ts:289): made-shared reaches
  the new readers, made-private reaches the old readers as "removed".

**Retention.** `CHANGE_FEED_RETENTION_DAYS` (default 30, env.ts:122); housekeeping deletes older
rows in batches of 5,000, at most 40 batches per hourly run (changeLog.ts:329, housekeeping.ts:88).
A cursor whose `at` is older than the window, or whose `seq` is past the end of the log
(restored database, other server), gets `resync_required` with a fresh cursor and the recipe:
store the fresh cursor first, then list_pages + find_context/read_pages, then continue from the
fresh cursor. Because `at` ≤ the change time of every row after the cursor, a cursor inside the
window never needs a row that housekeeping has deleted.

## Alternatives considered
- **MCP resource subscriptions** (`resources/subscribe` + `notifications/resources/updated`):
  the server remembers subscriptions per session and pushes "this URI changed" on the open
  stream; the client then re-reads the resource. It needs session state on the server (our
  endpoint builds a new server per request), an open SSE stream at the moment of the change
  (agents are disconnected most of the time; Streamable HTTP resumability only replays events
  of the same session from an event store), and it says only "changed", so the agent still
  re-reads the whole page. A cursor is catch-up by construction: the agent stores one string,
  and whenever it comes back — new session, new client, days later — it gets the net
  difference with content. Subscriptions could be added later on top of the same log.
- **Snapshot comparison by the agent** (`updatedAt` per page from list_pages): tells which page
  changed, not what; the agent re-reads whole pages (measured below: ~15× the tokens).
- **Store only "section X changed", read the current text**: cannot show what was removed, and
  cannot net out add-then-delete; the before text is what makes a diff possible.
- **No merge, or merge by time only**: every debounced index pass of live typing would be a row
  (dozens per paragraph); merging without the high-water mark would rewrite rows an agent has
  already seen, and its next diff would start from a state it never had.
- **One transaction per reindex for all rows / Postgres-assigned order without the chain**:
  concurrent transactions commit out of seq order, so a reader at seq N could later find a
  committed row < N — a gap that silently loses a change. Serialising writes in-process is the
  cheapest way to make seq order equal commit order on one instance.
- **Cursor = timestamp**: clock ties and merges that rewrite `changed_at` make it ambiguous; seq
  is exact.

## Trade-offs
- Single instance: the promise chain and the high-water mark are in memory. A second server
  process writing the same table would need a database-side sequence lock (e.g. an advisory
  lock around each write and the reservation).
- Writes are serialised process-wide; each is a handful of small statements after the index
  write, off the typing path, but a burst of imports queues behind itself.
- Before/after text up to 2 × 16 KB per row; with merging, roughly one row per edited section
  per 10 minutes. 30 days of retention bounds the table.
- Merging is conservative across actors: an agent edit and a human edit of the same section in
  the same window stay two rows (provenance stays exact).
- A rename is detected by heading block id or identical body; a heading renamed AND rewritten in
  a document without block ids (Markdown import) shows as removed + added.
- The progress guarantee can push one call over its budget by the head lines of the entries
  before the oldest one (seen only with a very long title or many page-level events at once).
- Live typing has no actor (the collab connection is not attributed per change), so those rows
  show no "by".
- `page_added` on the first index of a page: a page created but never opened or written is never
  indexed and does not appear until it has content.

## How others solve it
- Google Drive `changes.list` with `startPageToken` / `newStartPageToken`: the same opaque
  cursor model, catch-up rather than push; push channels exist but still hand back a page token.
- Microsoft Graph delta queries: `deltaLink` token; an expired token returns `410 Gone`
  (`resyncRequired`) and the client re-enumerates — the same contract as `resync_required`.
- Dropbox `list_folder/continue` with a cursor and a `reset` error; CouchDB `_changes?since=seq`;
  Kubernetes watch with `resourceVersion` and `410 Gone` when it is too old.
- Notion's API has no change feed; integrations poll `last_edited_time` (page granularity) or
  use webhooks (push, needs a reachable endpoint) — neither works for an agent that is offline.

## Consequences
- An agent stores one cursor per user (or per workspace) and pays tokens proportional to what
  changed. Measured in the [db] suite (apps/server/src/context/changeFeed.test.ts): 40 edits on
  12 sections of 4 pages → 12 log rows, recall 12/12, 388 tokens vs 5,724 tokens for re-reading
  the 4 pages with read_page (6.8%).
- New tool `changes_since` (apps/server/src/mcpTools/changeTools.ts:11) and route
  `GET /api/changes` (apps/server/src/routes/changes.ts:23).
- The diff shown for modified sections is described in docs/adr/0933-*.

## References
- apps/server/src/context/changeLog.ts:51-93 (caps, chain, high-water mark, reserveCursor), :141 (section rows), :152 (page_added), :206-223 (merge), :289 (visibility union), :313 (route helper), :329 (retention)
- apps/server/src/context/sectionChanges.ts:44 (LIS), :68 (change detection)
- apps/server/src/context/changeFeed.ts:67 (cursor), :181 (fold), :270 (ordering), :450 (hour floor), :472 (permission SQL), :597 (resync), :621 (budget), :635 (progress guarantee), :687 (cut cursor), :716 (cursor last line)
- apps/server/src/context/chunkIndex.ts:195 (contract call), apps/server/src/context/attribution.ts:42
- apps/server/src/routes/pages.ts:502, :524, :786, :964 (page-level hooks)
- apps/server/src/pageDto.ts:98 (`visibleTo`), apps/server/src/workspaceLive.ts:13 (`liveWorkspace`)
- apps/server/src/housekeeping.ts:88, apps/server/src/env.ts:122
- MCP specification 2025-06-18, Resources: subscriptions; Transports: Streamable HTTP, resumability
