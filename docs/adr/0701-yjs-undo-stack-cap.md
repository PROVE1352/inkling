# 0701. Cap the Yjs undo history at 500 captures

- Status: Accepted
- Date: 2026-11-07

## Context
With collaboration enabled BlockNote uses y-prosemirror's `yUndoPlugin`. Its `Y.UndoManager`
(captureTimeout 500 ms) pushes one stack item per typing burst and never drops any for the life of
the editor; every struct deleted by a captured change is marked `keep`, exempting it from Yjs GC.
ProseMirror's own history defaults to a depth of 100.

Measured (headless Chromium, JS heap after forced GC): clearing a 241-item stack freed 0.17 MB
(≈0.7 KB per item). 5 000 programmatic captures (`stopCapturing()` between edits):
before +3.88 MB heap, stack 4 997 items; after +1.52 MB, stack ≤ 550 items (the rest of the growth is
the document content itself). Undo of the most recent captures still works after trims.

## Decision
`lib/undoCap.ts` reads the UndoManager from the editor's plugin state (key `y-undo$`, no
node_modules patch) and listens to `stack-item-added`. When the stack exceeds 550 it drops the
oldest items down to 500, exactly like `UndoManager.clear()` does for each dropped item: the item is
removed from `undoStack` (in place — y-prosemirror and BlockNote's ForkYDoc read the array) and the
structs it deleted are un-kept inside one transaction (origin not tracked by the UndoManager).

## Alternatives considered
- pnpm patch of y-prosemirror/yjs: changes the lockfile (not allowed in this phase).
- Shorter capture window or larger captureTimeout: changes undo granularity, not the bound.
- A custom UndoManager passed to `yUndoPlugin({ undoManager })`: BlockNote creates the plugin
  internally without that option.

## Trade-offs
Undo depth is bounded: after a long session the oldest edits cannot be undone (500 bursts is far
beyond what users step back through; version history covers the rest). Un-keeping only lets a later
deletion of a parent GC the subtree; Yjs does not revisit already-deleted structs.

## How others solve it
ProseMirror history `depth` (100), CodeMirror `minDepth` (100), Google Docs relies on version
history for long ranges.

## Consequences
Undo memory per editor is bounded (~0.35 MB) instead of growing with session length.

## References
- apps/web/src/lib/undoCap.ts:60 (`trimUndoStack`), :89 (`capUndoHistory`)
- apps/web/src/components/CollabEditor.tsx:228
- y-prosemirror src/plugins/undo-plugin.js:68, yjs src/utils/UndoManager.js:255 (keepItem)
- apps/web/src/lib/perf.test.ts (trim keeps newest, undo works, deleted structs un-kept)
