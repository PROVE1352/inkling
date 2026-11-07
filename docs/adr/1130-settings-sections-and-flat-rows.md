# 1130. Personal settings: section list, flat rows, "This device" tags

- Status: Accepted
- Date: 2026-11-07

## Context
The personal settings screen (`/w/:wsId/settings`) had grown to thirteen groups on one long page
(account, two-step verification, notifications, iCal, sidebar, deleted workspaces, editor, files & links,
trash, appearance, MCP, the full shortcut table, version) with nothing to jump between them. Each group
was a small grey heading over a bordered box, so the page read as a stack of cards. One sentence in the
middle ("the settings below are saved on this device only") was the only hint of which settings live on
the account and which in the browser. Controls had uneven widths (each select sized to its current label),
the line-width row packed slider, value, a "Full" button and a "Reset" link together, accounts that sign in
through a delegated service still saw three password fields they could not use, and the shortcut table
duplicated the `?` modal's markup.

## Decision
- **Sections, like Obsidian.** A list on the left (Account, Security, Notifications, Editor, Sidebar,
  Files & links, Appearance, Connections, Keyboard shortcuts, About) and the chosen section on the right.
  The section is the URL hash (`#sidebar`), so the existing "Customize sidebar…" links and the palette
  command open it without changes. Desktop list clicks replace the history entry; on a phone (< 640px,
  Tailwind `sm`) the list is its own screen, a section is pushed over it, and the header's
  single back button becomes "← All settings" with the section name as the title (pops when it came from
  the list, otherwise replaces). There is no second back button in the body; the installed app shows this
  one too, since it is the only way back to the list. ↑/↓/Home/End move between list items. On a phone
  focus moves to the section heading on open and back to the list item on return.
- **Flat rows.** `SettingsRows` gets a `SettingsFlat` context. Inside it `Group` drops the box for thin
  dividers flush with a single large section heading (group headings are omitted when the section heading
  already names them). Section components (notifications, two-step verification, sidebar, iCal, deleted
  workspaces) keep their logic and render `Group` as before; the workspace settings screen, which does not
  use the context, keeps the boxed look.
- **Where a setting is saved** is shown per row: preferences from `lib/prefs` (localStorage) carry a small
  "This device" tag. The mid-page sentence is gone. Trash's one row (confirm before deleting) moved into
  Files & links, like Obsidian.
- **Controls.** All settings selects share one minimum width (`SELECT_CLASS`, also used by the language
  select). Range rows are slider + value + a small reset icon (hidden at the default); "Full" width became
  its own toggle row; the zoom −/+ buttons went (the slider takes arrow keys). On a phone a slider row puts
  the control under the text.
- **Delegated accounts** see one line saying the password is changed with that service, not a disabled form.
- **Shortcuts** render the modal's `ShortcutList` with a search box (filters by label, hint, keys or group).
- **Sidebar menu ↑/↓** show on row hover or keyboard focus (opacity only, so they stay in the tab order and
  the focus-restore after a move still works); always visible on coarse pointers.
- **About** holds the version line, the user guide (GitHub, Korean or English by UI language) and the repository.

## Alternatives
- Query parameter (`?tab=`, as workspace settings does): would have needed both existing `#sidebar` links
  changed; the hash already worked.
- Keeping one long page with a sticky table of contents: still a long scroll on phones, and does not fix
  the boxed look.
- A per-section "saved on this device" line instead of per-row tags: Appearance mixes an account setting
  (language) with device ones (theme, zoom), so a section line would be wrong for one of them.

## Consequences
- Links into a section are `/w/:wsId/settings#<section>`; unknown hashes fall back to Account (desktop) or
  the list (phone).
- The repository and guide links are the upstream GitHub URLs; a fork would point at upstream.
