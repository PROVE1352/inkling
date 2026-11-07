# 0302. Own fixed-height list windowing for table, gallery and timeline

- Status: Accepted
- Date: 2026-11-07

## Context
The table view rendered every row with interactive cells. At 10 000 rows the first paint took ~14 s
and scrolling ran at ~2 fps (measured in headless Chromium against the Vite dev server: frame p50
482 ms, p95 783 ms). New gallery and timeline views must handle the same sizes. No virtualization
library is installed and dependencies cannot be added in this phase.

## Decision
`useWindowedRows` (≈100 lines) renders only rows intersecting the viewport ± overscan with fixed row
heights and top/bottom spacer padding. The scroll container is the nearest ancestor that actually
scrolls vertically (an `overflow-x: auto` wrapper computes `overflow-y: auto` too, so it is skipped
unless its content overflows), or an explicit viewport (timeline). Windowing only activates above a
threshold (table: 150 rows) so small tables keep their current look (wrapping multi-select cells);
windowed table rows are a fixed 35 px with single-line cells. Gallery windows *lines of cards*
(column count from a ResizeObserver). On `beforeprint` all rows (cap 3 000) are rendered synchronously
(`flushSync`) so printing/PDF never shows a partial list.

Measured after the change (same setup, 10 000 rows): table first paint 2.4 s (includes the 4.4 MB API
response and dev-mode React), 26 rows in the DOM, scroll p50 50 ms/p95 100 ms under a synthetic
2 500 px-per-frame jump; gallery 39 cards in the DOM, scroll p50 16.7 ms; timeline 26 bars in the DOM,
switch 84–95 ms, scroll p50 16.7 ms/p95 18 ms.

## Alternatives considered
- **@tanstack/react-virtual / react-window**: robust variable-height support, but a new dependency.
- **CSS `content-visibility: auto`**: no JS, but React still creates 10 000 rows of components.
- **Server-side pagination**: breaks client-side filter/sort/rollup semantics of the existing views.

## Trade-offs
Fixed heights: very long multi-select values are clipped in windowed tables; board and calendar
views are not windowed.

## How others solve it
Notion and Airtable virtualize both axes with fixed row heights; most React data grids use
react-window/TanStack Virtual.

## Consequences
Printing a collection renders at most 3 000 rows.

## References
- apps/web/src/lib/useWindowedRows.ts:38
- apps/web/src/components/collection/TableView.tsx (`WINDOW_THRESHOLD`)
- apps/web/src/components/collection/GalleryView.tsx, TimelineView.tsx
