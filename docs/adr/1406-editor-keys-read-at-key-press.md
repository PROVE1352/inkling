# 1406. Editor commands read their keys at each key press; the editor's own keys stay fixed

- Status: Accepted (uses 1400, 1404)
- Date: 2026-11-09

## Context
Stage 1 gave the editor its commands (⌘L, ⌘Enter, ⌘⇧D, ⌘D, ⌘., ⌘⇧E) as one BlockNote extension with
`keyboardShortcuts` built from `boundKeys`. BlockNote 0.51.4 turns that map into a prosemirror-keymap plugin when
the editor is created (`ExtensionManager.getProsemirrorPluginsFromExtension` → `keymap(…)`), and prosemirror-keymap
normalizes the key names once, so a key changed in Settings would only reach editors opened afterwards. The editor
is created per page and per row body; an open page would keep the old key until it is opened again.

Separately, many editor keys are bound by BlockNote itself (bold, italic, underline, strike, code, headings, lists,
moving blocks, indent, undo/redo — `via: 'blocknote'`).

## Decision
- **The extension listens instead of mapping.** `inklingShortcuts()` uses the extension's `mount({ dom, signal })`
  hook (public API of the pinned BlockNote) to add one `keydown` listener on the editor's element (ProseMirror's
  `view.dom`) in the **capture** phase. On each key press it finds the `via: 'editor'` command whose `boundKeys`
  match (`matchKey`: IME, AltGr and the ⌘/Ctrl rule as everywhere else) and runs it on that editor. If the command
  did something, the event is prevented and stopped with `stopImmediatePropagation()`, which keeps ProseMirror's own
  listener on the same element from seeing it — the same as a keymap returning true. If the command did nothing
  (⌘Enter outside a to-do), the event goes on to ProseMirror and the app. Keys from a field inside the document (the
  math input) are left to that field. The listener goes away with the editor (`signal`).
- No new dependency and no patch: a ProseMirror plugin with `handleKeyDown` would need `prosemirror-state`, which
  the web app does not depend on directly (ADR 0882).
- **BlockNote's own keys cannot be changed in 0.11.** Rebinding ⌘B would leave BlockNote's binding in place (two
  keys for bold), and releasing it would mean patching the pinned editor or swallowing the default key in our
  listener and calling the command ourselves for each of BlockNote's ~25 bindings — a second copy of its keymap to
  keep in step with every upgrade. Settings lists them as **Built in**, and the conflict check (ADR 1405) keeps other
  commands off their keys. The palette still runs them through the editor API.

## Alternatives
- **Rebuild the editor when a key changes**: loses the selection, the undo history and the collaboration cursor of
  an open page for a settings change.
- **Apply on the next page open** (the fallback the brief allowed): works, but the editor would disagree with the
  `?` window and the palette until then, and the row body editors inside an open database would keep the old key.
- **A keymap with every possible spec** registered up front: not finite.

## Consequences
- Our editor commands now run before BlockNote's keymaps for the same key; ADR 1405 keeps the two sets apart, so
  this only matters for keys neither list knows.
- Verified with real key presses: `scratchpad/w11b/e2e.mjs` changes *Duplicate block* to ⌘⌥Y in Settings while a
  page is open in another tab — ⌘⇧D then does nothing in that editor and ⌘⌥Y duplicates, without a reload; stage 1's
  e2e (46 checks, ⌘L during Korean composition included) and `scripts/editor-typing` (all scenarios, Chromium and
  WebKit) pass on the listener.
