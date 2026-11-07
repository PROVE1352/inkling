# 0927. find_context: index probes, coverage ranking, top-k heap and fractional-knapsack packing

- Status: Accepted
- Date: 2026-11-07

## Context
Agents answered questions with `search` (substring of the whole query, unranked, often empty for a
natural-language question) followed by several whole-page reads. We want one call that returns the
right sections, within a token budget, with ids for a follow-up partial read or edit.

## Decision
- **Tool** `find_context(query, workspaceId?, budget?)` → `GET /api/context` (`routes/context.ts`).
  Without `workspaceId` it searches every live workspace the user belongs to in **one** query
  (`memberWorkspaceIds`), not one request per workspace.
- **Terms** (`rank.ts:64` `queryTerms`): NFKC, lower case, split on non-letters/digits, deduplicated,
  ≤ 8; English function words dropped when other terms exist; Korean terms also without a trailing
  particle. Terms contain only letters/digits, so the OR-of-prefixes tsquery
  (`'t1':* | 't2':*`) is built safely and passed as a bound parameter.
- **Candidates** (`retrieve.ts`): UNION of three index probes over `page_chunks` (ADR 0926):
  the stored `tsv` GIN (`@@` OR-prefix query), the trigram GIN on `text` for CJK terms of 3+
  characters (compound infixes), and page titles (title tsvector or ILIKE) → first 6 chunks of those
  pages. Permission filter in the same SQL: live page, `visibleTo` rule, workspace list = live
  memberships — nothing invisible is ever fetched, so no budget is spent on it.
- **Coarse SQL order**, then `LIMIT 300`: term coverage on the stored vector (+ title ILIKE) +
  `ts_rank` + a bonus for title (0.3) / infix (0.05) hits, tie-broken by `updated_at`, page id, ord.
- **Fine score in Node** (`scoreCandidate`): 0.5·coverage + 0.2·title coverage + 0.2·heading
  coverage + 0.1·rank + 0.15 phrase bonus + 0.05·recency (vs the newest candidate) ×0.7 for
  heading-only chunks. A size-40 binary **min-heap** (`TopK`) keeps the best: O(n log k).
- **Packing** (`pack`, `rank.ts:244`): drop candidates below max(0.2, 0.6 × best) and duplicate texts
  (copied pages); take the best chunk first, then by score per token (weight ≥ 60 so tiny chunks do
  not win by ratio); whole chunks while they fit (30-token header cost each), the next one **cut** to
  the remaining budget starting near its first term hit (fractional knapsack); merge consecutive
  chunks of one page into one fragment. Budget default 3,500, range 300–12,000 estimated tokens.
- **Output**: per fragment `[n] Title › Heading path`, `(page <id>; §anchor v=<version>[, …])`, text;
  then up to 5 "also relevant" pointers, title-only matches (folders, collections, empty pages) and a
  next-step line.

## Evaluation (numbers)
28 questions (English and Korean, `context/evalSet.ts`, fictional wiki of 25 pages), expected
section per question. "Before" = old tools with an oracle stop (search the question; if empty, each
term longest first; then read results in order until the expected page, ≤ 3 reads). "After" = one
find_context (+ one section read if only the page was pointed to). Tokens = `estimateTokens` (ADR 0926)
of the tool outputs. `scripts/context-bench.ts`, Postgres 16 in Docker on a laptop:

| corpus | flow | mean tok | median tok | calls | success | section@1 | section@3 |
|---|---|---|---|---|---|---|---|
| wiki only | before | 377 | 308 | 3.36 | 1.00 | – | – |
| wiki only | after | 135 | 121 | 1.00 | 1.00 | 1.00 | 1.00 |
| wiki padded to 1–2k tok/page + 5,000 distractor pages (15,310 chunks) | before | 2,254 | 1,910 | 3.68 | 0.75 | page@1 0.68 | – |
| same | after | 624 | 123 | 1.00 | 0.93 | 0.93 | 0.93 |

Latency on the 15k-chunk workspace (direct call, 3 × 28 queries): **p50 49 ms, p95 67 ms** (old
one-term search route: p50 3 ms — it does far less). The distractors reuse the wiki's vocabulary on
purpose; both misses are queries whose every term appears in hundreds of distractors. The [db]
test (`context.db.test.ts`) re-runs the padded wiki on every CI run and asserts success ≥ 0.9,
section@3 ≥ 0.85 and fewer tokens and calls than the old flow.

## Alternatives considered (measured and rejected)
- **Link-graph proximity boost** (+0.05 for pages linked to/from the top 3 pages, one `page_links`
  query): section@1 0.93 with and without it on the large corpus (four cross links added). No effect →
  removed from the code; revisit with real link-heavy data.
- **Relative floor 0.45**: mean 1,416 tokens vs 624 at 0.6 with identical success (0.93); 0.6 kept.
- **Trigram probe for every term ≥ 3 characters and ts_rank-only coarse order**: recall 0.75 on the
  large corpus (the right sections fell outside the 300-row cut) and p50 182 ms / p95 404 ms (ILIKE
  rechecks of thousands of rows). Coverage in the coarse order + trigram only for CJK: 0.93 and
  49/67 ms.
- **Expression index instead of a stored vector**: see ADR 0926.
- **BM25 / embeddings**: no extension or dependency available without changing the stack; the
  lexical ranker already meets the targets above.

## Trade-offs
- Lexical only: no synonyms, no cross-language matching (a Korean question does not find an
  English page). The tool description says to try other words or the other language.
- A query of only very common words fills the budget with weak matches; the floor limits it.
- 300 candidates is a hard cap; a term matching tens of thousands of chunks is ranked only on the
  coarse SQL score before the cut.

## How others solve it
RAG systems retrieve chunks by BM25 and/or embeddings, rerank, and "stuff" a context window with
greedy or knapsack packing (LlamaIndex response synthesizers, LangChain contextual compression);
Postgres-based search ranks with `ts_rank` and title boosts.

## Consequences
`find_context` is the first tool in the server instructions; `search` remains for substring needs.

## References
- apps/server/src/context/rank.ts:64, :111, :146, :244
- apps/server/src/context/retrieve.ts:63 (`findContext`)
- apps/server/src/routes/context.ts:214 (`GET /context`)
- apps/server/src/mcpTools/contextTools.ts:15 (`renderFindContext`)
- apps/server/src/context/evalSet.ts, evalRun.ts, context.db.test.ts; apps/server/scripts/context-bench.ts
