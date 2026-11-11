# 2420. Columns are `columnList` and `column` nodes next to BlockNote's blocks

- Status: Accepted
- Date: 2026-11-11

## Context
People want blocks side by side, Notion style (two screenshots next to each other). The first step is
the `/2단` and `/3단` slash commands (en "2 columns", "3 columns"); dragging a block beside another to
make columns comes later. The editor is BlockNote 0.51.4 on Yjs; the server reads the same Yjs
documents with its own BlockNote schema (md/serverSchema.ts), and y-prosemirror deletes nodes a reading
schema does not know (ADR 0940).

BlockNote's own multi-column package, `@blocknote/xl-multi-column`, is licensed `GPL-3.0 OR
PROPRIETARY`. Inkling is MIT.

## Decision
- **Structure**: two ProseMirror nodes in the bnBlock group, the shape @blocknote/core 0.51 documents in
  its node README and already handles in its own code (getBlockInfo, Tab/Shift+Tab, Backspace/Delete at
  a column edge, the side menu, moveBlocks, copy):
  `blockGroup > columnList > column+ > blockContainer+`. A group's content is `column+` (one column is
  valid, see Consequences); 2–4 columns are made by the UI.
- **Props**: `columnList` none, `column.width` a weight (flex-grow, default 1). Block ids on both (core's
  UniqueID already covers the two names).
- **One definition**: `packages/shared/src/columns.ts` builds both Tiptap node configs from Tiptap's Node
  class, which each side takes from a node BlockNote built (neither web nor server depends on
  `@tiptap/core`). Web (`components/blocks/Columns.tsx`, registered in `editorSchemaSpecs`, so the main
  editor, the page-embed viewer and row templates know them) and server (`md/serverSchema.ts`) register
  them with core's `createBlockSpecFromTiptapNode`. `CUSTOM_BLOCK_TYPES` lists them, so a schema that
  forgets them fails typecheck (ADR 1539).
- **License**: the GPL package is not installed, read or copied. The code uses the public API of
  `@blocknote/core` / `@blocknote/react` (MPL-2.0, already used at 0.51.4) and ProseMirror/Tiptap. No new
  dependency.

## Alternatives considered
- **(가) BlockNote children**: a `columns` block whose children are `column` blocks whose children are the
  content, laid out with CSS. Tried on the server editor (headless): Shift+Tab on a column's first block
  moved it out of its column to become a sibling of the columns, i.e. a new "column"
  (`[["hold",[["c1",[]],["x",[]],["c2",["y"]]]]]`); Backspace at a column's start unnests the same way,
  and the side menu and drag treat columns as indented children. Every one of those would need its own
  override. With (나) the same unnest is a no-op because core treats `column` like a blockGroup.
- **@blocknote/xl-multi-column**: GPL-3.0 or a commercial license; not compatible with shipping Inkling
  under MIT.
- **Other node names** (`inklingColumns`): core's column handling keys on the names `columnList` and
  `column` (UniqueID types, nestBlock, replaceBlocks, the side menu); other names would lose ids and need
  every one of those paths rewritten.

## Trade-offs
- The names match the commercial package's, so documents would read there too; nothing here depends on it.
- Old clients: a 0.19 editor does not know the nodes and y-prosemirror deletes the whole group **with the
  blocks inside it** when that client edits the page (worse than the 0.18 button, ADR 2244, which lost
  only itself; `components/blocks/ColumnsCompat.test.ts` records it). Known issue; the service worker
  updates clients on reload.

## Consequences
- `column+` instead of `column column+`: two people removing different columns at once can leave one
  column, and y-prosemirror deletes an element its schema rejects, contents included (tested). A
  one-column group stays readable and can be unwrapped.
- Files: packages/shared columns.ts, blocks.ts; server md/serverSchema.ts, md/notation.ts, md/docWrite.ts,
  notify/mentionScan.ts; web components/blocks/Columns.tsx, lib/columns.ts, PageEmbed.tsx,
  CollabEditor.tsx, SlashMenu.tsx, lib/present.ts, lib/docOutline.ts, lib/headingFolds.ts,
  lib/sanitizeHtml.ts, index.css, print.css, i18n columns.ts.
