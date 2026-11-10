# 1924. Boot re-index of pages a crash left stale

- Status: Accepted
- Date: 2026-11-10

## Context
The docIndexer queues index passes in memory, 8–30 s behind the store (ADR 0750). A crash in that
window stores the new state but never indexes it, and nothing indexed it again until the page was
edited: find_context, search, backlinks, tags and tasks answered from the old state.
`page_chunk_index.indexed_at` cannot tell: it moves only when chunk rows change, and a pass for an
older state can finish after a newer store.

## Decision
- Migration 0047 adds `page_chunk_index.doc_updated_at`: the `page_docs.updated_at` of the stored
  state the last complete pass reflected. The pass writes it last, after the chunks, and only moves it
  forward. The migration fills it from `page_docs` for existing rows: the release before stopped
  gracefully and flushed its passes, so the first boot does not re-index the instance.
- At boot, 10 s after listen, a background pass re-indexes (full pass: links, text, tags, tasks,
  chunks, mentions) every page whose `page_docs.updated_at` differs from it, or, where it is null
  (written by an out-of-band path), is newer than `indexed_at`. One page at a time, 100 ms apart,
  at most 20,000 per boot; it re-reads the state and stamp right before each pass and skips pages
  with a pass queued or running. Shutdown stops it between pages.

## Alternatives considered
- **Persisting the queue**: a table write per store, and the queue is only a debounce of state
  already in `page_docs`.
- **Comparing with `indexed_at`**: re-indexes every page whose last store did not change its chunks,
  on every boot.

## References
- apps/server/src/staleIndex.ts, apps/server/src/docIndexer.ts, apps/server/drizzle/0047_v0151_index_stamp.sql
- apps/server/src/staleIndex.db.test.ts
