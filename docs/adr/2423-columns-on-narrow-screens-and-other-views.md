# 2423. Columns stack below 640 px and keep their layout in every other view

- Status: Accepted
- Date: 2026-11-11

## Context
A page with columns is also read on phones, in a side peek, on public links, in presentation mode,
printed to PDF, inside a page embed, in the version history and from the offline copy.

## Decision
- **Editor**: the group's node view watches its own width (ResizeObserver) and stacks the columns in
  order below 640 px (`COLUMNS_STACK_BELOW_PX`, class `nd-columns-stacked`), without handles. Measuring the
  group, not the window, also covers the side peek and narrow panes. No container query: layout
  containment would make the group the containing block of fixed elements inside it.
- **Gap**: 52 px before every column but the first: the side menu (+ and ⋮⋮, 48 px) of that column's
  blocks sits there, and the resize handle sits on the boundary, left of the menu, so the two never
  overlap.
- **Public links**: server HTML has `div.bn-block-column-list > div.bn-block-column[style=flex-grow]`;
  the sanitizer keeps `flex-grow` (a plain number) and the public CSS lays the columns out, stacking on
  screens up to 680 px, never on paper.
- **Presentation**: a group is one top-level block (`lib/present.ts`); a heading inside a column never
  splits slides; handles are hidden on slides.
- **PDF / print**: side by side as on screen (also when the editor had stacked them), no handles.
- **Page embed**: the viewer's schema has the nodes (ADR 1539), so the columns show inside the embed.
- **Version history**: preview and diff are Markdown text (plain notation), so they show the markers around
  the blocks (from the code path; not opened in a browser).
- **Offline copy**: the same editor and schema over the device copy's Yjs state (from the code path; not
  opened offline in a browser).
- **Heading folds**: a folded section hides its group; a jump to a block inside the group opens the fold.

## Alternatives considered
- **A media query on the window**: wrong in a side peek and on wide screens with narrow panes.
- **Hide columns in print**: a printout should look like the page.

## Consequences
- Browser check: w20-browser/columns (H1 phone, I1–I9 other views).
