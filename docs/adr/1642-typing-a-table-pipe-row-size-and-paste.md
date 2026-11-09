# 1642. Typing a table: a pipe row and Enter, "/table 3x4", pasted Markdown

- Status: Accepted
- Date: 2026-11-10

## Context
BlockNote 0.51.4 has input rules for headings, lists, to-dos, quotes, code and the divider (`---`), none
for tables. A table came only from "/table", always 3 × 2 without a header, then resized with the handles.
The editor (BlockNote 0.51.4, prosemirror-view 1.42.4) is pinned and not patched for this (ADR 0882).

## Decision
- **Pipe row + Enter.** A BlockNote extension (`lib/tableQuickInput.ts`) listens for keydown on the editor
  element in the capture phase, like the shortcut extension of ADR 1406. Enter turns the caret's paragraph
  into a table when all of these hold: plain Enter (no modifier), no IME composition (`isComposing` or
  keyCode 229: the Enter that commits Korean input is left alone), the paragraph's whole text is one row
  that starts and ends with an unescaped pipe and has at least two cells (`parsePipeRow`, `lib/tableInput.ts`),
  the caret is collapsed at the end, the paragraph has only plain text (no inline code, link or mention),
  and no suggestion menu is open. Code blocks are not paragraphs, so they never convert. `\|` is a pipe in
  a cell; a separator row alone (`|---|---|`) is not a header.
  The result is a table whose first row is a header row (BlockNote `headerRows: 1`, rendered as `th`),
  plus one empty row, with the caret in the first cell of the empty row.
- **One ⌘Z.** y-prosemirror merges changes made within 500 ms into one undo step, so a fast typist's last
  keys and the conversion would be undone together. The extension ends the capture before and after the
  conversion (`stopUndoCapture`, `lib/undoCap.ts`): one ⌘Z gives the typed row back, the next one undoes
  the typing.
- **"/표 3x4", "/table 3*4", "/테이블 3×4".** The slash menu filters by title and alias, so a fixed alias
  cannot match a size. `tableSizeSlashItems` (`components/tableSlash.tsx`) adds one item when the query is
  a table word and a size (columns × rows, at most 20 × 50), with the query itself as its alias. While
  only the columns are typed ("/표 3") the item is already there as "Table 3×…", because BlockNote closes
  the menu after three characters without results; picked then, it inserts 3 rows. No header row (the same
  as "/table"). Plain "/표" stays BlockNote's item.
- **Paste.** BlockNote's default paste already reads `text/plain` as Markdown (`plainTextAsMarkdown`), and
  its Markdown detection includes GFM tables; a pasted `| a | b |` / `|---|---|` / `| 1 | 2 |` becomes a table
  with a header row in both Chromium and WebKit. No paste code was added; the editor check below keeps
  that true for the pinned version.
- **Palette.** "Insert table" (`editor.insertTable`) is a registry command without a default key: a 3 × 3
  table at the caret.

## Alternatives considered
- A ProseMirror input rule on `|` + Enter. Input rules fire on text input, not on Enter, and BlockNote's
  input rule API replaces the matched text in place, without a way to set the header row and place the
  caret in the second row.
- Convert on the closing pipe as soon as it is typed (like `---`). A row is often typed cell by cell; the
  table would appear after the first two cells.
- Ask for the size in a dialog after "/table". One more step for the case the typed size already covers.

## Consequences
- A paragraph that happens to be one pipe row turns into a table on Enter; ⌘Z right away brings it back,
  and Shift+Enter (a line break) never converts.
- Markdown written by agents is unchanged: the server converter (`apps/server/src/md`) already reads and
  writes GFM tables. A table without a header row (from "/table") is written with its first row as the
  Markdown header, as before.

Tests: `apps/web/src/lib/tableInput.test.ts` (row parsing, escapes, sizes, the IME guard),
`apps/web/src/lib/shortcuts/registry.test.ts` (the palette command). Editor typing check
(`scripts/editor-typing/run.mjs`): `table-pipe`, `table-pipe-no`, `table-slash-size`, `table-paste`, 10 runs each
in Chromium and WebKit, and the stored document equals the live one after a reload.
