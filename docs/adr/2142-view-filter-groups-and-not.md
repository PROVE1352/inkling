# 2142. View filters: OR groups and NOT, one evaluator, stored next to the flat list

- Status: Accepted
- Date: 2026-11-10

## Context
`query_rows` filters with AND, OR, NOT and parentheses; a view's filter (`viewConfig.filters`) was a flat
AND list of at most ten conditions, evaluated by the web and, for charts, by the server
(`matchesViewFilters`). Saved views must keep working without a migration, and 0.16 clients (cached PWAs)
keep reading and re-saving view configs.

## Decision
- **Shape** (`viewFilterSchema`, packages/shared/src/collectionFields.ts): `{ mode: 'and'|'or', items }`,
  an item is a condition `{ fieldId, op, value?, not? }` or a group `{ mode, not?, items: condition[] }`.
  One level of groups (a group holds conditions only), at most 10 items per level. Stored as
  `viewConfig.filter`.
- **Reading**: `viewFilterOf(config)` — `filter` when present, else the flat list read as an AND tree.
  Old views need nothing.
- **Saving**: `viewFilterPatch(tree)` — a plain AND list of plain conditions is saved as `filters` (and
  `filter` removed), anything with OR, NOT or a group as `filter` with `filters` emptied. A 0.16 client then
  applies the AND filters it understands, and shows an OR/NOT view unfiltered (more rows, never a wrong
  subset). A 0.16 client re-saving such a view spreads the config and keeps `filter`; filters it adds go to
  `filters`, which a 0.17 client ignores while `filter` is set (known issue).
- **One evaluator**: `matchesViewFilter(props, fields, tree)` serves the web views (table, board,
  calendar, gallery, timeline, list, inline views through `applyView`), the chart view's cache key and the
  server's chart aggregate, so an optimistic update and the server agree. Conditions on deleted fields are
  ignored; a group with no known condition is ignored; an empty tree matches everything. Timestamps
  compare by UTC day, IDs by number (ADR 2140).
- Form views have no row filter; they share the config schema only.

## Alternatives considered
- **Arbitrary nesting**: the UI and the 0.16 fallback get harder; one level covers "A and (B or C)".
- **Migrating `filters` into the tree**: needs a data migration and breaks 0.16 clients at once.
- **AND of both keys** (old `filters` and new `filter`): an old client's additions would apply, but the
  editor would have to show two filters for one view.
- **Server-side view filtering in SQL**: views filter loaded rows in the browser today; one evaluator in
  shared keeps the chart path and the web identical.

## References
- packages/shared/src/collectionFields.ts, packages/shared/src/charts.ts (`matchesViewFilters` wrapper),
  apps/server/src/charts/aggregate.ts, apps/web/src/lib/collection.ts, ViewSettings.tsx
- apps/server/src/collectionQuery/fields017.test.ts, apps/web/src/lib/collection.test.ts
- ADR 0934 (query_rows filter), 1602 (chart filters)
