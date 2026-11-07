# 0709. Board columns render incrementally; windowed table cells get a full-value tooltip

- Status: Accepted
- Date: 2026-11-07

## Context
0302 windowed table, gallery and timeline, but not board and calendar. Measured on a 10 000-row
collection (production build, headless Chromium; switching views, long tasks via PerformanceObserver):
| view | DOM nodes | long tasks on open | long tasks while scrolling |
|---|---|---|---|
| table (0302) | 1 531 | 0 ms | 0 ms |
| calendar | 1 272 | 0 ms | 0 ms (already caps 3 cards/day + "+N") |
| board, before | 50 929 | 5 682 ms | 645 ms |
| board, after | 1 682 | 0 ms | 0 ms |
Windowed table rows are one line high, so multi-select chips and long text are clipped with no way
to read them without opening the cell.

## Decision
- Board: each column renders its first 50 cards and a "Show N more" button that adds 50 at a time.
  Cards have variable heights (title + up to two properties), so fixed-height windowing does not fit;
  dnd-kit sorting keeps working because the rendered cards are a prefix of the column order.
- Calendar: no change (not needed at 10 000 rows).
- Windowed table cells (`fixed`) carry `title=` with the value as text (`formatValue`), so clipped
  values are readable on hover. Relation cells have no tooltip (titles live in `refs`).

## Alternatives considered
- Variable-height virtualization per column: needs measuring cards; no virtualization library.
- Fixed card height + `useWindowedRows`: clips card properties.

## Trade-offs
Cards beyond the first 50 of a column are not reachable by drag targets until shown; printing a
board prints the rendered cards only.

## How others solve it
Notion boards load groups in pages with "Load more"; Trello renders all cards (small boards).

## Consequences
None beyond the above.

## References
- apps/web/src/components/collection/BoardView.tsx (`BOARD_PAGE`, `ColumnView`)
- apps/web/src/components/collection/TableView.tsx (cell `title`), apps/web/src/lib/collection.ts:34 (`formatValue`)
- apps/web/src/components/collection/strings.ts (`boardShowMore`)
