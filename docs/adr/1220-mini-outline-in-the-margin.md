# 1220. Outline in the right margin (mini table of contents)

- Status: Accepted
- Date: 2026-11-08

## Context
Body text matched Notion's numbers (16/24 px, 700 px column), but a long page still read worse: the only outline
was inside the right panel, which takes width and has to be opened. Notion shows short lines in the right margin,
one per heading, that open into a list on hover. Large pages (thousands of blocks) must not get slower to scroll
or type in.

## Decision
- `components/MiniToc.tsx`, rendered by PageView next to the word count, outside the scroll container (so print
  ignores it). Shown for documents with at least 3 headings, when the space between the end of the text and the
  container's right edge is at least 104 px (rail plus the comment badges), at ≥ 768 px, not on phones, and when
  the per-device pref `miniToc` is on (default on; Settings → Editor, "This device").
- Geometry from Notion (measured 2026-11-08 on a public page): 2 px bars 16 px wide (top level) or 12 px with a
  4 px indent, 12 px apart, ≤ 28 bars (a window around the current heading on longer outlines); the panel is
  240 px, 13 px text, line-height 1.3, two-line clamp, current heading in the accent colour.
- Headings come from `computeOutline` (ADR 0705 per-block cache) 300 ms after edits stop. Heading offsets are
  measured once per outline change and again only when the editor's height changes (ResizeObserver) or folds
  change (`inkling:folds` event); scrolling reads `scrollTop` once per animation frame and binary-searches the
  offsets. The current heading is the last one above min(120 px, a quarter of the view); at the bottom it is the
  last heading.
- Opens on hover and on keyboard focus (the rail is a button); Escape closes. A click opens a fold hiding the
  target (ADR 1221), then scrolls (smooth unless reduced motion).
- Bars change colour without a transition: with a 200 ms colour transition the 2,000-block page scrolled with
  p95 frame 34 ms instead of 18 ms (PERFORMANCE.md, rejected).

## Alternatives
- IntersectionObserver on headings: no per-frame work at all, but headings skipped between two observations
  fire nothing, so a fast scroll leaves the wrong heading active unless every callback re-reads all boxes. The
  offset table costs one `scrollTop` read per frame and stays correct.
- Showing it inside the right panel only (as before): kept as is; the margin outline is for reading without
  opening the panel.

## Consequences
- On a narrow window or with the right panel open the outline hides itself; the panel's outline remains.
- Headings nested in other blocks are listed (as in the right panel) even though they do not fold.
