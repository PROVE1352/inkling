# 1745. Testing semantic search: a local fake endpoint, and "off" proven by counters

- Status: Accepted
- Date: 2026-11-10

## Context
Tests must not call a real embedding API (cost, keys, flakiness). The off-by-default promise
(ADR 1740) needs evidence, not only a code review.

## Decision
- `context/semanticTestServer.ts` (test only) serves `POST …/v1/embeddings` on 127.0.0.1 with
  deterministic bag-of-words vectors and a few cross-language synonyms, answers in reverse order with
  `index` fields, and can hang, fail with 500, 429 + `Retry-After`, 400 for chosen inputs, malformed
  JSON, or a 401 that echoes the presented key.
- **Off** is shown by counters and side effects: with no `EMBEDDING_*` variable, `semanticCandidates`
  returns null with zero fetches and zero database queries (`semanticStats`), the indexer starts no
  timer and logs nothing, the status has no `semantic` field, and find_context returns the same text
  byte for byte before any vector exists and after the table is full (DB test).
- Configuration is read lazily and can be reset (`resetSemanticConfigForTests`), so one test process
  covers off and on.

## Consequences
- The fake vectors only test plumbing, permissions and order stability; retrieval quality with a real
  model is measured at integration (dev/test split, ADR 1213).

## References
- docs/adr/0880-*, 1213-*, 1740-*–1744-*
- `apps/server/src/context/semantic.test.ts`, `apps/server/src/context/semantic.db.test.ts`
