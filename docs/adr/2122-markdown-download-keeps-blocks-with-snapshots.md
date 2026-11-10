# 2122. The Markdown download keeps charts, database views and queries with a snapshot

- Status: Accepted
- Date: 2026-11-10

## Context
The plain Markdown export turned charts into tables (ADR 1605) and left page and link embeds out; an
import of that file lost the charts and embeds, and query blocks came back without their results in
the file. The same plain notation is used by vault sync, templates, history previews and link
previews, which must not change.

## Decision
- A third notation mode, `file` (`md/notation.ts`), used by the download only: `GET
  /pages/:id/export?format=md&notation=file` (the web's "Export as Markdown" sends it) and every zip
  (subtree and whole workspace; `notation=plain` gives a zip the 0.16 output). The md default stays
  `plain` (link previews read it).
- `md/fileExport.ts` before writing:
  - chart: its token, then a snapshot of its table for the exporting member;
  - database view: the page-embed token (ids), then a snapshot: a bold "Database · View" line and the
    view's rows as the member sees them (at most 1000);
  - query block: the ```dataview fence, then a snapshot of its results;
  - page embed of a page: a link (`[[Title]]`); link embed: a link; not visible: left out.
- A snapshot sits between `<!-- inkling:snapshot -->` and `<!-- /inkling:snapshot -->` (invisible
  in Markdown viewers). On import a snapshot right after a block token or a code fence is dropped and
  the block comes back; anywhere else only the markers vanish, and an unterminated one is kept. So
  export → import → export is the same file.
- A chart whose source the member cannot see keeps its token (its config is in the page anyway) and
  gets no snapshot. A page embed whose page the member cannot see is left out, as before: whether it
  was a database view or a page cannot be told without saying that the page exists.
- PDF (print) prints the live page: the database view box and page-embed bodies are uncapped in
  `print.css`.

## Alternatives considered
- Change `plain`: vault sync and templates would start carrying tokens (and running queries on every
  sync).
- Snapshot as a table only, restored by matching: fragile, and a reader's edits to the table would
  turn into a different block.
- Tokens only, no numbers: the file would be useless outside the app.

## Consequences
- An import into another workspace or instance restores the blocks, which then show "not
  available" there (ids from elsewhere); the snapshot is not imported.
- Query and chart results in the browser print only once they are on screen (they load lazily).
- Tests: `md/fileExport.test.ts` (notation), `md/dbView.db.test.ts` (download, round trip, zip).
