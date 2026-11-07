# 0940. patch_section: minimal Yjs edit instead of a block splice

- Status: Accepted (amends 0930)
- Date: 2026-11-07

## Context
ADR 0930 made `patch_section(mode=replace)` delete every top-level block container of the section
and insert clones of new ones. Check and write are atomic on the server, but a person typing in that
section whose keystrokes had not reached the server yet lost them: the Yjs items their characters
point at were deleted (AGENT-C1). Blocks the server schema does not know (callout, page embed, link
embed, plugin block) and inline mentions inside the range were rewritten from Markdown and lost.

While measuring this we found a worse, page-wide loss: the old code read the **live** document with
`yDocToBlocks`. When y-prosemirror meets a node its schema does not know it deletes that Yjs item as
"recovery" (`createNodeFromYElement` / `createTextNodesFromYText` catch → `_item.delete`). The server
schema has no callout/mention/pageEmbed/linkEmbed/pluginBlock, so every patch (any mode) deleted every
such node in the whole page, in other sections too, and broadcast the deletion to all clients.

## Decision
- **Never read the live doc.** `readBlocks(doc)` reads a copy (`encodeStateAsUpdate` → new doc). All
  modes use it; section bounds are mapped to the live `blockGroup` by `blockContainer` id, so unknown
  containers between known ones belong to the range they sit in. The section version formula and
  `baseVersion` check are unchanged (still computed on the server's reading).
- **replace = minimal edit** (`context/sectionPatch.ts`):
  1. *What the agent saw*: before the synchronous patch the route exports each old block of the
     section (and each child) to Markdown on its own and parses it back ("echo", normalized through
     BlockNote's own Yjs conversion). Keys are `[type, props, content]` without id/children.
  2. *Block alignment*: Myers (`context/diff.ts`, `myers`) on the echo keys of the old blocks vs. the
     keys of the new blocks, after trimming the common prefix/suffix. Equal key → the block is
     untouched (its Yjs items are not written at all), only its children are aligned recursively.
  3. *Pairing*: inside each run of changes old and new blocks of the same type (toggle ≡ bullet, as
     Markdown has no toggles) are paired by a second Myers on type names and edited **in place**
     (the block id stays). Unpaired new blocks are inserted (clones of containers BlockNote built on a
     throwaway doc), unpaired old blocks deleted. Blocks of a different type are delete + insert.
  4. *In-place edit*: the content node's inline children are tokenized — one token per code point of
     every `Y.XmlText` run (with its attributes), one per known inline element (`hardBreak`); unknown
     inline elements (`mention`) are not tokens and are never touched. Myers on the tokens (caps:
     D 4,000 / 4M steps, over the cap: delete all + insert all, still in the same block) gives
     `delete` / `insert` / `format` operations, applied from the end backwards so recorded offsets
     stay valid. Inserted text continues the neighbouring marks Markdown cannot express (underline,
     colors); `format` only changes `bold, italic, strike, code, link`. Props are copied from the new
     node except `backgroundColor, textColor, textAlignment, isToggleable, previewWidth`. These two
     sets are asserted against BlockNote's real round trip in `sectionPatch.test.ts`.
  5. *Tables* (and any non-inline content node) that changed are replaced as one content node inside
     the same container: the block id stays, concurrent typing inside that table is not merged.
- **Dry run on a copy, then the same edit on the live doc.** The edit runs first on a copy of the
  document and the copy is validated: every container whose node the server schema knows must
  survive a BlockNote read (proves the hand-applied Yjs structure is valid for y-prosemirror), and
  every edited/inserted block must read back as the requested content. Only then does the same
  deterministic edit run on the live doc in one transaction of the same `DirectConnection.transact`
  (one update to clients, written by the live doc's own client id). If validation fails the old
  splice runs instead (logged); if that fails too nothing is written and the call errors. Applying
  the copy's update instead was rejected: it writes under a foreign client id (one more state-vector
  entry per patch, forever), and Yjs re-rolls the doc's id when a remote update carries its own.
- `append`, `prepend`, `insert_after` and `delete` keep their simple insert/delete, now with live
  positions by id (unknown containers at the end of a section stay inside it).
- Agent-editing badge (awareness / stateless broadcast): **not done** here. It is feasible
  (`hocuspocus` stateless broadcast like `{t:'comments'}`, a block-id-anchored badge in the web
  editor, en/ko strings), but it needs web editor and i18n changes while those files are being
  changed by another work stream, and with concurrent typing now merged it is a hint, not a fix.

## Alternatives considered
- **y-prosemirror `updateYFragment`** (the editor's own PM→Y diff): needs a ProseMirror document in a
  schema that knows the web's custom nodes; the server schema does not (no React specs on the
  server), so callouts/mentions would still be lost.
- **Hand-built server copies of the web's custom specs**: duplicates React block specs and drifts.
- **Three-way text merge (echo → new applied onto old)**: exact for blocks with lossy round trips
  (e.g. the `\` hard-break export reads back with a leading space) but needs offset mapping between
  three texts; the echo key already removes the artifact for every block the agent left unchanged.
- **Keep replace, rely on baseVersion**: the version only covers edits that already reached the server.

## Trade-offs
- Characters a person types into a block the agent **deletes** are lost (CRDT: the parent is gone).
  Characters typed into a range the agent rewrites survive, interleaved by position ("w|XY|as").
- Changed blocks take the Markdown round-trip artifacts of their new text (e.g. bold+code on the same
  run reads back as code only); unchanged blocks are not affected.
- Inserting a `hardBreak` in the middle of a text run splits the run (tail deleted and re-inserted);
  concurrent typing in that tail lands before the break.
- A non-list block with nested children is exported flat; if the agent edits around it, the children
  are re-created at top level (new ids). Rare (Tab-indented paragraphs).
- The echo costs two Markdown conversions per block before the patch (≈ 43 ms for 100 blocks, 94 ms
  for 300); the synchronous part inside the transaction is ≈ 9 / 15 ms.
- Other server paths still call `yDocToBlocks` on a live doc and have the same destructive read:
  `md/docWrite.ts` (`writeBlocksToDoc`, `appendBlocksToDoc` result read) and `routes/sync.ts`
  (`snapshotPage`). Out of scope here; listed in KNOWN-ISSUES.

## How others solve it
Google Docs applies index-ranged requests against a revision; Notion patches blocks by id; Yjs and
Automerge recommend expressing server edits as minimal operations on the shared types so they merge
like any peer's (the approach here).

## Consequences
Measured in `apps/server/src/context/sectionPatch.test.ts` (old splice kept there as `legacyPatch`):
concurrent typing in the patched section 1/6 → 6/6 scenarios kept; fuzz (60 random sections and
agent edits, a marker typed into every block) 0/240 → 240/240 markers kept in blocks that survive,
every result reads back exactly as the sent Markdown; block ids kept in the section 0/4 → 4/4;
callout in the section, callout in another section and mention in an edited block: all lost → all kept;
a no-op patch (section sent back as read, with tables, lists, hard breaks, toggles, colors) produces
no Yjs update. patch_section's response and tool description are unchanged (token cost 222 in
context.db.test.ts, as in 0930).

## References
- apps/server/src/context/sectionPatch.ts (`applySectionPatch`, `buildEchoIndex`, `readBlocks`)
- apps/server/src/routes/context.ts (`POST /pages/:id/section`)
- apps/server/src/context/sectionPatch.test.ts
- y-prosemirror `src/plugins/sync-plugin.js` (`createNodeFromYElement`, `normalizePNodeContent`)
