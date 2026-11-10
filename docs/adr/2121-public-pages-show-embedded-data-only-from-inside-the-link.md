# 2121. Public pages show embedded data only from inside the link

- Status: Accepted
- Date: 2026-11-10

## Context
Until 0.16 public pages dropped page and link embeds and showed query blocks as their source code
(KNOWN-ISSUES). Page embeds, database views (ADR 2120) and query blocks all pull data from other
pages; a public link must never show anything outside what it shares (ADR 1302, 1605).

## Decision
- One gate for every kind: the pages inside the link, recomputed on every request after the link's
  token, password and schedule checks (`routes/public.ts`): the page itself for a single-page link;
  the folder and its current subtree for a folder link. Never what the person who shared it can see.
- `routes/publicBlocks.ts publicCustomBlocks` runs inside the two existing handlers and replaces the
  blocks with ordinary blocks before `blocksToFullHTML`; `md/convert.ts publicBlocks` still drops any
  embed left (fail closed), so no id, view id, config or query text reaches the HTML.
  - Page embed of a page inside: its title (a link to its public address) and its body one level deep
    (embeds inside it become links); its charts as tables (ADR 1605); its images through its own
    public address, since the file gate is per page.
  - Database view of a collection inside: a table of the view (filters, order, columns), shared rows
    that are inside the link, no relation titles, no rollups, at most 200 rows; a chart view as the
    chart's table.
  - Anything else (outside, private, trashed, another workspace): one line, "Embedded content that is
    not part of this link.", with no title, kind or id.
  - Link embed: a card of the cached preview title and the URL. The anonymous route never fetches.
  - Query block (```dataview): run with no user (`PUBLIC_READER_ID`, whose `visibleTo` is "shared
    pages") inside a connection range of the link's subtree (ADR 1200), then cut to the pages inside
    the link (the range does not stop at private or template pages); relation cells keep linked pages
    inside only; page titles link to their public addresses.
- Placeholder words follow `DEFAULT_LOCALE` (the HTML cache is per page, not per reader).

## Alternatives considered
- Data the sharer can see: publishes rows and pages the link does not contain.
- A new public route per block (lazy loading): a new surface to gate; one render inside the gated
  handlers inherits the password, schedule and expiry answers.
- Running queries through a separate "public" compiler: duplicate SQL; the range already narrows
  every `visibleTo` the compiler uses, including the folder tree and `FROM [[link]]`.

## Consequences
- The rendered HTML is cached per page revision, link and (folder links) membership fingerprint for
  up to 10 minutes: a page leaving the link (private, trashed, moved) changes the fingerprint and is
  gone at once, but changed rows, query results or an embedded page's text can lag up to 10 minutes
  (as CHART-1).
- Query sources of charts stay left out on public pages (ADR 1605).
- Tests: `md/dbView.db.test.ts` (folder link: inside view, embedded page, nothing from outside, no
  page / collection / view id in the HTML; private / trash / move-out take effect on the next
  request; single-page link; password, not started and expired links).
