# 1214. Semantic (hybrid) retrieval for find_context: design memo, not built

- Status: Proposed (deferred; optional feature for a later release)
- Date: 2026-11-07

## Context
ADR 1210 makes lexical ranking weigh rare words and adjacent query words. Some misses remain that no
lexical signal fixes: on the restored production copy "우리 팀 체크리스트" does not contain the query
words next to each other, and a Korean question never finds an English page (ADR 0927). Embeddings find
"the team checklist" for "팀 구성". This memo records how it would fit, so the lexical work does not
block it.

## Sketch
- **Storage**: `pgvector` (`vector(n)` column on `page_chunks` or a side table `page_chunk_vectors(page_id,
  ord, model, embedding)` so models can change without rewriting chunks) and an HNSW index
  (`vector_cosine_ops`). Needs the extension in the Postgres image (`pgvector/pgvector:pg16`) — a
  deployment change for every self-hoster, hence opt-in.
- **Embedding provider**, chosen by the operator: an OpenAI-compatible HTTP endpoint (hosted, or a local
  server such as Ollama / text-embeddings-inference with a multilingual model like bge-m3 or
  multilingual-e5). Off by default: chunk text leaves the server for a hosted provider, which must be an
  explicit choice. No new npm dependency (fetch + JSON).
- **Indexing**: the chunk writer (`reindexPageChunks`) only marks changed rows (hash already known); a
  background job embeds them in batches with the existing backfill pattern (50 per batch, yields) and
  stores model + dimension. Stale vectors are ignored, not served.
- **Query**: one embedding of the query (cached per query text), top-k by cosine inside the same
  permission filter as the lexical query (the `visibleSql`/range conditions, never a separate path).
- **Fusion**: Reciprocal Rank Fusion, score(d) = Σ_lists 1 / (60 + rank_list(d)), over the lexical list
  (ADR 1210 order) and the vector list; then the existing per-page rule, floor and packing. RRF needs no
  score calibration between BM25 and cosine and is deterministic for fixed inputs (ties by page id, ord).
- **Determinism (ADR 0937)**: same model + same documents → same vectors → same order; a model change is
  a re-embed, recorded like CHUNKER_VERSION.
- **Evaluation**: the dev/test split of ADR 1213 plus cross-language questions; adopt only if test
  improves and p95 stays within budget.

## Why not now
New extension in the database image, a model to run or a third party to send notes to, and a backfill
for every page — none of which a lexical fix needs. The lexical numbers of ADR 1213 meet the field
report except for the case above.

## References
- docs/adr/0926-*, 0927-*, 1210-*, 1213-*
