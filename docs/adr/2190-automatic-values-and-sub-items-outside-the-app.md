# 2190. Automatic values and sub-items in database tables outside the app

- Status: Accepted
- Date: 2026-11-10

## Context
0.17 added automatic values (created / edited time and by, unique IDs; ADR 2140, 2141), OR / NOT
filters (ADR 2142) and sub-items (ADR 2144) to collections, and database views in pages (ADR 2120)
that public pages and the Markdown download show as tables (ADR 2121, 2122). Those tables read
`pages.props` directly, so the automatic columns came out empty, a sort on an ID did nothing, and a
table view showed sub-items as a flat list while the web shows a tree. Created by / last edited by
are people: on a public page their names fall under the person rule (member names only, C-L11), and
"last edited by" can carry the agent connection the change came through ("Name (via Client)").

## Decision
- The collection table of the export and of public pages (`md/exporter.ts collectionTableMdCore`)
  selects the page columns the automatic values need (`autoSourceColumns`) and fills them into the
  rows (`fillRowsAuto`) before formulas, filters and sorts read them, as every other reader does.
- Cells: an ID as `PREFIX-n` (`formatUniqueId`); created / edited time as the ISO UTC string the API
  serves; created by / last edited by as the member's name, `-` for anyone who is not a member of
  the workspace (the person rule).
- Public pages show those names, as they already show person cells and as the public chart groups
  by them (`charts/aggregate.ts`), but never the connection name: "(via Client)" is shown only in a
  member's download. A connection name is a member's own label for a tool and says nothing a reader
  of the page needs.
- Sorts on the server follow the web's sort keys for the new types (IDs by number, timestamps as ISO
  text, rollups) (`md/viewRows.ts`).
- A table or list view with a Parent item field and without `subItems: 'flat'` writes its rows in
  tree order (`treeRows`, the web's order: a row whose parent is filtered out is a top-level row), the
  title prefixed with one `↳` per level. Other view types stay flat. The row cap applies after the
  tree order.

## Alternatives
- Hide created by / last edited by on public pages entirely: rejected, the same names are already on
  the page through person cells and the chart of the same view; hiding one column would only make the
  table and the chart disagree.
- Show "(via Client)" on public pages too: rejected (above).
- Indent sub-items with spaces: GFM trims leading spaces in cells, so the arrow carries the depth.

## Consequences
- The public table, the download and the chart aggregate of one view count the same rows for the
  same reader (`md/int017.db.test.ts`).
- A row's author name appears on a public page only if a member added a Created by / Last edited by
  property and left it visible in the shared view.

## Files
- apps/server/src/md/exporter.ts, apps/server/src/md/viewRows.ts, apps/server/src/md/customTables.ts
- apps/server/src/md/int017.db.test.ts
