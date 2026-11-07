# 1104. Rendering only the visible part of the editor: investigated, not adopted

- Status: Rejected (investigation)
- Date: 2026-11-07

## Context
After ADRs 1040–1043 and 1100–1102 the server side of a 4.5 MB page is cheaper, but opening it in
the browser still builds every block: BlockNote 0.51.4 is a TipTap/ProseMirror editor bound to the
whole Yjs fragment through y-prosemirror. The question was whether the web editor could draw only
the blocks near the viewport.

## What was checked
- **BlockNote 0.51.4 has no virtualisation.** `BlockNoteView` renders one ProseMirror `EditorView`
  whose DOM is the whole document; every block is a NodeView. ProseMirror needs the DOM of the
  whole document for selection mapping (`posAtCoords`, `coordsAtPos`), IME composition, find, copy,
  drag handles and the side menu; y-prosemirror rebuilds the ProseMirror document from the whole
  fragment on every remote change. There is no hook to keep off-screen blocks out of the DOM, and a
  fork of the view layer would sit under the BlockNote/prosemirror pins (`pnpm check:pins`).
- **CSS `content-visibility: auto` on blocks** (the browser skips layout and paint of off-screen
  blocks while they stay in the DOM) was used before and removed: in Chromium a block inserted in
  the same frame had no layout yet, the caret could not be placed in it and keys typed right after
  Enter were dropped — silent data loss (ADR 0850; WebKit had it off already, ADR 0703).
- **Splitting the editor into several editors per section** loses cross-section selection,
  undo history, drag and drop and the one-document Yjs binding the collaboration protocol uses.
- **Measured cost of opening the page** (production web build, Chromium headless, copy of the 4.5 MB
  page): 1,277–1,431 ms until the blocks are in the DOM (2,011 blocks, 46.8k DOM
  nodes; docs/PERFORMANCE.md, Rejected / no effect, "Editor: draw only the blocks near the
  viewport"). That is first sync plus building the ProseMirror document and DOM for ≈ 2,000
  top-level blocks with 192 tables, paid once per open. Typing latency on the open page was not
  measured in this round.

## Decision
Do not render a partial editor. The remedy for a page this large is to split it (ADR 1103 tells
people, ADR 1043 tells agents); the server-side work per edit is bounded by ADRs 1042 and 1100–1102.

## Revisit when
BlockNote ships a viewport-aware view, or a ProseMirror version supports lazy NodeView rendering
without moving the selection model; then measure caret placement after Enter/paste/undo first
(the ADR 0850 reproduction script).

## References
- ADR 0703, ADR 0850 (content-visibility removed), apps/web/src/index.css (comment above the phone rules)
- apps/web/src/components/CollabEditor.tsx
- scripts/check-editor-pins.mjs
