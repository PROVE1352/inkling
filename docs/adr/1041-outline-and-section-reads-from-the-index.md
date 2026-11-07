# 1041. Outline and section reads answer from the section index when it is provably current

- Status: Accepted
- Date: 2026-11-07

## Context
`GET /pages/:id/outline` and `GET /pages/:id/section` (MCP `read_page outline|section`) decoded the
whole document on every call (`loadBlocks`: `Y.applyUpdate` of the stored state or of an encode of
the live doc, then `yDocToBlocks` and `splitSections` of everything). On a 4.5 MB page that is
150–185 ms of blocked event loop per call even to list headings, and other requests wait behind it.
`page_chunks` already holds every section's anchor, heading path, level, token estimate and version
(ADR 0926), but it may trail the document: live typing is indexed with a debounce (≤ 30 s), a pass
can fail, and after a restart nothing says which state it was built from.

## Decision
- **Freshness record** (`docIndexer.ts`): when an index pass completes and its `page_chunks` write
  succeeded, the page is stamped with the stored state the pass indexed. The stamp is
  `page_docs.updated_at::text`, returned by the store's own `INSERT … RETURNING`. Scheduling a pass
  clears it; `indexedStamp(page)` is null while a pass is queued or running.
- **Live documents** (`liveConnections.ts`): each loaded document counts its Yjs updates. Load and
  every store record "at update count N the document equalled stored state S". A document with
  updates after that point has unsaved edits.
- **Current** means: a stamp S is recorded, no pass is queued, and either the open document has had
  no update since it equalled S, or (not open) `page_docs.updated_at` is still S. Only then:
  - outline = one query over `page_chunks` (no text column), sections rebuilt from the rows; heading
    path arrays are reconstructed with the same heading stack as `splitSections`, so titles that
    contain ` › ` still split exactly;
  - section = the anchor is resolved on the rebuilt sections, then only that section's top-level
    containers (heading id to the next section's heading id) are cloned into a throwaway doc and read
    through BlockNote. For a stored document the state is still applied once (≈ 100 ms on 4.5 MB),
    but nothing else is converted; an open document is not copied at all. Section Markdown is cached
    per (page, stamp, anchor), 4M characters in total, so a repeated read of an unchanged section is
    a lookup.
  - The check is repeated synchronously right before reading the document, so an update that lands
    while the request awaits makes it fall back instead of mixing states.
- **Everything else decodes exactly as before.** After a decode of a state with a known stamp, the
  chunk hashes are compared with `page_chunks`; equal → the stamp is adopted (first read after a
  restart pays once), different → a debounced index pass is scheduled (self-heals a lost pass).
- Output is byte-identical between the two paths (tests compare them); `read_page` and the REST
  shapes are unchanged.

## Alternatives considered
- **LRU of decoded blocks or Y.Docs keyed by (page, state).** A decoded Y.Doc of the 4.5 MB page
  holds 78 MB of heap; blocks are similar. One entry would be most of the server's memory budget.
- **Timestamps only** (`page_chunk_index.indexed_at ≥ page_docs.updated_at`). A pass for an older
  state can finish after a newer store, and passes that find nothing to change do not stamp, so it
  is both unsafe and often stale.
- **State-vector comparison for live docs.** Deletions do not advance the state vector, so a
  backspace would look unchanged.
- **Serve the section text from `page_chunks.text`.** It is light Markdown (no marks, links as
  `[[…]]`), not what `read_page section` returns.

## Consequences
- In-memory, single instance (like the rest of the indexer state). After a restart each page's first
  outline/section read decodes once.
- A heading block without an id, duplicate top-level ids or a page at 5,000 index rows always take the
  decode path.
- `docIndexerSizes()` reports `indexedStamps`; `sectionCacheSize()` reports the Markdown cache.

## References
- apps/server/src/context/sectionSource.ts (`readOutline`, `readSection`, `readSectionBlocks`, `sectionsFromRows`, `rangeBlocks`)
- apps/server/src/docIndexer.ts (`indexedStamp`, `adoptIndexedStamp`, `docIndexIdle`, `flushDocIndex`)
- apps/server/src/liveConnections.ts (`trackLiveDoc`, `liveDocStamp`), apps/server/src/collab.ts (fetch, store, `afterLoadDocument`)
- apps/server/src/routes/context.ts (outline, section, patch echo)
- apps/server/src/context/largePage.test.ts, apps/server/src/context/largePage.db.test.ts
