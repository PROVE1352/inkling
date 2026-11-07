# 1102. One encode per store, one decode per index pass

- Status: Accepted
- Date: 2026-11-07

## Context
ADR 1042 left two whole-document costs on every edit of a large page: the store (encode + a
multi-MB `page_docs` write) and the index pass that follows it (decode + BlockNote read). Looking
closer, both paid more than once:
- `@hocuspocus/extension-database` 2.15 encodes the whole document (V1) in `onStoreDocument` before
  calling our `store`, which ignored that buffer and encoded again from the live document inside
  the serialised chain (needed so the last store writes the newest state). Two full encodes per
  store, on every typing store too.
- The index pass decoded the stored bytes for the BlockNote conversion and, on pages that contain
  the bytes "mention", decoded them a second time for the mention scan.
- The first index pass of a never-indexed page re-encoded the document it had just loaded.

## Decision
- **Own persistence extension** (`persistence` in collab.ts) with the same two hooks as the
  Database extension: load applies the stored row (V1 or V2, ADR 1101) to the document; store
  encodes once (V2) from the live document inside the serialised chain. The Database extension
  stays installed but unused.
- **One decode per index pass** (`docIndexer.runIndex`): the stored bytes are applied once to a
  throwaway document; the mention walk reads that Yjs tree first (it is read-only), then BlockNote
  reads the same document (its read deletes nodes the server schema lacks, mention chips among
  them, so the order matters). The throwaway document is left to the GC as before. (An apparent
  ≈ 55 ms cost of `Y.Doc.destroy()` in one interleaved A/B disappeared once GC was isolated: it was
  GC placement, not work.)
- The never-indexed-page pass at load takes the bytes the load read.
- **Not done: reusing the live document for the index pass.** A BlockNote read of the live
  document would delete unknown nodes (mention chips) and broadcast that to every client
  (sectionPatch.ts `readBlocks` copies for this reason), and a copy costs an encode + decode, more
  than decoding the bytes the store already has. A long-lived "index shadow" document per page was
  rejected for memory (one decoded 4.5 MB page holds 78 MB of heap, ADR 1041).

## Measurements
docs/PERFORMANCE.md: "Collab store encode" (2.1–4.0× on every store), "update_page append" and
"patch_section append (round 2)" (1.0–1.3× / 1.1–1.2× p50 on the production copy), "Index pass
decode" under Rejected / no effect (the production copy has no mention chips, so it decoded once
before too, and V1/V2 decode cost the same), and the patch_section probe regression.

## Consequences
- Hocuspocus upgrades must keep the extension hook names `onLoadDocument` / `onStoreDocument`
  (unchanged since 2.x).
- The index pass still decodes the whole page once per pass; on the 4.5 MB page that is the largest
  remaining per-edit cost together with the store's encode and write.

## References
- apps/server/src/collab.ts (`persistence`, `storeDocument`), apps/server/src/docIndexer.ts (`runIndex`)
- apps/server/src/notify/mentionScan.ts (`scanMentionsInDoc`), apps/server/src/notify/producers.ts (`mentionSignature`)
- apps/server/src/md/convert.ts (`docToBlocks`)
- ADR 1041 (memory of a decoded page), ADR 1042 (write paths), ADR 1101 (V2)
