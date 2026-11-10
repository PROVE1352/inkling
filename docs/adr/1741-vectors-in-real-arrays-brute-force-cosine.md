# 1741. Vectors in `real[]`, brute-force cosine from a per-workspace cache

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 1740 makes semantic search optional and rules out pgvector for 0.14. Without an index, every
query has to compare the query vector with every stored vector of the searched workspaces. Measured
on Postgres 16 (Docker, this repo's compose database), 5,000 vectors × 768 dims:

| Path | Time per query |
|---|---|
| SQL: `sum(a*b) FROM unnest(v.embedding, q)` over the rows | 360–420 ms |
| fetch the `real[]` rows into Node, then dot products | ~350 ms (wire + parse; the dot products are 5 ms) |
| vectors already in process memory (`Float32Array`), dot products only | ~5 ms |

## Decision
- **Storage:** table `page_chunk_vectors(page_id, text_hash, workspace_id, model, dims, embedding real[],
  updated_at)`, primary key `(page_id, text_hash)`, index `(workspace_id, updated_at)`, foreign keys to
  `pages` and `workspaces` with cascade (migration 0042). Vectors are L2-normalised at write time, so
  cosine similarity is a dot product. No foreign key to `page_chunks`: the section-index writer, which
  runs on every save, is not touched.
- **Query path:** per workspace, an in-process cache of normalised `Float32Array`s, loaded once and
  then incrementally (`updated_at` newer than the last load minus a 60 s overlap) whenever the indexer
  wrote vectors for that workspace (a process-local vector epoch). Deletions by the clean-up force a
  full reload. Only vectors of pages the person may see are scored (ADR 1743); the best ones are mapped
  back to current chunks by their text hash, so a vector of edited text is never returned.
- **Bound:** the caches share `EMBEDDING_CACHE_MB` (default 128 MB; a vector costs dims × 4 bytes plus
  ~160 bytes). Least recently used workspaces are dropped to make room; a workspace that does not fit
  on its own is scored in SQL instead (same visibility, ordered, `LIMIT 1000`). `EMBEDDING_CACHE_MB=0`
  scores every workspace in SQL.

Measured with the fake endpoint (ADR 1745), 1,000 sections → 2,667 chunks × 768 dims, one workspace:
first query after a change (cache load + query embedding) 182 ms; warm median 10.7 ms, p95 11.8 ms;
SQL path median 148 ms, p95 169 ms.

## Alternatives considered
- **SQL only.** No memory, but 0.4 s per query at 5,000 chunks and growing linearly; too slow for
  find_context's budget. Kept as the fallback for oversized workspaces.
- **`bytea` instead of `real[]`.** Faster to transfer, but opaque in SQL (no `unnest`, no fallback
  scoring, no inspection with psql). The cache makes transfer a one-time cost, so `real[]` stays.
- **A global cache keyed by page.** Per workspace matches the search scope and lets an oversized
  workspace fall back alone.

## Consequences
- Memory: 50,000 chunks × 1,024 dims ≈ 210 MB if all were cached; the default cap keeps ~30,000
  768-dim vectors. Larger instances raise the cap or accept SQL scoring for their largest workspaces.
- The ceiling is linear time per query: past ~50k chunks in one workspace even the cache path costs
  tens of milliseconds and the SQL path seconds. That is the point to move to pgvector (the memo's
  plan) behind the same entry point.
- The first query after the indexer wrote vectors in a workspace pays an incremental load (tens of
  milliseconds per thousand new vectors).
- The cache is per process, like the other in-process caches (ADR 0752, 1550).

## References
- docs/adr/1740-*, 1742-*, 1743-*, 1214-*
- `apps/server/src/context/semantic.ts`, `apps/server/src/db/schema-semantic.ts`, `apps/server/drizzle/0042_v014_semantic_vectors.sql`
