# 1400. One registry for keyboard shortcuts and commands

- Status: Accepted
- Date: 2026-11-09

## Context
Up to 0.10 the app's keys were handled in five components and labelled by hand in six more: a 140-line `keydown` effect in `AppLayout.tsx`
(⌘K, ⌘O, ⌘⇧F, ⌘P, ⌘N/⌘⌥N, ⌘⌥←/→, ⌘G, ⌘,, ⌘\, ⌘;, F2, ?, and the editor's ⌘L and ⌘D), the sidebar
tree's `onKeyDown` (arrows, Enter, Space, F2, Delete), `HeadingFolds.tsx` (⌘. and the ⌘F fold opener),
`InkLayer.tsx` (⌘Z), `Math.tsx` (⌘⇧E in a BlockNote extension), and the labels were written again by
hand in `ShortcutsModal.tsx`, `CommandPalette.tsx`, `Sidebar.tsx`, `NavButtons.tsx`, `Settings.tsx` and
`PageView.tsx` with `modKey()`/`combo()` helpers. Each handler had its own idea of ⌘ versus Ctrl (`HeadingFolds` took
either, `AppLayout` only the platform modifier), of IME composition (only ⌘. checked `isComposing`), and
of text fields (`?` and F2 checked, the rest did not). Adding user remapping (stage 2) or a searchable
palette on top of that would have meant touching every one of them.

## Decision
- **`apps/web/src/lib/shortcuts/registry.ts`** lists every command: `id`, `scope` (global, page, editor,
  tree, table, ink), default keys per platform (`{ mac, other }`, ProseMirror spelling such as
  `Mod-Shift-ArrowUp`), hidden aliases (`extraKeys`), the i18n label key, the text-field rule and who
  carries it out (`via`). It is data only — no React, no DOM, no `t()` — so the conflict and label tests
  run under node:test, and the app shell can import it without the editor.
- **One place for the rules** (`keys.ts`, `index.ts`): `Mod` is ⌘ on a Mac and Ctrl elsewhere, never
  both, and the other one must be up (Mac Ctrl+D, Windows Win+K stay the system's); modifiers match
  exactly (Ctrl+Alt+P is not ⌘P any more); letters match on an ASCII `e.key` first and on `e.code`
  when ⌥, a dead key or a Korean layout changed it; a keydown during IME composition (`isComposing`, or
  Safari's `keyCode` 229) never matches; on Windows a Ctrl+Alt key that produced a non-ASCII character
  (AltGr: Polish ń, German @) is typing, not a shortcut; bare keys (`?`, F2) do not run from a text
  field while combos (⌘K) do, per command overridable (`inInputs`); a key the editor or the tree already
  handled (`defaultPrevented`) is not taken again.
- **Who runs a command (`via`)**: `app` — one window `keydown` listener (`useShortcutDispatcher`, in
  `AppLayout`) runs the handler the owning component bound with `useCommand(id, run, enabled)`; the
  state stays where it was (dialogs in `AppLayout`/`appCommands.ts`, panel/favorite/pen in `PageView`,
  folds in `HeadingFolds`, strokes in `InkLayer`). `editor` — `editorKeys.ts` builds one BlockNote
  extension (`createExtension`, the public API of the pinned 0.51.4) whose keymap is generated from the
  registry, passed to both editors through `useCreateBlockNote({ extensions })`. `blocknote` — BlockNote
  binds the key itself (headings, lists, moving blocks, Tab, undo, marks); listed so the help window and
  the conflict test see them, run from the palette through the editor API. `tree` — the tree keeps its
  `onKeyDown` (it needs the selection) and asks `matchCommand(id, e)`. `browser` — table copy/paste,
  which are clipboard events; listed only.
- **Handlers are a stack per id** (`handlers.ts`): the latest mounted owner wins and an unmount uncovers
  the previous one; `enabled()` hides a command from the palette and lets its key fall through to the
  browser (a guest's ⌘K, ⌘; off a page).
- **`currentKeys(id, platform)`** is the only lookup of "which keys does this command have now". Today it
  returns the defaults; stage 2 reads the user's overrides there, and the dispatcher, the editor keymap
  (`boundKeys`), the help window, the menus and the palette follow without changes.
- Left in place on purpose: Esc closers of dialogs, menus and popovers (ConfirmDialog, Modal, EmojiPicker,
  HistoryModal, DayPopover, LinkPreview, SidebarMenuContext, PageTreeItem's context menu, the row
  template and collection menus, the table's selection, LocalGraph, PageView's ⋯ menu, ink's Esc), and
  submit keys inside one field (⌘Enter in the comment box, the day popover and the math field, Enter in
  the title). They are local dismiss/submit keys of one element, not commands.

## Alternatives
- **A shortcut library** (tinykeys, hotkeys-js, react-hotkeys-hook): a new dependency for ~200 lines, and
  none of them knows BlockNote's keymap, the IME rule or AltGr (ADR 0882).
- **Handlers in the registry itself**: would pull React state and the editor into a module the tests and
  the app shell import; the registry would stop being data.
- **Every editor key in our extension**, re-binding BlockNote's own: two keymaps for one key, and removing
  BlockNote's would mean patching the pinned editor.

## Consequences
- A new shortcut is one registry line plus a `useCommand` (or an `EDITOR_COMMANDS` entry); the tests fail
  if its key collides or its label is missing in Korean.
- Shift+arrow in the sidebar tree no longer moves the selection (modifiers match exactly now); it never
  was documented.
- The "Context menu: right-click" row left the shortcut list; it is not a key.
