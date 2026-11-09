# 1402. Command palette lists the registry, searches both languages and Korean initials

- Status: Accepted (uses 1400)
- Date: 2026-11-09

## Context
The ⌘P palette (M10) was a hand-written list of 30 actions with their own labels and hand-written key
hints, matched by `label.includes(query)` in the current language only. Editor actions (headings, move,
duplicate) were not in it, a Korean UI could not be searched with an English word or the other way
round, and typing Korean initials (ㄱㄹㅍ for 그래프), the usual way to search in Korean apps, found
nothing. Nothing in the app did initial-consonant search before (the Hangul code in `mathRender.ts` and
the server's tokenizer only classify characters).

## Decision
- **Key stays ⌘P / Ctrl+P.** It already was the palette; Obsidian uses it; print stays reachable from
  the page ⋯ menu ("Export PDF"). ⌘⇧P was not needed and is Firefox's private window.
- **The list is the registry**: every command with `palette` not false whose handler is bound and enabled
  right now (`isAvailable`), so "Pen mode" shows only on an editable document and editor commands only
  while a body is mounted. Each row shows its key from `currentKeys`. Workspace switches, plugin
  commands and pages (by title, once something is typed) follow, as before. A command may carry a longer
  `paletteLabel` (the old palette wording, "Quick switcher (jump by title)"); both names are searchable.
- **Search** (`lib/shortcuts/search.ts`, pure): every word of the query must match one of the item's
  texts — its English and Korean names (read from both dictionaries, whatever the UI language) and its
  key label. A query character matches a text character when equal, or when it is a lone consonant and
  the text's syllable starts with it, so ㅅㅇㄷ, 사이ㄷ (half-typed) and 사이드 all find 사이드바. Ranking:
  a run at the start of a text, then at a word start, then anywhere, then the characters in order with
  gaps. Page titles use the same scorer. No fuzzy-search dependency (ADR 0882): ~80 lines.
- **Recent commands first**: on an empty query the last five commands run from the palette come first
  under "Recent"; with a query, a recent command wins a tie. The list is per device in localStorage
  (`inkling:palette-recent`), a convenience like the sidebar width; without storage it is simply empty.
- **Editor commands run on the caret**: the palette takes the focus, so before an editor command runs the
  body editor gets it back; ProseMirror kept the selection, so "Turn into heading 2" acts on the block the
  caret was in and typing continues there (checked with real keys).
- **Keyboard and screen readers**: the input is a `combobox` with `aria-controls` → `listbox`,
  `aria-activedescendant` → the selected `option` (`aria-selected`), sections are `group`s labelled by
  their heading. ↑/↓, PageUp/PageDown, Home/End (on an empty query or with ⌘/Ctrl), Enter, Esc; Enter
  while an IME composes ends the syllable instead of running. Mouse down on an option keeps the focus in
  the input.

## Alternatives
- **A second key (⌘⇧P) for a commands-only palette, ⌘P for files**: VS Code's split. Inkling already has
  ⌘O for titles and ⌘K for search; a third dialog would be one more thing to learn.
- **Search only the current language**: the reason this ADR exists — people switch the UI language and
  keep the words they know.
- **Account-synced recent list**: needs a column and a route for what is a convenience; per device is
  what the sidebar width and folds do (ADR 1350, 1221).

## Consequences
- The palette grows with the registry: a new command with a handler appears there with its key.
- "Open search" and "New document" are now "Search" and "New page" in the help window; the palette keeps
  the old longer names.
