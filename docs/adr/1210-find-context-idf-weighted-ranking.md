# 1210. find_context ranking: idf-weighted BM25, adjacency of query words, Korean word groups

- Status: Accepted (amends the scoring part of 0927)
- Date: 2026-11-07

## Context
After 0.6 a member asked find_context for "서울 AI 해커톤 팀 구성" (budget 1,500). All five results came
from another workspace's judging notes and voting strategy; the two sections that answer the question
did not appear. The ranker of ADR 0927 counted every query word the same: coverage = matched words / all
words, plus `ts_rank`. "서울", "AI" and "해커톤" occur in hundreds of chunks of that workspace, so a chunk
with those three beat a chunk with "팀 구성". There was no notion of how informative a word is, no credit
for query words that stand next to each other, and the 300-row coarse SQL cut used the same unweighted
coverage, so the right rows could be dropped before Node ever scored them.

## Decision
- **Word groups** (`rank.ts` `queryGroups`). A query word and its stripped Korean form are one group:
  "백업을" → {백업을, 백업}; a chunk with either counts once, and the group's document frequency is that
  of either form. The strip list now also has verb endings ("결정된" → 결정, "구성하는" → 구성,
  "하려면", "했다", "한다", "하기", "되는", "된다", "된", "한", "할"). Words of two characters are
  never stripped (회의, 평가, 휴가 end in particle-like syllables; "팀을" stays "팀을"). One-character
  Korean words ("팀") stay as they are: the prefix query on the stored vector finds 팀, 팀원, 팀장; no
  trigram probe exists for them (it would be a full scan, ADR 0927).
- **Document frequency in the same query** (`retrieve.ts`). The candidate CTE already reads every chunk
  that contains any query word in the searched workspaces. A `matched` CTE turns that set into one
  0/1 flag per group (stored vector `@@` the group's prefixes, plus the infix ILIKE for 3+ character
  Korean forms) and one heading flag; `df` sums the flags, `scope` counts the chunks of the searched
  workspaces (btree index-only scan). Because every chunk containing a word is in the candidate set,
  df is exact for the searched workspaces, not an estimate from the top 300. No new table, index or
  migration.
- **idf** = ln(1 + (N − df + 0.5) / (df + 0.5)) (Lucene's BM25 idf, always > 0). A word that no
  chunk contains (df = 0) gets a fixed weight 0.5 (`UNSEEN_WEIGHT`): otherwise it is the "rarest" word
  and its weight sinks every score under the relevance floor ("how do I roll back a **bad** deploy"
  returned nothing in the first version).
- **Coarse SQL order** (before `LIMIT 300`): Σ idfᵢ·(found in text or title + 0.3·in title +
  0.3·in heading path) / Σ idfᵢ, plus the infix bonus. Only integer flags and the per-query weights
  (a materialized one-row CTE): no tsvector is read in the sort. `ts_rank` was dropped from it (same
  dev numbers; together with computing the weights once, p50 60 → 41 ms in that run); the heading flag
  stays (without it "인덱스 정리" fell out of the cut: dev recall@5 0.920 → 0.885).
- **Fine score in Node** (`scoreParts`, weights in `WEIGHTS`, all shares are idf-weighted):
  0.40·coverage + 0.25·BM25 + 0.15·title + 0.20·heading path + 0.15·adjacency + 0.10·phrase
  + 0.03·recency, heading-only chunks ×0.7.
  - BM25 per group: idf · tf(k1+1) / (tf + k1(1 − b + b·dl/pivot)), divided by (k1+1) and by Σ idf so
    it lies in [0, 1). k1 = 1.2, b = 0.75, pivot = 250 estimated tokens. tf counts occurrences in title
    + heading path + text the way the index matches them (anywhere for Korean of 2+ characters,
    at a word start otherwise).
  - Adjacency: for each pair of consecutive query words, 1 if some occurrence of the second starts at
    most 3 characters after the first ends ("팀 구성", "팀의 구성", "팀구성"); pairs are weighted by the
    larger idf of the two (a phrase is at least as rare as its rarer word).
- **Permission SQL unchanged.** The `ranked` CTE keeps `WHERE p.deleted_at IS NULL AND visibleSql(...)`
  and `memberWorkspaceIds`/`visibleSql` are untouched; `ranked` now joins `pages` on the matched rows
  directly instead of through `page_chunks` again.
- **Determinism (ADR 0937).** The pivot is a constant, not the scope's mean chunk length, so an edit
  that adds no chunk and no occurrence of a query word leaves every score unchanged; the determinism
  test now includes the field query and still passes after the unrelated edit. An edit that does add a
  query word or a chunk changes N or df and may change the order — the same documents still give the
  same bytes.

## Where df comes from (trade-off)
| source | accuracy | cost | chosen |
|---|---|---|---|
| top-300 candidates only | biased: the cut already favours common-word rows | free | no |
| all candidate rows in the searched workspaces (this ADR) | exact for the scope searched | one flag per group per candidate row (~10–15 ms at 4.5k rows); one count of the scope | **yes** |
| whole index (all workspaces) | stable across scopes, but a word common in someone else's workspace would weigh little in yours, and it touches rows the user cannot see | full GIN probe per word | no |
| precomputed term table (`term`, `df`) | exact, O(1) per word | new table, a writer on every reindex, migration, prefix/infix semantics to replicate | no (revisit if the scan cost grows) |

df and N are workspace statistics and are not filtered by page visibility (a private page of another
member counts toward df). They only weigh words; no row of an invisible page is returned, and joining
`pages` to filter them would have meant touching the permission SQL (and a full join of the scope).

## Alternatives considered (measured on the dev questions, ADR 1213)
- k1 = 2 or b = 0: dev MRR 0.845 vs 0.862 at the time (b = 0.5 equal to 0.75). Kept 1.2 / 0.75.
- Adjacency weight 0.3 or 0.5 instead of 0.15: identical, resp. +0.018 precision only. Kept 0.15.
- Pair weight = mean idf: the common pair "서울 AI" weighed as much as "팀 구성". Max idf is the bound
  a phrase must satisfy. Sum (independence) was considered for the real-data case below and not tried
  on test data.
- `ts_rank` kept in the coarse order (with per-row weights): no dev change, p50 60 vs 41 ms (larger
  table at the time).
- Mean chunk length as the BM25 pivot: makes every score depend on every edit in the scope.
- An idf cap: not needed once df = 0 words are neutralised; the remaining case where a rare generic
  word wins is listed below.
- Stripping 1-character particles from 2-character words: makes "가을" match every word starting with 가.

## Trade-offs
- A rare but incidental word can dominate. Dev question "검색 지연 개선" (expected: the 10-12 retro,
  which says 지연 but not 개선) now ranks the 10-05 retro first because "개선" occurs in 2 of 15,693
  chunks. Both retros are about search speed; the label is debatable, the effect is what idf does.
- idf needs the common words to be common. On the 32-page wiki alone "서울/AI/해커톤" were in 7% of
  chunks and the field query still failed; the evaluation corpus therefore has 30 other contest pages
  (ADR 1213), as the reporting user's notes did.
- Latency: p50 26.6 → 35.3 ms, p95 63.3 → 88.7 ms on a 15,693-chunk workspace (interleaved A/B, same
  data). The `matched` flags and the heading ILIKE are the cost.
- On a restored copy of the production backup (numbers only, ADR 1213) the "결정된 것" section rose from
  not shown to rank 5; "우리 팀 체크리스트" is still not shown (score 0.29 vs a floor of 0.42): there
  "구성" is not rare (df 596 of 4,680 chunks), the section is long (425 tokens) and the two words are
  not adjacent. Lexical ranking cannot see that it is the team checklist; see ADR 1214. Two possible
  lexical follow-ups were noted, not built: the workspace name as a context field (one of the two target
  workspaces has 3 of the 5 query words in its name) and phrase weights from pair co-occurrence.

## How others solve it
Lucene/Elasticsearch BM25 with `idf = ln(1 + (N − df + 0.5)/(df + 0.5))` and per-field boosts (BM25F);
proximity via sloppy phrase queries or term-pair features (BM25TP); Postgres users either rank with
`ts_rank` (no idf) or add an extension (ParadeDB `pg_search`, VectorChord-bm25) or a term-statistics table.

## Consequences
- `Candidate.rank` (ts_rank) is gone; `scoreCandidate` takes word groups and their idf.
- `scripts/context-explain.ts` prints df/idf and the top candidates of one query; `scripts/context-tune.ts`
  runs weight variants on the dev questions.

## References
- apps/server/src/context/rank.ts (`queryGroups`, `idf`, `occurrences`, `scoreParts`, `BM25`, `WEIGHTS`)
- apps/server/src/context/retrieve.ts (`matched`, `df`, `scope`, `w` CTEs)
- apps/server/src/context/context.test.ts ("idf: a rare word outweighs …", "adjacent query words …")
- docs/adr/1211-*, 1212-*, 1213-*, 1214-*
