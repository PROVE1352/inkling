# 1403. The ? window and menu items read their keys from the registry

- Status: Accepted (uses 1400)
- Date: 2026-11-09

## Context
The `?` window and Settings › Shortcuts rendered a hand-written list of 30 rows; the palette, the sidebar,
the back/forward buttons and the settings hints wrote their key labels again with `modKey()`/`combo()`.
When a key changed (or for Windows) one of the copies was easy to miss, and the menus that have a key
(pen mode, the tree's rename and delete) did not say so.

## Decision
- **The table is generated** (`shortcutGroups()` in `ShortcutsModal.tsx`): every registry command with a
  key, grouped by scope in a fixed order — global, page, editor, sidebar tree, database table, pen mode —
  with its labels from `keyLabels` (⌘⌥S on a Mac, Ctrl+Alt+S elsewhere) and typed forms such as `$…$`
  (`alsoTyped`). The same list is in Settings › Shortcuts.
- **Search box in the `?` window**, focused when it opens: keeps the rows where every word matches the
  English or Korean name, the hint, the key or the group name, with the palette's matcher (Korean initials
  work). Esc closes.
- **Menus**: `MenuShortcut` shows a command's primary key at the end of a menu item and `ariaKeys` fills
  `aria-keyshortcuts`. Used in the page ⋯ menu (pen mode; the right panel on phones), the tree's row menu
  (rename F2, delete ⌘⌫), the sidebar (search, graph, settings, the new-page menu), and tooltips
  (`withShortcut`: favorite star, right panel button, sidebar button, back/forward, new page). The tree's
  row menu does not show ⌘⌥S next to "Add to favorites": that key acts on the open page, the row menu on
  its row.
- The settings note "custom shortcuts are not supported yet" stays until stage 2.

## Consequences
- No key label in the UI is typed by hand any more, except local field hints ("⌘Enter to save" in the
  day popover and the math field) that are not registry commands.
- The `?` window is wider (two columns at 672 px) and scrolls inside, with the search box fixed on top.
