# 0403. Plugin blocks are stored as generic placeholder blocks

- Status: Accepted (experimental `plugins`)
- Date: 2026-11-07

## Context
Custom blocks must live inside collaborative Yjs/BlockNote documents, but the editor schema is
static, plugin code must not run inside the editor, and documents outlive plugins (uninstalled,
disabled, flag off).

## Decision
One generic block type, `pluginBlock`, with props `{ pluginId, blockType, data }` where `data` is a
JSON string (≤ 16 KB) and `content: 'none'`. It is **always** part of the editor schema. The React
renderer creates a sandboxed frame only when the plugin is active, the block type is declared and
the block is on screen; otherwise it shows an inert placeholder card. The frame renders from
`data` and may request `setData`, which the parent applies with `editor.updateBlock` (only when the
editor is editable, coalesced to ≤ 4 writes/s). Remote changes are pushed back into the frame.

## Alternatives considered
- **Register a block spec per plugin block at runtime**: the schema is built once per editor;
  when a plugin is missing, y-prosemirror would drop the unknown nodes on the next edit — silent
  data loss.
- **Store plugin state outside the document**: breaks copy/move/undo/history and collaboration.

## Trade-offs
Like `pageEmbed`/`callout`, the server-side BlockNote schema does not know `pluginBlock`, so
Markdown/Notion export drops these blocks (the live document keeps them).

## How others solve it
Notion's synced/embed blocks and Coda Packs store a typed reference plus serialized state and let
an isolated renderer draw it; Obsidian stores code-block text that plugins post-process.

## Consequences
Plugin block data is shared with collaborators and versioned with the page; plugins never see the
rest of the document unless they also hold `read:pages`.

## References
- apps/web/src/plugins/PluginBlock.tsx:23 (config), :195 (fallback), :208 (spec)
- apps/web/src/components/CollabEditor.tsx:56 (schema registration)
- apps/web/src/plugins/integration.tsx (slash-menu insertion)
