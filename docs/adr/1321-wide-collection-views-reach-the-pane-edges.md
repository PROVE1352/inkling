# 1321. Wide collection views reach the edges of the page pane

- Status: Accepted
- Date: 2026-11-09

## Context
A collection page was a centred `max-w-5xl` column (1024 px). The board and the table scroll sideways
inside their own box, so with four or more board columns the last one (Done in the demo roadmap) was cut
at the column's right edge while the pane had several hundred pixels of empty space to its right; the
same for a table with more than three or four fields. The page's own "Full width" setting
(`pages.full_width`) and the device's "Line width: Full" were ignored on collection pages, and the
"Full width" item in the page menu was only offered for documents.

Notion keeps the title and the view tabs in the page column but lets a board or table scroll from the
left edge of the page to the right edge, its content starting on the column's line, and its "Full width"
toggle widens the column itself.

## Decision
- The collection page follows the same width rule as documents: page "Full width" or device line width
  "Full" removes the column's max width (`max-w-none`, wider side padding); otherwise the column stays
  `max-w-5xl`. The page menu offers "Full width" for collections too.
- The board's and the table's horizontal scroll areas (`nd-wide-scroll`) bleed to the pane edges. The page
  wrapper is a CSS inline-size container (`@container`), the column is centred inside it, so
  `50cqw - 50%` is the distance from the column to the pane edge on each side; the scroll area takes it
  as negative margin and the same padding. Content starts on the column's left edge, scrolls under the
  right edge of the pane, and the scroll can reach the end with the same margin on the right.
- Timeline, calendar and gallery are unchanged: the timeline is a bordered box with its own scrollbars
  and sticky title column, calendar and gallery fit the column. All of them widen with "Full width".
- Print drops the bleed.

## Alternatives considered
- Always full width for board / table / timeline views. Changes the reading width of the title and the
  toolbar when switching tabs, and leaves no way back to a centred page.
- Measuring the pane in JavaScript (ResizeObserver) and setting pixel margins. Same result with a
  render after every resize; container units do it in CSS and follow the side panel opening and closing.
- `100vw` based bleed. Includes the sidebar and the scrollbar, so it overflows the pane.

## Consequences
- The bleed needs container query units (Chrome 105, Safari 16, Firefox 110), the same baseline as the
  `subgrid` the query block already uses.
- On a 375 px phone the board and the table scroll from screen edge to screen edge with a 16 px start
  inset; no page-level horizontal scroll (checked: `scrollWidth == clientWidth` at 375, 1280 and 1440 px).

Screenshots (before / after, 1440, 1280, 375 px, light and dark) were taken with Playwright against a
seeded server; the paths are in the wave report.
