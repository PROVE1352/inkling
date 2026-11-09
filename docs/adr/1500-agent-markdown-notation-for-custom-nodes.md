# 1500. Agent Markdown notation for callouts, embeds, files and mentions; update_page as a minimal edit

- Status: Accepted
- Date: 2026-11-09
- Amends: 0930, 0940 (patch_section), 0995 (server schema), 0926 (CHUNKER_VERSION 4)

## Context
KNOWN-ISSUES AGENT-E3: "inside the range it rewrites, patch_section converts Markdown with the server
schema, so callouts, page embeds and mentions in that section are lost". A census of every element
the web editor stores (`context/notationRoundTrip.test.ts`, each element × six scenarios, checked on
the Yjs document itself) showed the real picture before this change:

| Element | shown to the agent | as read | edit around | delete | host retyped | update_page replace | other section |
|---|---|---|---|---|---|---|---|
| callout, page embed, link embed, plugin block | no | kept | kept | impossible | – | **lost** | kept |
| file block (name, caption) | as a link paragraph | **lost** | **lost** | ok | – | **lost** | kept |
| audio name, image width, table cell colors, toggle list item, toggleable heading | partly | kept | kept | ok | – | **lost** | kept |
| mention | no | kept | kept | impossible | **lost** | **lost** | kept |
| block color/alignment, underline, text color, highlight | no | kept | kept | – | **lost** | **lost** | kept |
| math, query block, checkbox + date, numbered start | yes | kept | kept | ok | kept | kept | kept |

So after ADR 0940 the nodes survived a patch, but agents could not see them (read_page dropped them),
could not edit or delete them, `update_page replace` destroyed them, and a no-op patch over a file
block turned it into a link paragraph (its Markdown, `[name](url)` + caption, does not read back as a
file block). The server could not emit anything for callouts and mentions: its schema did not know
them, so every server read deleted them on the copy before any exporter ran.

## Decision
1. **Server schema knows every web node.** The configs of `callout`, `pageEmbed`, `linkEmbed`,
   `pluginBlock` and `mention` move to `packages/shared/src/blocks.ts` (as ADR 0995 did for math); the
   web specs import them, `md/serverSchema.ts` builds plain DOM specs from the same objects. Server
   reads (export, indexing, MCP, patch) now keep these nodes everywhere. Public HTML
   (`blocksToFullHTML`) leaves embeds and plugin blocks out and renders mentions as `@label`, so no
   internal ids reach a share page (as before).
2. **Notation** (`md/notation.ts`, sentinel technique of `md/math.ts`): never through BlockNote's
   Markdown pipeline, which drops HTML comments and unknown link schemes.

   | Node | Agent reads (`notation: 'agent'`) | Plain exports (default) |
   |---|---|---|
   | callout | `> [!warning] text` | same (Obsidian / GitHub alerts) |
   | mention | `@[Label](user:<id>)`, `@[Title](page:<id>)` | `@Label` |
   | page embed, link embed, plugin block | `<!-- inkling:pageEmbed {"pageId":"…"} -->` (one line, props that differ from the default, keys sorted, `--` escaped) | left out, as before |
   | file, audio | `<!-- inkling:file {"caption":"…","name":"…","url":"/files/…"} -->` | BlockNote's Markdown, as before |

   Agent mode is used by read_page (full: `GET /pages/:id/export?notation=agent`; section),
   read_pages, the 409 conflict body and patch_section's echo. Parsing understands every form in
   every caller: `> [!type]` with a known type becomes a callout (Obsidian vault uploads too); a block
   token becomes its block when its JSON is valid, its props match the block's prop schema and links
   are ones the app makes (page id = UUID, `http(s)` or `/files/<uuid>`, plugin data ≤ 16 KB) —
   otherwise it is dropped like any HTML comment. Tokens inside code are text.
3. **Mentions are kept, not created.** A mention token becomes a chip only for a `kind:id` already in
   the page (`pageMentionKeys`: XML walk of the open doc, else the stored state; only when the
   Markdown contains `@[`). Others become the text `@Label`. ADR 1002 (agents do not write chips; an
   agent's mentions never ping) holds: an agent can keep, move or delete a chip.
4. **Delete = remove the line; change = edit the token.** The minimal edit (ADR 0940) needs nothing
   new for this: the nodes are ordinary blocks/inline atoms now (callout text is diffed per
   character; embeds are content-less blocks whose props are copied; a mention is an inline token
   keyed by its attributes).
5. **Retyped blocks** (paragraph → list item …): within a run of changes between two kept/edited
   blocks, deleted and inserted blocks that pair one to one with a word Dice similarity ≥ 0.5 are an
   edit. The new content node starts from clones of the old inline content (so marks Markdown cannot
   express and chips stay), carries the old colors/alignment, then gets the character diff.
6. **update_page(replace) is a minimal edit of the whole document** (`applyDocumentReplace`, same
   dry run + validation + splice fallback as patch_section; if neither validates, the old rewrite).
   Blocks sent back unchanged keep their ids (comment anchors), colors, toggles, widths and concurrent
   typing. The echo is skipped above 2,000 blocks (blocks are then diffed by type).
7. **Echo shortcut**: an old block whose own key equals the key of one of the agent's new blocks is
   not round-tripped (`buildEchoIndex(…, incoming)`); only the others pay the two conversions.
8. **Index**: `CHUNKER_VERSION` 4 (callout lines, `@label`, embed placeholders in light Markdown).
   At boot, version-3 indexes of documents whose state contains none of the five node names (Yjs
   keeps names as UTF-8 in both encodings, as the mention pre-check relies on) are stamped 4 without a
   re-index; the rest are re-indexed by the existing backfill.

## Alternatives considered
- **Keep the server schema, restore nodes by hand-building Yjs from tokens.** Violates ADR 0930
  ("never hand-built Yjs"), and read_page still could not show them: the read deletes them first.
- **HTML comment tokens for callouts too.** Lossless, but callout text would be hidden from the
  agent's editing; `> [!type]` is the notation Obsidian and GitHub users already write.
- **Mentions as links with a custom scheme** (`[@Kim](mention:user/…)`): measured — BlockNote's
  parser drops the link and its exporter writes `[@Kim]()`.
- **Tokens in every export (vault sync, zip).** Vault round trips would keep embeds, but people
  would see comments in Obsidian and in downloaded files; kept plain (callouts and `@names` are an
  improvement there). Can be revisited per client.
- **A Markdown notation for colors / underline / toggles.** Verbose (HTML spans) and noisy in every
  read; the minimal edit (5, 6) keeps them for every block the agent leaves alone or retypes.
- **update_page replace stays a rewrite.** Cheaper (see below) but loses ids, comment anchors and
  everything Markdown cannot say.

## Trade-offs
- A retyped block gets a new content node: typing that reaches the server after the patch is not
  merged into it (as for a deleted block). The fuzz in `sectionPatch.test.ts` now counts such
  blocks with deleted ones (240/240 typed markers kept in the blocks that keep their type).
- update_page(replace) costs about 1.5–2× the old rewrite on the server's CPU (one full read for
  the dry run, the echo); see PERFORMANCE.md. The store and index pass that follow are unchanged.
- An invalid block token disappears without an error (as HTML comments always did).
- Plain Markdown output changes for pages with callouts or mentions (zip/page export, vault sync,
  templates, history previews, activity diffs): they now contain `> [!type] text` and `@Label`
  where they used to contain nothing. Vault sync revisions are state-vector based (and the cached
  content hash is keyed by revision), so this alone does not make clients pull pages again; the next
  pull of a changed page brings the new lines. Embeds and plugin blocks are still left out, so a vault upload still
  removes them (as before), and chips come back as `@Label` text.
- A non-list block nested under another block (an embed, callout or file under a list item or a
  callout) is written at the top level by BlockNote's Markdown (the ADR 0940 trade-off for nested
  non-list blocks): a patch over that section keeps the node and its props but moves it to the top
  level with a new id (`notationRoundTrip.test.ts`, "nested under a list item").
- The version-3 → 4 promotion is one `UPDATE` that scans every `page_docs.state` once at boot
  (`position()` over the bytes): a one-time cost proportional to the total state size. Re-indexed
  pages write no change-log rows (`log: false`, as the backfill always did); a page beyond the boot
  batch limit logs its callout/mention lines as `modified` on its first edit after the upgrade.
- The read-only page-embed viewer in the web app (`PageEmbed.tsx`, `embedSchema`) still lacks
  callout, mention, link embed and plugin block (outside this change).

## Measured
`notationRoundTrip.test.ts`: all 20 element kinds kept in every scenario after the change (before:
22 losses, see Context); a page holding all of them sent back as read through patch_section and
update_page produces no Yjs update. `notationMoves.db.test.ts` checks the same through MCP.
Latency: `apps/server/scripts/section-write-bench.ts`, rows in PERFORMANCE.md.

## References
- packages/shared/src/blocks.ts, apps/server/src/md/serverSchema.ts, apps/server/src/md/notation.ts
- apps/server/src/md/convert.ts (`blocksToMarkdown` `notation`, `markdownToBlocks` options, `publicBlocks`)
- apps/server/src/context/sectionPatch.ts (`buildEchoIndex`, `pairRetypes`, `replaceRange`, `applyDocumentReplace`)
- apps/server/src/md/docWrite.ts, apps/server/src/routes/pageContent.ts, apps/server/src/routes/context.ts
- apps/server/src/context/chunker.ts, apps/server/src/context/chunkIndex.ts (`promoteWithoutNewNodes`)
