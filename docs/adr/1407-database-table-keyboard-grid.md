# 1407. The database table is a keyboard grid

- Status: Accepted (uses 1400, 1322, 1351)
- Date: 2026-11-09

## Context
The collection table (ADR 1322: sticky header strip above a horizontally scrolling body; ADR 1351: column widths)
could only be used with a mouse. Every cell was a button or several (the title cell had three), so Tab walked
through hundreds of stops; there were no arrow keys, no way to start or leave editing from the keyboard, and screen
readers saw a stack of buttons, not a table. Notion, Sheets and Airtable share one model: a focused cell, arrows
between cells, Enter to edit, Esc to stop.

## Decision
- **Keys are registry commands** (`scope: 'table'`, new `via: 'table'`): the table's `onKeyDown` asks
  `matchCommand(id, e)`, like the sidebar tree, so they appear in the `?` window and can be changed in Settings.

  | Key (Mac / others) | Command |
  |---|---|
  | ↑ ↓ ← → | move between cells |
  | Tab / ⇧Tab | next / previous cell, wrapping to the next row; at either end of the table Tab leaves it |
  | Home / End | first / last cell of the row |
  | ⇧↑ ⇧↓ ⇧← ⇧→ | extend the selection (for ⌘C / ⌘V and clearing) |
  | Enter or F2 | edit: what a click on the cell does — open the text field, open the select/person/relation list (the list takes the focus, ↑/↓ move in it), tick the checkbox, open the row page when the table is read-only |
  | Space | tick / untick a checkbox cell |
  | ⌫ (Mac) / Del (others), the other one as alias | clear the selected cells (rollups skipped, a checkbox becomes unticked, the title becomes empty) |
  | ⌘Enter / Ctrl+Enter | new row; its title opens for typing once the row arrives |
  | ⌘⇧Enter / Ctrl+Shift+Enter | open the row as a page |
  | ⌘C / ⌘V | unchanged: the clipboard events of the existing selection code (listed, not remappable) |

  While a text field is open: Enter saves and moves to the cell below (on the last row it adds a row), Tab/⇧Tab
  save and move sideways, Esc cancels and puts the focus back on the cell. Enter that ends a Korean syllable
  (`isComposing`) saves nothing and moves nowhere — the text cell and the title cell got that guard too.
  F2 shadows the page's F2 (rename title) while a cell has the focus.
- **Edit contract without lifting state**: cells keep their own `editing` state. A cell's opener carries
  `data-cell-edit` (Enter/F2 clicks it), its field `data-cell-input`, its pop-up `data-cell-popup`; the table's
  handler runs after the field's own (React bubbling), so "Enter saves" stays the field's job and the table only
  moves. An `InGridContext` takes the buttons inside cells out of the Tab order.
- **Accessibility**: `role="grid"` on the root that holds both strips (labelled with the view name,
  `aria-rowcount` = rows + header because of windowing, `aria-multiselectable`, `aria-readonly` when locked),
  `rowgroup`s for the header strip and the body, `row` with `aria-rowindex` (header 1, rows from 2), `columnheader`
  with `aria-colindex` and `aria-sort`, `gridcell` with `aria-colindex` and `aria-selected`. **Roving tabindex**: the
  focused cell (or the first rendered row's title) is the grid's only Tab stop.
- **Scrolling**: a moved focus calls `scrollIntoView({ block: 'nearest', inline: 'nearest' })`; cells have a
  `scroll-margin-top` of the header strip's height so a cell is never left under the sticky header, and `inline`
  scrolls the body's horizontal scroller. With more than 150 rows (windowed, ADR 0302) a target row that is not
  rendered is first scrolled to the middle of the pane; the focus follows once the window re-renders. A held arrow
  key counts from the requested cell, not from the one still focused, so no press is lost while rows render.
- **Without edit rights** (edit lock, view-only guests) only the moving keys and opening a row work; edit, clear,
  toggle and new row do nothing.

## Alternatives
- **Lift every cell's editing state into the table**: one source of truth, but a rewrite of every cell type and of
  the row page's property panel that shares them.
- **`aria-activedescendant` on one focusable container** instead of roving tabindex: the editors inside cells need
  real focus anyway, and windowed rows would point at unrendered ids.
- **Typing a character starts editing with it** (spreadsheets): not in this round; Enter/F2 first.

## Consequences
- Tab now stops once in the rows instead of on every button in them (the header keeps its sort buttons and resize handles); the row menu (⋯) and the "Open" button of the
  title cell are mouse-only, their actions are on the keyboard as ⌘⇧Enter (open) and the row page's own menu.
- The board, calendar, gallery and timeline views are unchanged.
- Verified with real key presses in Chromium (`scratchpad/w11b/e2e.mjs`): Tab into the grid, arrows, Home/End,
  Tab/⇧Tab, Enter → type → Enter saves and moves down, F2 → Esc cancels, Korean composition Enter, Space on a
  checkbox, ⌘C of a cell and of a ⇧-extended range, ⌫, Enter on a select → ↓ → Enter picks and returns focus,
  ⌘Enter new row with its title open, ⌘⇧Enter, 170 × ↓ through a 200-row windowed table with the cell below the
  sticky header, → at 375 px scrolling the table sideways.
