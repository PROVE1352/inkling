# 2145. A list view

- Status: Accepted
- Date: 2026-11-10

## Context
The evaluation listed the list view (Notion's compact one-line-per-row view) as missing. Views are rows
of `collection_views` with a TS-only `type` enum (no CHECK), as `chart` was in 0.13.

## Decision
- `viewTypeSchema` gains `list`; no migration. A list row shows the icon and title, then the shown
  properties (`columnOrder` / `hiddenFields`, the table's keys) as small inline values; sorts and the
  filter tree apply as in the table. With sub-items the list nests like the table (ADR 2144).
- A 0.16 client renders a list view as a table (its fallback branch).

## Alternatives considered
- **A table setting "compact"**: Notion and the evaluation treat the list as a view type of its own, and
  inline views (X2's block) pick a view by type.

## References
- apps/web/src/components/collection/ListView.tsx, ViewTabs.tsx, CollectionView.tsx
- ADR 1603 (chart view, same enum rule), 2144
