# 1340. Ink layer: one layer per page, no save before the ink is loaded, no blind wipe

- Status: Accepted
- Date: 2026-11-09
- Builds on 0815 (412 merge) and 0854 (single in-flight save)

## Context
A user wrote on a large page in pen mode with a mouse (Chrome, macOS). The server then saw a dozen
`PUT /api/pages/:id/ink` (all 200, no 412) on that page and on another one, and both pages ended with
an empty stroke list. A headless run of the production build found these causes:

1. **Lost ink layers.** In `PageView`, `InkLayer` and `HeadingFolds` were siblings with the same
   `key={page.id}`. React's keyed diff keeps one fiber per key, so every time pen mode went off
   (Done, Esc, page change) the old `InkLayer` was dropped from the tree without being unmounted. Its
   SVG and toolbar stayed on screen, Done no longer closed them, and its effects (window keydown,
   `pagehide`, the debounce timer) stayed alive. A lost layer never renders again, so its stroke list
   is frozen. With pen mode "off" the SVG still covers the body (z-30, `touch-action: none`): every
   click on the text goes to the lost layer and ends in a PUT of its frozen list. On a page change
   the old page's layer stays over the new page, and strokes drawn there can disappear.
2. **Saving before the load.** `strokes` starts as `[]` and the base version as `undefined`. A
   stroke or eraser touch before `GET /ink` answered (slow network, big page, or a failed GET) sent a
   PUT without `expectedUpdatedAt`, which the server treats as last-write-wins. If the GET then
   arrived, it replaced the local strokes, so a stroke drawn right after turning pen mode on vanished.
3. Both together: pen mode turned on and off before the ink arrived leaves a lost layer with an empty
   list and no base. From then on every click on the body sends `PUT { strokes: [] }` without a
   version, and the page's ink is wiped with 200 responses. This is consistent with the production log (the mechanism is reproduced; that it was this user's exact path is not confirmed).
4. "Clear" emptied the page in one press.

## Decision
- `PageView`: the ink layer gets its own key namespace (`ink:<pageId>`), and pen mode is stored as
  the id of the page it was turned on for. On a page change it is off in the first render of the new
  page, so no layer mounts in passing. The other per-page siblings get their own prefixes too
  (`wc:`, `toc:`, `folds:` for WordCount, MiniToc and HeadingFolds), so no two siblings share a key.
- `InkLayer`: no save goes out until the ink is loaded (`canSaveInk`). Strokes drawn before the load
  are merged on top of the server's list (`mergeLoaded`) and the waiting save is sent from the load
  effect. A failed load shows a toast and is retried on the next stroke; until it succeeds nothing is
  saved. The 412 merge moved to `lib/inkSync.ts` unchanged (`mergeConflict`).
- Eraser: the stroke ref is updated at once (two moves in one frame both count), and lifting the
  eraser saves only when something was erased.
- Ctrl/Cmd+Z and Esc are ignored while focus is in a text field.
- "Clear" takes two presses ("Clear all?" for three seconds).
- Server: a PUT without `expectedUpdatedAt` that would replace non-empty ink with `[]` answers
  `412 INK_CONFLICT` with the current ink and writes nothing. Versioned clears and unversioned saves
  of non-empty lists behave as before.

## Not done (needs a schema change)
Keeping the previous stroke list for a short time (a `page_ink_history` table or a `prev_strokes`
column with its `updated_at`, kept for e.g. 24 h or the last 5 versions) would let an admin or the
user undo a bad save after the layer is gone. Proposed only.

## Consequences
- Strokes drawn while the ink cannot be loaded stay local and are lost when the layer closes; the
  toast says so. This is preferred over overwriting the server copy.
- Service-worker-cached old bundles still have causes 1 and 2 until they update; the server guard
  stops only their empty-list wipes. A non-empty blind save (cause 2) can still replace strokes.
- Tests: `lib/inkSync.test.ts` (merges, save gate, PageView key), `inkGuard.db.test.ts` (server).
