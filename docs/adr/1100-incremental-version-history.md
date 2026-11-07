# 1100. Incremental version history: snapshot rows as Yjs diffs in short chains

- Status: Accepted
- Date: 2026-11-07

## Context
Every `page_snapshots` row held the whole document. On production the 4.5 MB "experiment log" had
50 rows = 171 MB raw (53 MB after TOAST compression), 93 % of all snapshot storage, although
consecutive versions of an append-only log differ by a few kilobytes. Each auto snapshot copied the
whole stored state inside Postgres (ADR 0750) and every restore, preview and compare read a whole
row.

## Decision
- **A row is a whole state or a diff.** New columns: `base_id` (null = whole state; else the row
  this one is the diff from), `depth` (rows to the whole state), `state_format` (1 = V1, 2 = V2;
  a diff is not self-describing, ADR 1101) and `state_vector` (of the document the row represents).
  A diff is `Y.encodeStateAsUpdateV2(doc, baseStateVector)` from a live document or
  `Y.diffUpdate[V2](storedState, baseStateVector)` from page_docs: the structs added since the base
  plus the whole delete set, so base chain + diff rebuilds the version exactly.
- **When a row is whole:** the first row of a page; every `SNAPSHOT_CHAIN_MAX` = 10th row of a chain
  (bounds rebuild work and the blast radius of a bad row); a diff larger than half of the chain's
  whole state (a full rewrite — storing it as a diff saves nothing and doubles rebuild work); and
  whenever a check fails: the base has no state vector (rows from before this ADR), the walk from
  the base does not reach a whole row, the new state does not contain the base's state vector, the
  diff does not cover exactly base → new (`parseUpdateMetaV2`: per client from = base clock, to =
  new clock), or a read found this page's chain broken. Writes and pruning of one page are serialised
  by `pg_advisory_xact_lock(hashtext('page-snapshots:' || page))`; the base is always the newest row.
- **Reading** (preview, compare, restore, rebase): one recursive query fetches the chain, the rows are
  applied in order to a fresh `Y.Doc`, and the result is verified: the chain ends at a whole row and
  `encodeStateVector(doc)` equals the row's recorded state vector (pending structs are allowed: a live
  document can hold an update whose dependency never arrived, its encodings include it, and such a
  document is always stored whole). Any
  failure → `409 SNAPSHOT_UNAVAILABLE` ("This version can no longer be read"), logged, and the page's
  next snapshot is written whole. Restore checks before it writes anything (no "Before restore" row,
  page untouched).
- **The 50-row cap** still deletes the oldest rows. A kept row whose base is deleted is rebuilt
  (the chain is still complete inside the transaction), stored whole (V2) and the depths of rows
  built on it are recomputed. With one row added per snapshot this happens on most prunes once a
  page is at the cap: one rebuild + encode of the oldest version (measured below).
- **Auto snapshots** still capture the version *before* a store, and the throttle is still decided
  in Postgres without reading the state. Only a snapshot that is due ships the stored state to Node
  (to diff it); `page_docs.state_vector` (written by the store, ADR 1101) spares the struct parse
  for the state vector.
- **Sources:** manual, "Before restore", "Before AI edit" and "AI edit" snapshots take the live
  document when it is open (cheapest: the diff is encoded from it directly) and the stored row
  otherwise (`currentSnapshotSource`). Legacy rows are read as they are (whole V1, no state vector).
- `SnapshotDTO.bytes` stays `octet_length(state)`: what the row stores. A diff row shows a small
  number; the version list therefore shows storage, not document size.

## Measurements
docs/PERFORMANCE.md: "Version history storage" (−91.3 % raw, −93.6 % on disk for 50 versions),
"Version preview / compare / restore" (no measurable change; rebuilding a depth-9 version costs no
more than applying one whole V1 state) and, under Regressions, "Due auto snapshot" (p50 ≈ 5 → 55–88 ms,
event loop max ≈ 3 → 42–75 ms on the 4.5 MB page at the cap, once per ≥ 10 minutes of editing)
(`apps/server/scripts/snapshot-chain-bench.ts`: the production copy replayed as 50 appends with an
auto snapshot before each store).

## Alternatives considered
- **Reverse diffs (newest whole, older ones as diffs back).** Yjs cannot express "undo these
  structs": an older state is not a subset operation on a newer one once items were deleted and
  garbage-collected.
- **Keep older chain rows past the cap instead of rebasing** (prune whole chains only). Avoids the
  rebuild per prune but leaves up to 9 hidden rows per page and makes "50 versions" untrue in
  storage; the rebuild costs one decode + encode of the oldest version per snapshot at the cap.
- **`Y.mergeUpdatesV2` for rebasing** (no decode). Measured 150 ms on the 4.5 MB state, about the
  same as a rebuild, and the merged row keeps content the diff deleted (not garbage-collected).
- **Snapshot the state after the store instead of before.** The diff would come from the live doc
  for free, but the version list would lose "the state before this burst of edits", the version
  people restore to.

## Consequences
- A version is rebuilt from up to 10 rows: the whole row plus ≤ 9 small diffs.
- One corrupted or missing row makes the rows built on it unreadable (≤ 9 rows, until the next
  whole row); they answer 409 and drop off at the cap. Before, a corrupted row affected only itself.
- Older servers cannot read diff rows: rolling back past this ADR needs
  `apps/server/scripts/states-to-v1.ts` first (rewrites every row whole and V1).
- `page_snapshots` gains four columns; existing rows keep the defaults (whole, V1, depth 0, no
  state vector) and need no data migration.

## References
- apps/server/src/snapshotStore.ts (`createSnapshot`, `snapshotDoc`, `snapshotBlocks`,
  `pruneSnapshots`, `maybeAutoSnapshotStored`, `currentSnapshotSource`)
- apps/server/src/routes/snapshots.ts, apps/server/src/routes/activity.ts (version compare),
  apps/server/src/routes/context.ts, apps/server/src/routes/pageContent.ts
- apps/server/src/snapshotChain.db.test.ts
- apps/server/scripts/snapshot-chain-bench.ts, apps/server/scripts/states-to-v1.ts
- ADR 0750 (auto snapshot in Postgres), ADR 0936 (agent snapshots), ADR 1101 (V2 storage)
