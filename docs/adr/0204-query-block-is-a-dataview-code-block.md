# 0204. The Query block is a `dataview` code block with portal-rendered results

- Status: Accepted
- Date: 2026-11-07

## Context
A Query block needs an editable query and rendered results. The server-side BlockNote editor
(`md/editor.ts`) uses the default schema; custom blocks (callout, page embed, mention) are silently
dropped by `yDocToBlocks`, i.e. they vanish from markdown export, the MCP connector and vault sync
(verified: a `query` element in the Yjs XML disappears from the block list). Results must refresh
when pages change without adding a polling loop per block.

## Decision
- The block **is a `codeBlock` with `language: "dataview"`** (`components/blocks/QueryBlock.tsx`).
  The editor schema's `codeBlock` is the stock BlockNote spec with its `render` wrapped: for
  `dataview` node views a non-editable host element is appended below the code. `dataview` is a
  selectable language that shiki treats as plain text (aliased on the `text` entry, so no grammar
  load is attempted). Slash menu "Query" inserts it with a starter query.
- Results are rendered by `<QueryBlockPortals>` (inside `BlockNoteView`, so router and React Query
  contexts exist) through `createPortal` into the registered hosts. The node view declares
  `ignoreMutation` for the host (otherwise ProseMirror treats React's DOM writes as edits and
  redraws the node view in an endless loop — observed in the browser smoke) and `stopEvent` so
  clicks on result links are not handled as editor clicks. Results use an ARIA grid of divs,
  because a `<table>` inside the editor DOM is picked up by BlockNote's table-handle plugin
  (threw on mouse move in the smoke).
- **Refresh without new polling**: the React Query key includes a workspace version derived from
  the page list that `usePages` already polls every 20 s (count + newest `updatedAt`); the query is
  `enabled` only while the block is within 200 px of the viewport (IntersectionObserver) and
  `staleTime: Infinity`, so an unchanged workspace causes no requests. Query text edits are
  debounced 500 ms; syntax errors are shown locally (same parser as the server) with a caret.

## Alternatives considered
- A custom `query` block (`createReactBlockSpec`) — cleaner React integration, but it would be lost
  in every server markdown path unless convert.ts learned to translate it both ways at the Yjs XML
  level; Obsidian would also not recognise it.
- Rendering results with a separate React root per block — loses router/query-client context and
  duplicates caches.
- Server push (stateless broadcast on page change) — Hocuspocus only broadcasts to clients of the
  same document; workspace-wide fan-out would be a new channel.

## Trade-offs
- Read-only embeds (`PageEmbed` viewer schema) and public share pages show the query as code,
  without results.
- Results can be up to one page-list poll (20 s) behind edits made elsewhere; edits in the same
  tab invalidate faster via the pages cache.
- The wrapper depends on BlockNote's `implementation.render` being consulted when the schema
  builds node views (true in 0.51.4, which is pinned).

## How others solve it
- Obsidian Dataview: a ```` ```dataview ```` fenced block rendered by a code-block post-processor —
  the same representation, which is why vaults round-trip unchanged.
- Notion linked databases: a dedicated block type with server-side state.

## Consequences
- Query blocks survive export/import, MCP `read_page`/`update_page` and vault sync as plain fences.

## References
- apps/web/src/components/blocks/QueryBlock.tsx (`queryCodeBlockSpec`, `QueryBlockPortals`, `QueryResults`)
- apps/web/src/components/CollabEditor.tsx (schema `codeBlock: queryCodeBlockSpec`, portal mount)
- apps/web/src/components/SlashMenu.tsx (`querySlashItem`)
- apps/web/src/api.ts (`runQuery`, `usePages` 20 s poll reused)
- apps/server/src/md/editor.ts (default server schema), apps/server/src/md/docWrite.ts:73 (dropped custom blocks)
- node_modules/@blocknote/core/src/schema/blocks/createSpec.ts:193 (node view built from `implementation.render`)
