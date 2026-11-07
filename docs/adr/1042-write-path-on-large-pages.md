# 1042. Write paths on large pages: one connection, region-only checks, unchanged stores skipped

- Status: Accepted
- Date: 2026-11-07

## Context
On a 4.5 MB page an `update_page append` took 1.3–1.6 s and a `patch_section append` 0.9–1.0 s, with
the event loop blocked for up to 0.5–0.6 s at a time (docs/PERFORMANCE.md). The work was almost all
whole-document copies that the edit did not need:
- `writeBlocksToDoc(append)` opened one DirectConnection only to decide whether the page was empty
  (a full read), and its disconnect stored and re-indexed the unchanged document; then
  `appendBlocksToDoc` opened another, copied the whole document to verify the append (encode +
  apply + two full `yDocToBlocks` + two `JSON.stringify` of every block), read the whole result back
  for a return value the route did not use, and stored twice (transact and disconnect).
- Every DirectConnection stores on `transact` **and** on `disconnect` (Hocuspocus 2.15), each a full
  encode, a multi-MB `page_docs` write and an immediate index pass that decodes everything again.
- `applySectionPatch` read the whole document (1 copy), dry-ran the edit on a full copy (1–2), read
  that copy back to validate (1–2) and read the live document again for the result (1): 4–6 copies.

## Decision
- **Append** (`md/docWrite.ts`): one DirectConnection per call. Emptiness is decided from the Yjs
  structure (more than one top-level container is never empty) and only a 0–1 block doc is read. The
  new blocks are verified on their own throwaway doc (BlockNote builds one container per block and
  can read them); existing blocks are not read, because inserting at the end of the top-level group
  cannot change them. After the insert, count and identity of the new containers are asserted. No
  read-back unless a caller asks for it (`appendBlocksToDoc` for quick task add still does). The "AI
  edit" snapshot after an agent append takes the stored state instead of re-encoding the read-back
  blocks (which also dropped blocks the server schema does not know).
- **Unchanged stores** (`collab.ts`): the store hook keeps, per loaded document object, the SHA-1 of
  the state `page_docs` holds (from fetch, then from each write). A store with the same digest writes
  nothing, takes no auto snapshot, does not bump `updated_at` and does not re-index; when it would
  have indexed immediately it runs a pending debounced pass now instead. SHA-1 of 4.5 MB ≈ 1.5 ms.
  Because a no-op disconnect store used to index never-indexed pages as a side effect (so the first
  agent edit was diffed against it in the change feed), a page without an index marker is now indexed
  when it is loaded (`afterLoadDocument`).
- **patch_section** (`context/sectionPatch.ts`): the dry run and its validation work on a copy of the
  edited region only (`copyTopRange`: the section's top-level containers plus the one before, the
  insert anchor). The result is the first read with the edited region read back (`readTopRange`)
  spliced in, instead of a second full read. One full read per patch remains (sections and versions
  need the whole heading structure). The route's echo index reads the section through ADR 1041.

## Alternatives considered
- **Compaction** (rebuild the Y.Doc from blocks). Measured −90 % on a tombstone-bloated synthetic
  page, but the production page is 99.9 % live content (bloat report), so it would not help, and
  without an epoch an old tab reconnecting would duplicate content.
- **worker_threads for conversions.** Moves the block off the main loop but copies multi-MB states
  across threads and does not reduce work; revisit if a single full read still matters.
- **Skip the store on disconnect inside Hocuspocus.** Needs a patched dependency; the digest check
  covers it and every other no-op store.

## Consequences
- Behavior differences, all on edge cases: a page holding one empty paragraph plus unknown blocks
  (callout) is appended to instead of replaced; a no-op transact (e.g. a vault-sync revision mismatch)
  no longer bumps `pages.updated_at`; patch validation no longer fails because of unreadable blocks
  outside the patched section.
- `storeStats` (written/skipped) is exported for tests and benches.

## References
- apps/server/src/md/docWrite.ts, apps/server/src/routes/pageContent.ts
- apps/server/src/collab.ts (`persisted`, `storeDocument`, `afterLoadDocument`)
- apps/server/src/context/sectionPatch.ts (`copyTopRange`, `readTopRange`, `applySectionPatch`)
- apps/server/src/context/largePage.test.ts (patch results equal a full read for every mode), sectionPatch.test.ts (unchanged)
- ADR 0940 (minimal Yjs edit), ADR 0750 (store path)
