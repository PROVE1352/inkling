# 1603. A "chart" collection view, configured in the view config

- Status: Accepted
- Date: 2026-11-10

## Context
Next to table, board, calendar, gallery and timeline, a collection should show itself as a chart,
with the view's own filters choosing the rows.

## Decision
- `viewTypeSchema` gains `chart`; `viewConfigSchema` gains `chart: ChartSettings` (the block config
  without a source: the view is the source). Like `columnWidths` in 0.10 (ADR 1351) it is JSON in
  `collection_views.config`.
- `collection_views.type` is a TypeScript-only enum in Drizzle (no CHECK in the database):
  `pnpm db:generate` reports no change, so there is no v013 migration.
- `createViewSchema` takes an optional `config` (additive) so a view can be created with its settings
  in one request (used by create_view, ADR 1606).
- The web `ChartView` asks the aggregate with `viewId` (the server applies the saved filters); the
  cache key carries the filters so a filter change draws again at once. The filter menu is the same
  as other views'. Read-only collections show the chart without the edit button.

## Alternatives considered
- A `chart_settings` table or column: a migration for data that belongs to the view.
- Filters applied on the client to the rows the view already holds: the block and agents could not
  share the server's numbers.

## Consequences
- 0.12 clients do not know the view type (the tab falls back to a table render of an unknown type).
- Test: `charts.db.test.ts` (chart view created with config, its filters choose the rows).
