# 1520. catch_up: one call for "what happened while I was away"

- Status: Accepted
- Date: 2026-11-09

## Context
An agent that comes back to a workspace after a day asks one question first: what happened? With
the tools so far it had to call `changes_since` (needs a stored cursor, lists every change in log
order), `inbox` (only what is addressed to the person, and only until acknowledged), `later`, and
read comment threads page by page. The server has no language model, so it cannot write the summary;
it can hand over the material, ranked and within a budget, the way Slack's "catch up" view orders
what is unread.

## Decision
- MCP tool `catch_up(workspaceId?, since?, budget?, peek?)` over `GET /api/catch-up` (read-only
  tokens may call it). One text answer, most important first, in fixed groups:
  1. For you: inbox kinds (mentions, replies, assignments, comments on the person's pages) created
     after `since`, with `can:` and the inbox id;
  2. Due soon: undone tasks, rows and dated pages due today and tomorrow, overdue (14 days), and the
     rest of the next 7 days (the Due view's items, `collectDateItems`);
  3. Later reminders that are due or come due within 7 days;
  4. Comments: new threads and replies after `since`, grouped per page, thread starts and replies as
     one line each;
  5. Pages changed by others: per page the number of edits, who and via which client (×count),
     section units with diffs (the change feed's fold and diff, `foldRows`/`unitBody`), renames,
     moves, restores; new pages with their first lines; trashed or hidden pages by id only;
  6. Your own changes (the person or their agents) last.
  A header line counts everything (pages, threads, replies, for-you, due, reminders) whether or not
  it fits; a `not shown` line counts what the budget left out per group; the last line is
  `next since: <cursor> (up to <time>)`, the only part that changes while nothing happens (0937).
- `since` is a catch_up cursor (`u1.<seq>.<ms>`: change-log seq and time), a `changes_since` cursor
  (its seq, its hour-floored time) or an ISO time. Omitted: the connection's last catch_up, else the
  person's last catch_up from any connection, else the last 24 hours (docs/adr/1522-*). The header
  says which.
- Everything is read with the existing permission rules: the change rows through the change feed's
  scope (`feedRowScopeSql`, now shared with `changes_since`: membership in a live workspace, agent
  blocks, 2FA, visibility at log time, connection range), titles only for pages visible now, the
  inbox and Later readers as they are, due items per member workspace (`memberWorkspaceIds`), and one
  comment query with the same predicates. Member-written text sits in one `<untrusted_content
  source="catch_up">` block (0976).
- Roles of the overlapping tools, written into their descriptions:
  - `changes_since`: exhaustive sync with a cursor the agent stores, in log order; for keeping a copy.
  - `inbox`/`ack`: the person's actionable items until acknowledged.
  - `later`: the person's saved list.
  - `catch_up`: a one-shot ranked overview across all of these; acknowledges nothing, moves no inbox
    or changes cursor, and is lossy by design (the budget); it points to the other tools for the rest.

## Alternatives considered
- **Extend `changes_since`** with comments and inbox items: mixes an exhaustive, cursor-exact sync
  with a lossy ranked view; a sync client would have to filter the extras out.
- **Server-side summary with a model**: Inkling has no model and should not call one with members'
  notes.
- **Acknowledge inbox items listed by catch_up**: an overview is not handling; the person's agent
  might list items it never acts on.

## Consequences
- An agent answers "what happened since yesterday" with one call. On a workspace with 2,500 pages,
  6,000 changes in the window, 400 comments, 30 inbox items and 200 dated tasks the call takes a median
  of 100 ms (budget 4,000) / 91 ms (12,000), 201 / 203 ms with 20,000 changes, and fills 99 % of the
  budget (docs/PERFORMANCE.md).
- Due items and reminders are state, not window events: they are listed on every call while due.
- Pages with more than 2,000 log rows in the window get a head line without a diff (the fold needs
  every row); at most 400 pages are ranked and 40 get section diffs, the rest are counted.

Tests: `apps/server/src/catchUp.test.ts` (since parsing, cursor, packing, item ranking),
`apps/server/src/mcpTools/catchUp.db.test.ts` (groups and order, diffs and provenance, escaped
markers, private pages hidden, nothing acknowledged, since as time / changes cursor / old cursor,
peek, a new connection, a read-only token, a small budget, a non-member).

## References
- apps/server/src/catchUp.ts, apps/server/src/routes/catchUp.ts, apps/server/src/mcpTools/catchUpTools.ts
- docs/adr/0932-*, 1003-*, 1413-*, 0976-*, 0937-*
