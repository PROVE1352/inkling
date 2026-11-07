# 1101. Yjs V2 encoding for stored states, read in either format, converted on the next store

- Status: Accepted
- Date: 2026-11-07

## Context
`page_docs.state` held Yjs V1 updates. The V2 encoding of the same document is smaller (production
copy: 4,499,751 → 3,079,353 bytes, −31.6 %), compresses better under TOAST, and is faster to
encode; decoding costs the same within noise (docs/PERFORMANCE.md). The collaboration protocol (Hocuspocus 2.15 sync) is V1 and is not touched:
it encodes from the in-memory document, never from the stored bytes.

## Decision
- **Writes:** the collab store writes `Y.encodeStateAsUpdateV2(doc)`, sets
  `page_docs.state_format = 2` and stores `Y.encodeStateVector(doc)` in `page_docs.state_vector`
  (cheap from a document; spares a struct parse when the version history diffs the stored state,
  ADR 1100). New snapshot rows are V2. Other writers (importers, templates, sync, test harness,
  canvas conversion) still insert V1 rows with the column default 1; they insert new rows only, they
  never overwrite a row, so the column stays true.
- **Reads never trust the column over the bytes.** A whole-document state is self-describing: the V2
  encoder always writes a 0 feature-flag byte first, while a V1 whole-document update starts with
  the client count as a varuint, which is 0 only for the empty document `[0, 0]`. So "longer than 2
  bytes and first byte 0" is V2, everything else V1 (`wholeStateFormat`; tested with 1–300 clients,
  deletions and the empty document). Every reader goes through `applyStoredState` /
  `stateToBlocks` / `docFromStoredState` / `stateVectorOfStored`: block conversion, mention scan,
  canvas read, section reads, template walks, vault-sync revision (`encodeStateVectorFromUpdateV2`),
  export, public pages, agent reads, the indexer. Snapshot diffs are not self-describing (a V1 diff
  with no new structs also starts with 0), so snapshot rows are read by their `state_format`.
- **Gradual conversion, no batch.** Nothing runs at boot. When the collab layer loads a V1 row it
  also records the digest of the V2 encoding of the loaded document; the next store whose V2 bytes
  have that digest (the document did not change: a viewer closed the tab, a DirectConnection read)
  rewrites the row as V2 **with the same `updated_at`**, conditional on that stamp still being in
  `page_docs` (any other writer in between wins). It takes no snapshot, does not bump
  `pages.updated_at` and does not re-index; the section-index freshness record (ADR 1041), keyed by
  that stamp, stays valid. A changed document is written as V2 by the normal store. Pages nobody
  opens stay V1 forever, which is fine.
- **Files that leave the server stay V1.** Template trees (saved templates, template export/import)
  are a file format: their states are converted to V1 (`toV1`) when a template is saved.
  Duplicating a page copies bytes, format and state vector together.
- **Size threshold for "large page"** (ADRs 1043, 1103) counts V2 bytes × 1.46 so a page does not
  change class when its row is converted.
- `page_docs` gains `state_format smallint not null default 1` and `state_vector bytea` (nullable).
  No data migration: existing rows are V1 with format 1.

## Alternatives considered
- **A format column only, trusted by readers.** Every reader would have to select it, and a writer
  that forgets it (several are outside this change) would make a row unreadable. Sniffing the bytes
  cannot be wrong for whole states.
- **Batch conversion at boot or in a migration.** Decoding and re-encoding every state (≈ 200 ms for
  the 4.5 MB page) would delay boot on production by minutes and rewrite every row at once.
- **Convert on load.** Would write on every first open of every page, including reads by agents;
  the store that follows a load is already the natural, serialised write point.
- **Keep V1.** −29–32 % raw bytes (−48 % on disk after TOAST) on the largest rows and a cheaper
  store encode are measurable (PERFORMANCE.md); decode time is unchanged. The risk is limited to the
  reader paths, which are covered by tests.

## Consequences
- Tiny documents get 10–20 bytes larger (V2 has a fixed overhead); everything with content shrinks.
- A server older than this ADR cannot read V2 rows. Rolling back needs
  `apps/server/scripts/states-to-v1.ts` (stop the server, run it, then start the old version).
- Backups (`pg_dump`) and restores are byte copies and need nothing; restoring a new backup into an
  old version has the same rollback requirement.

## References
- apps/server/src/yState.ts, apps/server/src/yState.test.ts
- apps/server/src/collab.ts (`persistence`, `storeDocument`, `convertStoredState`)
- apps/server/src/md/convert.ts (`stateToBlocks`, `docToBlocks`), apps/server/src/notify/mentionScan.ts,
  apps/server/src/md/canvas.ts, apps/server/src/context/sectionSource.ts, apps/server/src/md/syncMd.ts,
  apps/server/src/templates/structure.ts, apps/server/src/routes/pages.ts (duplicate copy)
- apps/server/src/context/largePage.ts (`stateBytesV1Sql`), apps/server/src/db/schema.ts
- apps/server/src/snapshotChain.db.test.ts (legacy rows, conversion, every reader)
