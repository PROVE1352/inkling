# 2192. query_rows computes automatic values in SQL only for the fields a filter or sort reads

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 2140 serves automatic values (created / edited time and by, unique IDs) from the page's own
columns. `GET /pages/:id/collection/query` (MCP query_rows) read a collection that has any such field
through a derived table whose `props` was `props || jsonb_build_object(<every automatic value>)`, so
filters and sorts on them compile like stored values. That expression is evaluated for every row the
filter looks at, on every call, whether or not the call reads an automatic value. Measured at
integration (wave 16; `apps/server/scripts/collection017-bench.ts`, filter `Points > 500`, sort
`Points desc`, 25 rows): 2,000 rows 8.1 → 28.6 ms p50, 20,000 rows 27.6 → 200.7 ms p50 against the same
collection without automatic fields.

## Decision
- The derived table is used only when the filter or the sort names an automatic field
  (`autoFieldsRead`: the conditions of the filter tree and the sort keys; formula conditions are
  decided in memory, ADR 1826), and it builds only those fields.
- The rows a call returns (at most `limit`) get all their automatic values from a second statement
  in the same transaction that reads the page columns they come from for those rows only
  (`autoSourceSelectSql`, timestamps as the same ISO UTC text the SQL path writes; `fillAutoProps`),
  so the cells are the same on both paths. Selecting those columns in the sorted statement itself
  was measured and not kept: the timestamp formatting then ran for every row that passed the filter
  (20,000 rows: 39 ms p50 against 29 ms without automatic fields). The row version stays the hash of
  the stored props.

## Alternatives
- Keep one path (always the derived table): simpler, but a collection pays for its Created / ID
  columns on every query even when no one filters by them.
- Store the automatic values in props: rejected in ADR 2140 (every write would have to keep them in
  step, and "last edited by" moves with the change log).

## Consequences
- A query that filters or sorts on an automatic value still builds it for every row it scans (only
  that field). Numbers in docs/PERFORMANCE.md (integration rows).
- `md/int017.db.test.ts` checks that both paths give the same cells and versions.

## Files
- apps/server/src/routes/collectionQuery.ts (`rowSource`, `autoFieldsRead`)
- apps/server/src/collectionQuery/autoValues.ts (`autoSourceSelectSql`)
- apps/server/scripts/collection017-bench.ts
