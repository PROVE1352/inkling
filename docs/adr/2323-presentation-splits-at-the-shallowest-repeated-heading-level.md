# 2323. Presentation mode splits at the shallowest heading level used twice, and long slides scroll

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 1843 split slides at "the highest heading level present". Reported from production: a 161-block page
with one H1 at the top (used as the document's title), 15 H2 sections and 12 H3s became two slides, the
cover and everything else. One H1 followed by H2 sections is a common shape (Markdown imports, notes that
repeat the title as a heading), and it always collapsed that way.

## Decision
- The split level L is the shallowest heading level that has two or more headings; every heading at L
  or above (level number ≤ L) starts a slide. One H1 + fifteen H2s: the cover, the H1 with its intro, and
  one slide per H2. Three H1s with H2s below: the H1s only, as before. No heading, a single heading, or
  one heading per level (one H1 and one H2): the highest level present, as before.
- Dividers, blank blocks at slide edges, the opening (cover) slide and skipping empty slides are
  unchanged. A heading followed directly by another split heading (an H1 right above the first H2) keeps
  a slide with only that heading; no slide is empty.
- A slide taller than the screen scrolls inside its box (it already had `overflow-y: auto`); ↑/↓ scroll
  it by a fifth of its height when it overflows (←/→, Space, PageUp/PageDown still change slides). No
  automatic shrinking and no further splitting.
- `lib/present.ts` `splitLevel` / `splitSlides` serve both the app and public links, so both change.

## Alternatives considered
- **Always split at H1 and H2**: a page made of H1 chapters with many H2s each would become dozens of
  slides (the reason 1843 rejected splitting at every level).
- **Treat a lone first H1 as the title and skip it**: covers only the H1 case; a page with one H2 above
  H3 sections has the same shape one level down, and the rule above handles both.
- **Shrink or split slides that overflow**: changes what the author wrote; scrolling keeps it readable.

## References
- apps/web/src/lib/present.ts, present.test.ts, components/Presentation.tsx
- Chrome check scratchpad w18-browser/int step 9 (public link, one H1 + five H2: 7 slides; the long slide scrolls)
- ADR 1843
