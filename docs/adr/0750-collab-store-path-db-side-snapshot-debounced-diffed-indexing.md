# 0750. Collab store path: DB-side auto snapshot, serialised stores, debounced + diffed derived indexes

- Status: Accepted
- Date: 2026-11-07

## Context
Hocuspocus calls the `store` hook every 2 s of idle / at least every 10 s while someone types. Each call:
1. SELECTed the full previous `page_docs.state` into Node (only needed when an auto snapshot is due, i.e. at most once per 10 minutes),
2. upserted `page_docs` and updated `pages.updated_at` (2 round trips),
3. converted the whole Yjs state to BlockNote blocks and rewrote all four derived indexes (`page_links`, `page_texts`, `page_tags`, `page_tasks`) with delete+insert transactions — ~30 statements plus FK checks.

Measured with 1000 store calls on a ~300-block page (93 KB state, same machine, back-to-back runs):

| | before | after |
|---|---|---|
| SQL statements (pg_stat_statements, incl. FK checks) | 40,006 | 1,042 |
| DB execution time | 4.9–5.9 s | 0.8–1.3 s |
| wall time | 29.6–35.5 s | 4.7–6.3 s |
| Node CPU (user, incl. 1.5 s harness) | 10.7–11.6 s | 4.2–6.0 s |

The page_texts upsert alone cost 2.4 ms per call because every rewrite updates the GIN trigram index.

## Decision
- **Auto snapshot inside Postgres** (`snapshotStore.maybeAutoSnapshotStored`): one CTE decides "last snapshot older than 10 min?" and copies `page_docs.state` into `page_snapshots` server-side; the state never travels to Node. A bounded in-memory map (5,000 pages, LRU) of the last known snapshot time skips even that query while the throttle window is certainly open. A stale entry can only delay one auto snapshot by < 10 min.
- **One round trip for persistence**: `INSERT … ON CONFLICT … RETURNING` + `UPDATE pages` in a single CTE.
- **Stores of one document are serialised** (promise chain per document name) and re-encode the state from the live `Y.Doc` inside the chain. Hocuspocus only debounces timers; a DirectConnection store (debounce 0) could run concurrently with a client store and the one holding the older state could finish last and overwrite `page_docs`.
- **Derived indexes move to `docIndexer.ts`**:
  - debounced per page (trailing 8 s, at most 30 s behind), newest state wins, at most 200 pages pending (oldest flushed early beyond that);
  - immediate (and awaited) when the store came from a server DirectConnection (`socketId === 'server'`: REST, MCP, vault sync, snapshot restore) or when the last client left — REST callers keep "index is fresh when the request returns";
  - each index is rewritten only when its derived value changed (signature cache, 2,000 pages, 10-min TTL forcing a full rewrite to heal drift); typing therefore rewrites only `page_texts`;
  - runs per page are serialised; out-of-band reindexers (`routes/sync.ts`, `routes/tasks.ts`) call `forgetDocIndex`;
  - flushed on shutdown (`destroyCollab`).
- Every derived-index write bumps an in-process **index epoch** (`versions.ts`) that caches over index-backed data (query blocks, graph, due list) include in their keys, because indexes now trail `pages.updated_at` by the debounce.

## Alternatives considered
- Only raising the Hocuspocus debounce: fewer stores, but each still pays the full cost and unsaved edits stay in memory longer.
- Incremental/append-only Yjs update log instead of full-state rewrites: far less write volume (the remaining ~1.9 ms/store is postgres-js hex-encoding the 93 KB bytea), but needs compaction, a new table and migration of readers; deferred.
- Indexing in a worker thread: moves CPU off the event loop but not the DB churn; revisit if stateToBlocks (8 ms for 300 blocks) shows up in event-loop lag.

## Trade-offs
- Search/backlinks/tags/tasks for a page being typed in lag by up to 30 s (immediately consistent once the editor closes or for REST edits).
- Pending index work for up to 200 pages lives in memory (one state buffer each); a crash loses it — the next store of that page or the boot backfill does not re-index already-indexed pages, so a crash during typing can leave an index up to 30 s stale until the page is edited again.
- Single-process assumption, as for the rest of the in-memory state.
