# 1404. Users change shortcut keys in Settings; the keys are kept per device

- Status: Accepted (uses 1400)
- Date: 2026-11-09

## Context
Stage 1 (ADR 1400) put every key in one registry and made `currentKeys(id, platform)` the only lookup of
"which keys does this command have now", so that a remap would reach the dispatcher, the editor, the tree, the
help window, the menus and the palette without touching them. Stage 2 has to decide where a user's keys live,
what an override means for the defaults and their hidden aliases, and how screens that already rendered a key
label find out it changed.

The server has no general per-user preference store: `users` has `locale` and `sidebar_prefs` (ADR 1020), each a
column with its own schema and route. Per-device preferences (line width, zoom, sidebar width, folds, the palette's
recent list) live in localStorage (`lib/prefs.ts`, ADR 1350, 1221, 1402).

## Decision
- **Per device, in localStorage** under `inkling:shortcuts` (`lib/shortcuts/overrides.ts`), in the same form as
  the export file: `{ "app": "inkling", "kind": "shortcuts", "version": 1, "mac": { id: [spec…] }, "other": {…} }`.
  Reasons: keys are per platform anyway (a Mac's ⌘⌥Y means nothing on the Windows laptop), keyboards and layouts
  differ per device, and an account column would be a schema change for a convenience. A separate key rather than a
  field of `inkling:prefs`: the stored value is exactly the export file, and prefs' shallow merge of defaults has no
  meaning for a map of overrides. Settings shows the "This device" badge, as for other per-device settings.
- **Export / Import** (Settings › Shortcuts) move the keys between devices: Export downloads that JSON as
  `inkling-shortcuts.json`; Import replaces the current keys with a file's, after the checks of ADR 1405.
- **An override replaces a command's keys on one platform, hidden aliases included** (`extraKeys`, such as Ctrl+N
  for a new page in the installed app). `[]` means "no key". A command without a default key (the palette-only
  ones: *Today's daily note*, *New database*, …) may get one; the window dispatcher now walks every `via: 'app'`
  command, not only those with default keys. An override equal to the defaults is not stored.
- **The registry stays data only.** It holds the overrides as plain module state (`setKeyOverrides`); `currentKeys`,
  `boundKeys`, `keyLabels` and a new `effectiveDefs(platform)` (the registry with the overrides applied, for the
  conflict check) read it. `overrides.ts` loads from storage when `lib/shortcuts` is first imported, saves, and
  re-reads on the `storage` event, so a change in one tab reaches the other tabs of the app.
- **Live labels**: `useShortcutKeys()` (a version counter through `useSyncExternalStore`) re-renders what shows
  keys: the help list, Settings, the palette, `MenuShortcut`, the sidebar, the back/forward buttons and the page
  view's tooltips. The dispatcher, `matchCommand` (tree, table) and the editor (ADR 1406) read the keys at the time
  of the key press and need nothing.
- Stored entries are read leniently (`parseOverrides`): unknown ids, commands that cannot be remapped, specs that
  do not parse or break the rules of ADR 1405 are dropped, so a later release that removes a command does not break
  the store.

## Alternatives
- **Account-wide, on the server**: follows the person to every browser, but needs a `users.shortcut_prefs` column,
  a route and a migration, and still has to be split per platform. Export/import covers moving keys for now; the
  stored format is the same JSON a future column could hold.
- **Inside `inkling:prefs`**: one more field in a store whose fields are scalars and small objects merged over
  defaults; the overrides would have to be cut out again for the export.
- **Overrides that add keys instead of replacing them**: the old key would keep working, and the point of moving a
  key is usually to free the old one.

## Consequences
- A person who uses two browsers sets the keys twice or exports once.
- A later release can give a new default key to a command that collides with a key the user set. Nothing is
  rewritten silently: Settings shows a line listing the clashes until one of the two keys is changed.
- Tests: `remap.test.ts` (overrides in `currentKeys`/`boundKeys`/labels, aliases, palette-only commands, storage
  parsing, export/import), e2e `scratchpad/w11b/e2e.mjs` (new key works, old key released, reload, two tabs).
