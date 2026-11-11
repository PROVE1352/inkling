# 2421. Column edits never tidy a group by themselves

- Status: Accepted
- Date: 2026-11-11

## Context
@blocknote/core's `fixColumnList` runs whenever a block inside a column is replaced or removed through
`replaceBlocks`/`removeBlocks` (side-menu Delete, ⌘⇧↑/↓ moves, link pastes, slash inserts that replace the
line, the table quick input) and from its Backspace/Delete handlers at a column edge. It deletes every
column whose only block is an empty line and dissolves a group left with one column. A fresh `/2단`
group lost its empty second column the first time anything replaced a line in the first one. It also
throws below two columns, which `column+` (ADR 2420) allows.

## Decision
- **Commands** (web `lib/columns.ts`) are single ProseMirror transactions, one undo step each:
  `/2단`·`/3단` (an empty line becomes the group, otherwise it goes below the caret's top-level block;
  caret in the first column; refused inside a column), add column (at most 4, caret in it), delete this
  column (its blocks go to the end of the column on its left, the first column's to the start of the next
  one; an empty column moves nothing; a group left with one column is unwrapped), unwrap (all blocks in
  order, empty placeholder lines dropped), widths.
- **replaceBlocks/removeBlocks**: the editor instance's two methods are wrapped once
  (`columnSafeBlockEdits`, from the columns extension): when a target block is inside a column the
  replacement is done here — new blocks where the first removed one was, removed blocks deleted, a
  column that would be left empty keeps an empty line. Other calls go to BlockNote unchanged.
- **Keys** (a BlockNote extension, ahead of core's shortcuts):
  - Backspace at the start of a column's first line: if every column is empty the group goes;
    otherwise the caret moves to the end of the column on the left (or the block above the group).
  - Delete at the end of a column's last line: the same rule mirrored; Delete at the end of the line
    just before a group moves the caret into it.
  - Non-paragraph lines first become paragraphs (core), Enter/Tab/Shift+Tab/arrows are core's.
- **Widths**: dragging the boundary between two columns moves only those two, in whole percent, each at
  least 15% of the group (`resizePair`); the widths are written on release as weights (`pctToWeights`).
  Double-click on the boundary makes all columns equal. Live feedback during the drag is CSS variables on
  the group, not document changes.
- **Nesting**: no columns inside columns — the slash items are not offered in a column, and HTML pasted
  into a column loses its column wrappers (`pasteFlatInColumn`).

## Alternatives considered
- **Leave core's behavior**: the empty columns of a new group vanish while you fill the first one.
- **Patch @blocknote/core** (the existing patch file): a patch keyed to 0.51.4 that every upgrade has to
  redo, for logic that is Inkling's choice, not a bug.
- **Normalize in appendTransaction** (add a column when one is missing): runs on every client for remote
  changes and duplicates through Yjs.

## Trade-offs
- Wrapping two editor methods is a monkey patch on our own instance; a BlockNote upgrade must re-check
  that the side menu and moves still call them (`lib/columns.test.ts` covers the behavior).
- Backspace at a column's start does not merge across columns; Notion moves the line. Kept simple and
  reversible.
- Two people: a column deleted while someone types in it: the text typed in it during that moment can be
  lost with the column (Yjs keeps no edits inside deleted elements); the document stays valid and both
  converge (browser check G2 kept the text when the delete unwrapped the group).

## Consequences
- Checked in Chrome: block-menu Delete on a column's only block and dragging that block out both leave
  the column with an empty line. A selection across columns deleted with Backspace removes what it
  covers, as anywhere else, and can leave a one-column group (valid, full width; Unwrap columns).
- Dragging a block beside another to make columns (core's multi-column drop cursor is in the GPL package)
  is a separate, later step.
