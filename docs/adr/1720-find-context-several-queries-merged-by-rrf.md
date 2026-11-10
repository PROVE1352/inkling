# 1720. find_context queries=[…]: several phrasings merged by RRF under one budget, each section once

- Status: Accepted
- Date: 2026-11-10

## Context
Retrieval is lexical (ADR 0927, 1210): a section written in Korean is not found by an English question, and
"roll back" does not find "revert". The tool description already tells agents to retry with synonyms or the
other language, so an agent that is unsure asks two to five times. Every retry is a round trip and returns a
whole answer again: its own header, the same top sections, the same pointer lines, the same footer, and a full
budget of its own. The calls do not know about each other, so nothing is deduplicated.

## Decision
`find_context` takes `queries: string[]` (up to 5) next to `query`; `query` becomes optional (one of the two is
required). The effective list is `query` then `queries`, with repeats removed by the normalisation retrieval
itself uses (NFKC, lower case, collapsed spaces; `normalizeContextQuery`). At most 5 different queries; more is
refused with a message saying so. One query left → the single-query call, byte for byte (the tool sends the same
REST request and renders with the same function).

REST: `GET /api/context` accepts `q` repeated (`?q=a&q=b`). One distinct value answers exactly as before; two or
more answer with the merged result, which adds `queries: string[]` and `matched: string[]` on each fragment.

**Merging** (`context/multiQuery.ts`, pure, no database):
- Each query runs the ordinary retrieval with the caller's budget (through the cache, ADR 1721), so every
  per-query answer is exactly what a single call would return.
- Unit of ranking: a section (`pageId#anchor`). A query's ranked list is its fragments in order (a fragment with
  merged neighbour sections gives each its rank), then its "Also relevant" pointers.
- Reciprocal Rank Fusion, `score(s) = Σ 1/(k + rank)`, `k = 60`. Ties: first appearance (query order, then rank),
  then the key. Sums run in list order, so floats are reproducible.
- Text pieces are the per-query fragments, ordered by the best fused score of their sections. One budget is spent
  in that order with the single-query packing rules: a header estimate per fragment (`headerTokens` plus the
  `matched:` label), a piece that does not fit is cut (when at least 80 tokens are left for text) or becomes a
  pointer. The first query's text wins for a section several queries found (its cut is around its own words).
- Each section at most once: a piece whose sections are all shown is dropped; a piece that overlaps a shown piece
  only in part is not printed and its other sections stay pointers (no splitting of merged fragment text).
- "Also relevant": every section some list found but not shown, best fused first, 5 lines as for one query.
  Title-only pages: union in query order, 5.

**Output:** one header naming the queries by number (`6 result(s) for 3 queries (1 "roll back deployment",
2 "배포 되돌리기", 3 "revert release"), ~659/700 tokens`), one `<untrusted_content>` block, `; matched: 1,3` in
each fragment's paren line, one `Next:` line and one large-page hint. `can:`, review, ink and read counters are
computed once for the merged list of pages.

## Alternatives considered
- **Concatenate the per-query answers:** no saving beyond one round trip; duplicates and N budgets stay.
- **One retrieval with the union of the words:** a single OR query loses the per-phrasing ranking (idf of the
  union, one phrase bonus) and is K's ranking change, not a merge; the per-query answers could no longer be
  shared with single calls (ADR 1721).
- **Re-rank the per-query candidates (the 40-item ranked list) instead of packed fragments:** better recall below
  the packed set, but the ranked list is internal to `retrieve.ts` (only the benchmark `explain` hook exposes it),
  bypasses the cache, and `pack()`'s relative floor is calibrated for lexical scores, not 1/(k+r).
- **Score-based fusion (CombSUM over BM25-like scores):** scores of different queries are not on one scale
  (idf depends on the words); RRF needs only ranks and is what an extra list of another kind (ADR 1722) can join.
- **Guarantee each query's best fragment a place:** considered for the consensus effect below; in the measured
  case the crowded-out answer was at rank 6 of its query, so a top-1 guarantee would not have helped. Left out to
  keep the order pure RRF.

## Consequences
- Measured (docs/PERFORMANCE.md, `apps/server/scripts/multi-query-bench.ts`): 5 bundles of 3–5 phrasings over 10
  topic pages and 60 filler pages: 18 calls → 5, returned tokens −24% at the default budget and −38% at 1,200,
  answer sections shown 10/10 both ways.
- RRF favours consensus: a section that every phrasing finds weakly gains on one that only one phrasing finds
  below its top few. With filler made only of query words (worst case, `multi-query-bench.ts 1`) the "restore"
  bundle sometimes shows 1 of its 2 answer sections (the other is a pointer). docs/KNOWN-ISSUES.md.
- A bundle runs up to 5 retrievals (in parallel on the pool); per-query cache entries make repeated phrasings free.
- Tests: `apps/server/src/context/multiQuery.test.ts` (RRF, budget, dedupe, overlap, determinism, rendering),
  `apps/server/src/mcpTools/multiQuery.db.test.ts` (byte-identical single answer, bundle format, determinism,
  cache, permissions, refusals, REST, measurement).

## References
- apps/server/src/context/multiQuery.ts, apps/server/src/context/contextCache.ts (`cachedFindContextMulti`),
  apps/server/src/routes/context.ts (`GET /context`, `distinctQueries`), apps/server/src/mcpTools/contextTools.ts
  (`renderFindContext`, `find_context`), apps/server/src/mcp.ts (`SERVER_INSTRUCTIONS`)
- apps/server/src/mcpTools/multiQueryCorpus.ts, apps/server/scripts/multi-query-bench.ts
- ADR 0926 (token estimate), 0927, 1210–1212 (retrieval, packing, short anchors), 1543 (byte-stable output),
  1550 (cache), 1721, 1722
- Cormack, Clarke, Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods"
  (SIGIR 2009): k = 60
