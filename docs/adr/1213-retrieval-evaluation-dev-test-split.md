# 1213. Retrieval evaluation: dev/test split, rank metrics, the field failure as data

- Status: Accepted (extends the evaluation of 0927)
- Date: 2026-11-07

## Context
ADR 0927 evaluated find_context with 28 questions and section@1/@3. Every weight was set on those same
questions, so the numbers could not show over-fitting, and none of them had the failure later reported
from the field (common words + one rare key phrase; one page filling the results).

## Decision
- **Corpus** (`context/evalSet.ts`, all fictional): the 25-page wiki of ADR 0927; 7 contest/offsite
  pages (`CONTEST_PAGES`) with H1 › H2 › H3 headings, a long page of similar sections (judges'
  notes), a voting-strategy page, the two pages that hold the answers to "서울 AI 해커톤 팀 구성", and
  an English analogue ("Lumen offsite 2026 team building budget"); 30 generated contest notes
  (`contestNoisePages`) that repeat 서울/AI/해커톤/팀 and never say 구성. The benchmark pads pages to
  1–2k tokens and adds 5,000 distractor pages whose vocabulary now includes those common words.
- **47 questions** (`EVAL_QUESTIONS`): the 28 of ADR 0927 (every third one held out) and 19 new
  (10 dev, 9 test), 25 of 47 in Korean. A question may name several relevant sections (`also`).
  **dev = 29** questions for tuning, **test = 18** held out. `context-bench.ts` prints test numbers only
  with `--final`; `context-tune.ts` reads dev questions only.
- **Metrics** over the sections a call shows, in order (fragment order, then sections within a merged
  fragment), default budget, binary relevance (`evalRun.ts` `scoreRanking`):
  MRR = mean 1/rank of the first relevant section (0 if none shown);
  recall@5 = relevant sections in the first five / all relevant;
  nDCG@5 = Σ rel_i / log2(i + 1) over the first five, divided by the same sum for the ideal order;
  precision@5 = relevant in the first five / number shown in the first five (0 if nothing shown) —
  a budget-packed tool may show fewer than five and showing less noise is the goal — and, for
  comparison with the textbook definition, P@5 = relevant in the first five / 5 (at most 0.2 to 0.6
  here, since questions have one to three relevant sections).

## Results (padded wiki + contest pages + 5,000 distractors, 15,693 chunks)
| split | n | | MRR | recall@5 | nDCG@5 | precision@5 (of shown) | P@5 (÷5) |
|---|---|---|---|---|---|---|---|
| dev | 29 | before | 0.848 | 0.897 | 0.858 | 0.648 | 0.193 |
| dev | 29 | after | 0.897 | 0.920 | 0.900 | 0.806 | 0.200 |
| test | 18 | before | 0.806 | 0.861 | 0.819 | 0.702 | 0.200 |
| test | 18 | after | 0.944 | 0.926 | 0.931 | 0.926 | 0.211 |

Unpadded set (62 pages, no distractors): dev MRR 0.845 → 0.948, recall@5 0.931 → 0.954, nDCG@5
0.863 → 0.947, precision 0.704 → 0.885; test MRR 0.819 → 1.000, recall@5 0.917 → 0.981, nDCG@5
0.848 → 0.987, precision 0.716 → 0.981.

**Over-fitting**: after the change test ≥ dev on every metric (MRR 0.944 vs 0.897), and the gain on
test (+0.138 MRR) is larger than on dev (+0.049), so the weights do not look fitted to dev. With 18
test questions one question moves MRR by up to 0.056, so the gap itself is noise-sized. Disclosure: the
[db] test logs both splits; test numbers of the padded corpus without distractors were seen once after
the weights were fixed, and the 30 contest notes were added afterwards to make the field query's common
words common (no weight changed after that).

Remaining misses (large set): dev "how do I roll back a bad deploy" (also missed before: 206 of the 5,000
distractor pages are titled "Note N rollback"), "검색 지연 개선" (rank 1 before; see ADR 1210 trade-offs), "서울 AI
해커톤 팀 구성" and "Lumen offsite 2026 team building budget" at rank 2 (before: not shown / rank 12);
test "alert threshold error rate" (also missed before).

## Real data (optional check)
A pg_dump of production was restored into a local scratch database (schema brought up to the tree with
migrate + push), the field query was run with the old and the new code as its author, and only counts
were recorded; the copy was dropped afterwards. Budget 1,500: before, neither answer section shown, 3 of
5 results from one page, output 2,511 tokens; after, "결정된 것" at rank 5 of 6, "우리 팀 체크리스트"
not shown, at most one section per page, output 1,611 tokens. Budget 3,500: before 7 sections from one
page, neither shown; after "결정된 것" rank 5, at most 2 per page. Not used for tuning.

## Alternatives considered
- k-fold cross-validation: 47 questions and a handful of weights; a fixed held-out split is simpler to
  keep honest in a script.
- Graded relevance: one expected section per question was the existing format; `also` adds the other
  correct sections with the same grade.

## References
- apps/server/src/context/evalSet.ts, evalRun.ts (`scoreRanking`, `runRankEval`)
- apps/server/scripts/context-bench.ts (`--final`), context-tune.ts, context-explain.ts
- apps/server/src/context/context.db.test.ts ("rank metrics (dev/test) and the field case …")
