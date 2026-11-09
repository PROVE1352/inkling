# 1602. One aggregate endpoint on the collection query's access path

- Status: Accepted
- Date: 2026-11-10

## Context
Charts need counts and sums per group: by select (option order), multi-select (a row in each of its
options), person (by name), date (day / ISO week / month), checkbox, relation (by title), text,
number or row title; measured as count or sum/avg/min/max of a number (or numeric rollup). The
same numbers serve chart blocks, chart views, agents (ADR 1606) and exports (ADR 1605).

## Decision
- `POST /api/workspaces/:id/charts/aggregate` with `ChartAggregateInput` (source, groupBy, series?,
  measure?, sort?, limit?, today?/tzOffsetMinutes? for query sources) → `ChartDataDTO` (axes with
  display names, ordered group keys, values, row count, omitted groups/series). A read:
  `bearerReadOnlyOk`, rate limit 240/min.
- Access as the collection query (ADR 0934): `requireMembership` on the path's workspace (range,
  two-step, guests refused), then `requireCollectionPage` (visibility, live page and workspace) of a
  collection in that workspace, and a view of that collection; anything else is 404 whether missing
  or hidden. A query source runs as the viewer through the query block's own path
  (`runWorkspaceQuery`, extracted from `routes/query.ts`).
- Rows: one statement, children of the collection, live, `visibleTo(viewer)`, selecting only the
  properties the chart needs (`jsonb_build_object`), inside a transaction with
  `statement_timeout = 3000` and `jit = off`. Relation cells are reduced to visible links and rollups
  computed by `resolveRelations` only when a relation or rollup is involved; person groups are member
  names (a non-member id counts as "no value" and is never sent, C-L11, ADR 1320/1352).
- View filters, keys and measuring are pure functions in `packages/shared/src/charts.ts`
  (`matchesViewFilters` moved there from the web so views and charts agree; `collectionKeys`,
  `queryCellKeys`, `aggregateItems`).
- Order: 'auto' keeps a natural order (options, dates, checkbox, numbers) and otherwise puts the
  largest group first; "no value" last; at most 100 groups (default 12 for pie-like kinds, 30
  otherwise) and 12 series; the rest are counted, not drawn.
- Cache per viewer + connection range + input + view filters, keyed by the workspace version, 60 s,
  200 entries (as the query route).

## Alternatives considered
- GROUP BY in SQL: multi-select, relations (visibility), rollups and the web's filter semantics would
  each need a SQL twin; measured cost of the JS pass is small (10,000 rows ≈ 26 ms cold).
- One endpoint per source (`/pages/:id/collection/aggregate`, `/workspaces/:id/query/aggregate`): two
  routes for one shape; the workspace path gives the query source its membership check.
- Aggregating on the client from GET /collection: query sources and agents could not use it, and a
  chart would download every row.

## Consequences
- 2,000 rows: 8.6–10.5 ms cold median; 10,000 rows: 26.3–26.5 ms (PERFORMANCE.md).
- Tests: `apps/server/src/charts/charts.db.test.ts` (grouping, measures, multi-select, months,
  series, member names only, view filters, relation titles only when visible, hidden / foreign /
  non-member / guest / wrong workspace / not a collection, read-only token, subtree range, query
  source and its columns, large collections).
