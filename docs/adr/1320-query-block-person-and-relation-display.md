# 1320. Query blocks show people by name and relations as page links

- Status: Accepted; WHERE and SORT on stored values are superseded by [ADR 1352](1352-query-block-compares-people-by-name-and-relations-by-title.md) (names and titles)
- Date: 2026-11-09

## Context
A query block that names a collection's person or relation field printed the stored values: a user id
for a person, a list of row ids for a relation (`TABLE Status, Owner, Due FROM "Roadmap"` showed
`fd2610be-…` under Owner). The compiled statement reads collection fields as stored (`props->fieldId`)
except select and multi-select, which it maps to option labels in SQL. Collection views, exports and
`query_rows` already show names and titles (`collectionQuery.ts`, `md/exporter.ts`,
`collectionRelations.ts`), each with the same rules: names of workspace members only (C-L11), linked rows
only when alive, visible to the viewer and a child of the field's target collection.

The raw relation ids also told a viewer that a linked row exists when that row is private to someone
else (the id of a row in another member's private collection came back in the cell).

## Decision
- The compiler reports, per output column (TABLE columns and the LIST value), whether the column is a
  bare property reference (`CompiledQuery.columnProps`), and the statement returns `pages.parent_id`.
- After LIMIT the route runs one display pass, `query/cellRefs.ts resolveCellRefs`: one statement for the
  field definitions of the rows' collections, one for member names, one for the linked pages
  (`visibleTo`, same workspace, not deleted), at most three whatever the row count. A cell is replaced
  only when the row's collection has a person or relation field of that name and the value has the stored
  shape (a uuid, a list of uuids):
  - person: the member's name; not a member (or not found): `null`, never the id;
  - relation: `QueryPageRef[]` (`{ ref: 'page', pageId, title }`) for the visible links whose parent is the
    field's target collection, in stored order, duplicates once. Hidden, trashed and foreign links are
    dropped, so the id of a hidden row is no longer sent.
- (Superseded by 1352.) WHERE and SORT keep working on stored values. `Owner = "<id>"` and `contains(\`Blocked by\`, "<id>")`
  behave as before; only what the block displays changed.
- The web block renders refs as links (`QueryResultView` `CellValue`), comma-separated like other lists;
  an untitled row reads "Untitled". `elapsedMs` now covers the statement and the display pass.

## Alternatives considered
- Resolve inside the SQL (a `CASE` for person/relation next to the select mapping). The value would then
  be the name in WHERE and SORT too, which changes what existing queries match, and the lateral is
  evaluated for every candidate row before LIMIT, not only for the rows shown.
- A type column per property in the lateral (`t{i}` next to `p{i}`) so the route knows exactly which
  values came from a collection field. Exact even when a page property of the same name exists, but it
  is a second correlated lookup per candidate row. The route reads the type from the rows' collections
  instead (one statement for at most LIMIT rows); a free page property of the same name that holds a
  member id or a list of row ids would be shown as a name or links, which is what it most likely means.
- One lookup per row (as a first draft of a display pass would do). Measured: 320 ms for 500 rows against
  17 ms for the batched pass (docs/PERFORMANCE.md).
- Plain strings for relations (titles joined with commas, like `query_rows`). Loses the link and is
  ambiguous for titles that contain commas; the block can link, `query_rows` is text for agents.

## Consequences
- The result shape changes for API clients: person cells are names (or null), relation cells are
  `QueryPageRef[]` instead of id strings. Only the web block reads this route in this repository; the
  wording is in docs/API.md (v0.10.0 additions).
- (Superseded by 1352: WHERE and SORT compare names and titles since 0.10.0.) `SORT Owner` still orders by user id and `WHERE Owner = "Priya Nair"` does not match; filters by name
  need the compiler to join names, which is a separate change.
- A renamed member or retitled row shows its new name after the route's cache entry expires (60 s) or the
  workspace version changes, like other cached query results.
- Rollup fields are computed per request elsewhere and are still empty in query blocks.

Tests: `apps/server/src/query/cellRefs.db.test.ts` (names, non-members, hidden / trashed / foreign links,
the viewer who may see a private row, LIST, expressions untouched, free page properties, statement count),
`apps/web/src/components/blocks/QueryResultView.test.ts` (links, LIST, empty cells).
