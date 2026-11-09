# 1322. Collection table: header sticks to the page, columns sized from their minimums

- Status: Accepted
- Date: 2026-11-09

## Context
Two problems in the collection table view, both reproduced in a browser:

1. One long text value made every column as wide as that value on one line. The grid tracks were
   `minmax(200px, 1.6fr) minmax(150px, 1fr) …` inside a `min-width: max-content` box. Under a max-content
   constraint each `1fr` grows until every track fits its widest item, and all `1fr` tracks are equal, so
   a 210-character text cell made the title column 2,129 px and every field column 1,331 px.
2. The header scrolled away with the rows. In a 2,000-row table, after 1,500 px of page scroll the header
   was at y = -1,268. It could not be `position: sticky`: it sat inside the table's horizontal scroller,
   and an element with `overflow-x: auto` is the sticky container of everything inside it, but never
   scrolls vertically.

## Decision
- The grid's minimum width is the sum of the track minimums (title 240 px, fields 150 px, the "+" column
  44 px) instead of its max-content width. In a pane wider than that the `fr` tracks share the rest; in a
  narrower one the table scrolls sideways. Cells clip: text cells already truncate with an ellipsis and
  now carry the whole value as a tooltip (windowed rows already had one).
- The header is its own strip above the rows' scroller: `position: sticky; top: 0` in the page scroller,
  `overflow-x: hidden`, an opaque background, and the same grid. The rows' scroller copies its
  `scrollLeft` to the header on scroll; a sideways wheel or trackpad swipe over the header scrolls the
  rows. Both strips get the same bleed (docs/adr/1321-*).

## Alternatives considered
- Let the table scroll vertically inside a fixed-height box (the timeline does). The header would stick
  natively, but a full-page table with its own scrollbar inside the page scroller is two scrollbars on
  one screen.
- Keep the header in the scroller and move it down with `transform` on page scroll. Runs on every scroll
  event and lags a frame behind compositor scrolling; the split strip uses native sticky and runs script
  only on horizontal scroll.
- Fixed column widths with drag-to-resize stored in the view config (Notion). The view config has no
  widths today; resizing is a feature of its own and is not part of this fix.

## Consequences
- Columns no longer grow to fit their content; a long title or text value is cut with an ellipsis and
  shown in full on hover or when the cell is opened.
- Header and rows are two elements; anything that measures "the table" by its scroller (selection,
  clipboard) uses the outer root, which still contains both.
