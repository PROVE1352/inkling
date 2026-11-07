# 0850. Editor blocks no longer use `content-visibility: auto` (typed text was lost after Enter)

- Status: Accepted (supersedes the Chromium part of 0703)
- Date: 2026-11-07

## Context
Users reported that on a new page, right after the first sync, text typed after pressing Enter
partly disappeared. A strict Playwright repro (type `abcdef`, Enter, `ghijkl` with no key delay;
verdict = exact block texts live and after reload) showed:

| build | Chromium, 20 runs | WebKit |
|---|---|---|
| current (before fix) | 17/20 lost | 0/20 lost |
| pre-phase-2 copy (`inkling-mem`) | 17/20 lost | 0/10 lost |

So it is not a regression of the performance phase, and it is not a sync or server problem:
the characters were already missing in the DOM immediately after typing, and the persisted
state matched the live editor exactly. With a 60 ms delay between keys nothing was lost.

Mechanism (DOM trace): `index.css` gave top-level `.bn-block-outer` elements
`content-visibility: auto` in every engine except WebKit. A block inserted by Enter has not been
laid out yet when the next key arrives in the same frame (its contents are still skipped).
Chromium could not put the caret inside the new, still-skipped paragraph: the `beforeinput`
selection was `P.bn-inline-content@0`, but the text node was inserted directly under
`.bn-block-outer`, outside ProseMirror's content DOM. ProseMirror's DOM observer treated that as
foreign and reverted it, and no transaction was produced, so the characters vanished
(`["abcdef", "hijkl"]` or `["abcdef"]`). In a pre-filled document the same race could put text
into the wrong block (`"p" + "ghijkl3"`). Injecting `content-visibility: visible` alone took
Chromium to 0 losses. The window is one rendering frame. That frame is longest right after
opening a page (the initial sync render), which is why the report says "right after sync".

## Decision
Remove the `content-visibility: auto` / `contain-intrinsic-size` rules for editor blocks in all
engines, and the `html[data-engine=webkit]` marker in `main.tsx` that existed only to exclude
WebKit. Editor blocks are laid out normally everywhere.

Verification (an out-of-tree `repro-loss.mjs` script, 20 runs each, strict verdict, Chromium and
WebKit): empty page (`synced`), typing before sync (`early`), title, then Enter, then body
(`title`), Enter in the middle of text (`mid`), and Enter after a paragraph of a 300-block
document (`filled`). All 0/20 after the fix.

## Alternatives considered
- Exclude only the empty focused block (`:not(:has([data-is-empty-and-focused]))`). This covers
  the empty new paragraph but not non-empty blocks created by a split, paste or undo. It also
  depends on a BlockNote-internal attribute.
- A ProseMirror decoration that marks the block holding the selection, so CSS can exempt it.
  This is more general, but every new block is still skipped until the next frame, so any path
  that moves the caret into a block before its first frame (programmatic selection, IME
  composition start, remote insert followed by a keystroke) keeps the risk. The benefit it
  preserves is small (below).
- Turn on `content-visibility` only while the editor is not focused. The first click into a
  large document would then lay out every block at once (a visible hitch on every focus).

## Trade-offs
Opening a very large document in Chromium is slower again. ADR 0703 measured 320 ms with the
rule versus 455 ms without it on a 3,701-block document, and relayout after a width change also
loses the skip. WebKit already ran without the rule (1,065 ms open). Silent data loss outranks
a one-time 135 ms on huge pages. If large-document open time becomes a problem, virtualize in JS
(Notion style) rather than relying on CSS skipping inside a contenteditable.

## How others solve it
Editors that skip offscreen layout (Notion, Google Docs) virtualize in script and keep the block
being edited fully rendered. We did not find a contenteditable editor that uses
`content-visibility` on editable blocks.
