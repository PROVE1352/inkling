# 2123. Database views in agent reads: the page-embed token and a name line

- Status: Accepted
- Date: 2026-11-10

## Context
Agents read pages as Markdown with tokens for what Markdown cannot say (ADR 1500). A database view
(ADR 2120) must survive read → patch_section / update_page, and an agent should know what it shows
without the rows being spelled out.

## Decision
- The token is the page embed's: `<!-- inkling:pageEmbed {"pageId":"<collection>","viewId":"<view>"} -->`,
  ids only, so a rename does not change the page's text. Parsing accepts a `viewId` that is an id and
  drops anything else (first view).
- read_page (whole page and sections) adds one line under each page-embed token whose page is a
  database the reader can see: `<!-- inkling:view-info database "Roadmap", view "Board" (board); its
  rows: query_rows -->`. It is computed through `GET /pages/:id/collection?rows=0` as the token's user
  and names are cleaned as member text. A database the reader cannot see gets no name; only a block
  that names a view says "unavailable", so the line is no oracle. `view-info` does not match the token
  pattern, so writing the read back drops the line and the block is unchanged.
- No new tool: an agent adds a database view by writing the token line through update_page or
  patch_section (same suggestion mode, policy, locks and claims as any write).

## Alternatives considered
- The view name inside the token: readable, but the token (and the page's text and version) would
  change when someone renames a view.
- Rows under the token: large and stale; `query_rows` reads them with filters and paging.
- A create_database_view tool: one more tool in the list for what one token line does.

## Consequences
- `known=` answers "unchanged" when only the view's name or rows changed (as CHART-4).
- Tests: `md/dbView.db.test.ts` (token and name line, the hidden database, update_page and
  patch_section keep the view, an appended token creates one), `md/fileExport.test.ts`.
