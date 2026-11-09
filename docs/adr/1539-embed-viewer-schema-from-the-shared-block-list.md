# 1539. Embed viewer schema built from the editor's one spec list

- Status: Accepted
- Date: 2026-11-09

## Context
The page-embed viewer (`apps/web/src/components/blocks/PageEmbed.tsx`) binds a read-only BlockNote
editor to the embedded page's live Yjs doc. y-prosemirror deletes the Yjs items of nodes the
binding's schema does not know (ADR 0940, 0995), and the deletion syncs back into the live page.
ADR 0995 fixed this for math by adding the two math specs to the viewer's schema by hand, but the
viewer's `embedSchema` was still a second hand-written list next to the main schema in
`CollabEditor.tsx`. It lacked `callout`, `linkEmbed`, `pluginBlock` and the inline `mention`, so
opening a page that embeds another page deleted those nodes from the embedded page: a callout
block disappeared, a mention chip was removed from its paragraph.

## Decision
- `packages/shared/src/blocks.ts` exports `CUSTOM_BLOCK_TYPES` (`callout`, `pageEmbed`,
  `linkEmbed`, `pluginBlock`, `math`) and `CUSTOM_INLINE_CONTENT_TYPES` (`mention`, `inlineMath`),
  derived from the shared configs, with the unions `CustomBlockType` / `CustomInlineContentType`.
- `PageEmbed.tsx` exports `editorSchemaSpecs({ pageEmbed, codeBlock })`, which returns the
  `blockSpecs` / `inlineContentSpecs` of the editor schema: BlockNote's defaults plus every custom
  spec. The custom maps `satisfies Record<CustomBlockType, unknown>` (and the inline equivalent),
  so a type added to the shared list and not registered fails typecheck, as does a key that is not
  in the list. `satisfies` rather than an annotation keeps the spec types BlockNote infers.
- Both schemas are built from it. `CollabEditor` passes the full `pageEmbedSpec` and
  `queryCodeBlockSpec`; the viewer passes the shallow pageEmbed spec (card only, the recursion
  guard) and the plain highlighted code block. Those are the only differences, and both are renders
  of the same node type with the same props.
- The builder lives in `PageEmbed.tsx` because that module owns both pageEmbed variants and
  `CollabEditor` already imports it; placing it in `CollabEditor.tsx` would make a runtime import
  cycle (and that module imports CSS, so it cannot load in Node tests).

## Alternatives considered
- **Add the four missing specs to `embedSchema` by hand**: the fix of ADR 0995, which this bug
  shows drifts as soon as the next node is added.
- **Give the viewer the main schema unchanged**: a nested pageEmbed would open another provider
  and render its body, recursively.
- **Use `queryCodeBlockSpec` in the viewer too**: same node, but its live-results node view needs
  the editor's `QueryBlockPortals`, which the viewer does not mount; it would add an empty host.
- **Build the server schema from the same type list**: the server cannot import the React specs;
  it already registers the same configs (ADR 1500) and is left unchanged here.

## Consequences
- Tests (`apps/web/src/components/blocks/PageEmbed.test.ts`): the shared lists match the shared
  configs and the embed schema knows every one; the embed and main schemas have the same block and
  inline types, props and content; a Yjs doc written with the main schema (callout, mentions,
  inlineMath, linkEmbed, pluginBlock, math, pageEmbed, dataview code block) is read through the
  embed schema without any change to the fragment and reads back the same blocks; control:
  BlockNote's default schema deletes those nodes. Before the fix three of the four tests failed.
- The test imports the specs in Node with an inert `window`/`document` stand-in during import only
  (app modules such as theme and zoom touch them on load); prosemirror-view and BlockNote are loaded
  before the stand-in so they see no DOM.
- A new custom node now has to be added to `CUSTOM_BLOCK_TYPES` / `CUSTOM_INLINE_CONTENT_TYPES`
  and to `editorSchemaSpecs`; the embed viewer gets it with no further change. The server schema
  (`apps/server/src/md/serverSchema.ts`) still lists its specs by hand.

## References
- ADR 0940 (server reads copy the doc), ADR 0995 (math in both schemas), ADR 1500 (shared configs).
