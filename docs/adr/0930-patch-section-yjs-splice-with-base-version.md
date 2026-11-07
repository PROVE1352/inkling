# 0930. patch_section: splice one section in the live Yjs document, guarded by a section version

- Status: Accepted; the `replace` edit and the live-doc read are amended by 0940 (minimal Yjs edit)
- Date: 2026-11-07

## Context
`update_page` can only append or replace the whole body. To change one paragraph an agent read the
whole page and sent it back (≈ 2,400 estimated tokens for a 1.5k-token page), and `replace` rebuilt
every block: block ids (comment anchors) changed and a person typing elsewhere in the page could
lose characters typed between the agent's read and write.

## Decision
- **Tool** `patch_section(pageId, section, markdown, mode, baseVersion)`; **route**
  `POST /api/pages/:id/section` (30/min, like `/content`). Modes: `replace` (body; a leading heading
  in the Markdown also replaces the heading), `append` (end of the section), `prepend` (after its
  heading), `insert_after` (after the section — intended for a new `## Heading`), `delete`.
  `baseVersion` is required by the tool for `replace` and `delete`.
- **Edit** (`routes/context.ts:129` `applySectionPatch`) runs synchronously inside one
  `DirectConnection.transact`: convert the live doc to blocks, split sections (ADR 0926), resolve
  the reference, compare `baseVersion` with the current section version, then delete/insert only
  that section's top-level `blockContainer`s in the top-level `blockGroup`, inserting clones of
  containers BlockNote built on a throwaway doc (the `appendBlocksToDoc` technique — never
  hand-built Yjs). Check and write cannot interleave with another edit in this process. Concurrent
  edits elsewhere merge as ordinary Yjs updates; blocks outside the range keep their ids.
- **Conflict**: version mismatch → HTTP 409 `SECTION_CONFLICT` with the current Markdown and version;
  nothing is written. The tool returns it as an error result so the agent can merge and retry.
- **Versions in reads**: `v=` appears in find_context headers, `read_page(outline)` and
  `read_page(section)`; the success result returns the new version.
- **Snapshots**, consistent with update_page: destructive modes (`replace`, `delete`) take a
  "Before AI edit" snapshot first, at most one per page per 2 minutes, so a burst of section patches
  does not push human history out of the 50-snapshot cap; appends take none here (ADR 0936 adds the
  throttled "AI edit" marker for update_page appends). The write is wrapped in `withEditActor`, so
  the change feed attributes it (ADR 0932/0936).
- The store hook indexes server edits immediately, so `find_context` sees the patch when the call returns.

## Alternatives considered
- **Text-level diff/patch of the Markdown** (search/replace strings): fragile against concurrent
  edits and Markdown round-trip losses (callouts, mentions are not in the server schema).
- **ProseMirror steps on the server**: needs a full editor state per request; BlockNote's
  server util already gives safe block ↔ Yjs conversions at the block granularity we need.
- **Page-level version (`updatedAt`)**: any edit anywhere would conflict; section granularity lets
  an agent and a human work on different parts of one page.
- **Optional baseVersion everywhere**: last-writer-wins on a section silently drops a human's edit.

## Trade-offs
- (Superseded by 0940.) A human typing *inside* the patched section while the agent replaced it lost
  the characters typed into the replaced blocks; 0940 edits blocks in place so they merge.
- (Superseded by 0940.) Blocks the server schema does not know (callout, page embed, mention) inside
  the range were rewritten from Markdown; worse, reading the live doc with `yDocToBlocks` deleted them
  in the whole page. 0940 reads a copy and never touches them.
- Snapshot throttling means two quick destructive patches share one "Before AI edit" snapshot.

## How others solve it
Google Docs' API applies index-ranged requests with a `requiredRevisionId`; Notion's API patches
individual blocks; CRDT editors (Yjs, Automerge) recommend server edits as ordinary transactions so
peers merge them.

## Consequences
Measured (context.db.test.ts): changing one sentence costs ≈ 222 estimated tokens (outline + call +
result) vs ≈ 2,415 for read + update_page replace on the padded evaluation page; a concurrent client
edit in another section and the agent's patch both survive; untouched blocks keep their ids.

## References
- apps/server/src/routes/context.ts:129 (`applySectionPatch`), :214 (route)
- apps/server/src/md/docWrite.ts (`appendContainers`, the cloning pattern)
- apps/server/src/mcpTools/contextTools.ts (`patch_section`)
- apps/server/src/context/context.db.test.ts ("patch_section: …", "… concurrent edit …", "token cost …")
