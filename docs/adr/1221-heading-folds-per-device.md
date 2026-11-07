# 1221. Folding at headings, per device, without touching the document

- Status: Accepted
- Date: 2026-11-08

## Context
Obsidian folds a note at its headings; people asked for the same while reading long pages. Inkling documents are
collaborative (Yjs); a fold is a reading preference and must not change the shared document or other readers'
view. ADR 0850 showed that a caret inside a block whose layout is skipped (`content-visibility: auto`) drops typed
characters in Chromium, so hidden blocks are a known hazard.

## Decision
- **What folds**: a top-level heading (direct child of the root block group) hides the top-level blocks after it
  up to the next heading of the same or a higher level, plus its own nested children. Headings nested in other
  blocks do not fold. Pure function `foldLayout` in `lib/headingFolds.ts`.
- **State**: folded heading ids per page in this device's localStorage (`inkling:folds`, at most 300 pages,
  least recently changed dropped, key removed when empty). Ids of deleted headings are ignored.
- **Hiding without touching editor DOM**: `components/HeadingFolds.tsx` writes one `<style>` element in
  `<head>` with `display: none` rules keyed by `data-id`, wrapped in `@media screen` (printing shows everything).
  Attributes or classes on `.bn-block-outer` were not used: ProseMirror's DOM observer reads an attribute
  mutation on a node view as a possible DOM change and re-parses the block, and a re-parse of custom blocks that
  does not round-trip exactly would become a document transaction. No ProseMirror plugin either: decorations need
  `prosemirror-view`, which the web app does not depend on directly (ADR 0882).
- **Caret safety** (ADR 0850): the hidden list is recomputed synchronously in the editor's change and selection
  events. A block created after the last computation is not in the list; when the selection reaches a hidden
  block, the children of a folded heading, or a range over hidden blocks (select all), that fold opens in the
  same event, before the next key is handled. Verified in headless Chromium (30 of 30 runs) and WebKit: Enter
  at the end of a folded heading then `abcdef⏎ghijkl` with no key delay keeps both lines and opens the fold;
  Backspace at the start of the next heading and a shift-click range over a fold open it before the edit.
- **Jumps open folds**: `revealBlock(id)` is called before scrolling from `?block=`, the right-panel outline,
  comment badges and the margin outline (ADR 1220). ⌘F / Ctrl+F opens every fold of the page (browser find cannot
  see `display: none` text). Pen mode shows everything (ink is drawn over the full layout) without forgetting.
- **Arrow**: on hover (fine pointers only) a ▸ sits 22 px left of the heading text; the block handles of a
  heading move 22 px further left (`translate` on the floating wrapper that holds
  `.bn-side-menu[data-block-type=heading]`; moving only the menu left the wrapper on top of the arrow). Folded headings
  keep their arrow. Arrows are overlays in the scroll container like comment badges; the hover probe is one
  `elementFromPoint` per animation frame while the mouse moves.

## Alternatives
- BlockNote toggle headings (`isToggleable`): stored in the document (every reader gets them) and fold only
  nested children, not the following blocks.
- `hidden="until-found"` (browser find opens the section by itself): needs the attribute on editor DOM (above),
  and it hides with `content-visibility`, the property removed in ADR 0850.
- A per-account or per-page shared setting: folding is how one person reads, like scroll position.

## Consequences
- Browser find opens all folds of the page rather than only the one with the match.
- Folding on phones is not offered (no hover); folds made on a desktop are not synced to other devices.
- Unfolding a large section costs one layout of the revealed blocks (2,000-block page, ~100 blocks per section:
  28–59 ms from click to the next frame, PERFORMANCE.md).
