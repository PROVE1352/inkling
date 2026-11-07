# 1211. find_context: at most two sections per page, the second only when it is nearly as good

- Status: Accepted
- Date: 2026-11-07

## Context
In the field report three of five results came from one long page (judging notes, one section per
judge). Every section of such a page repeats the page's vocabulary and its H1 heading path, so they
score alike and fill the budget; sections of other pages, and the pointer list, get nothing.

## Decision
- `pack` applies `diversify` to the relevant pool (after the floor and duplicate checks, before the
  knapsack): walking the pool best first, a page's first `pageCap` sections keep their score; each
  further section of the same page is multiplied by `pageDecay` once more. Parts of one section count
  once. Candidates that fall under the relevance floor this way are not dropped: they go to "Also
  relevant" with their original score.
- `DIVERSITY = { pageCap: 1, pageDecay: 0.7 }`. With the 0.6 relative floor this means: the second
  section of a page is shown only when it scores at least 0.86 × the best result; a third never
  (0.49 × its score < 0.6 × best). So the page limit is 2, as asked, and the second slot is earned.
  This is MMR (maximal marginal relevance) with "same page" as the similarity.

## Alternatives considered (dev questions, large corpus, ADR 1213; MRR / recall@5 / nDCG@5 / precision@5 of shown)
| rule | MRR | R@5 | nDCG@5 | P@5 |
|---|---|---|---|---|
| no limit | 0.825 | 0.897 | 0.843 | 0.707 |
| hard limit 3 | 0.833 | 0.931 | 0.861 | 0.734 |
| hard limit 2 (decay 0) | 0.862 | 0.920 | 0.874 | 0.748 |
| 2 at full score, then ×0.5 | 0.862 | 0.920 | 0.874 | 0.748 |
| 1 at full score, then ×0.8 | 0.856 | 0.931 | 0.878 | 0.777 |
| **1 at full score, then ×0.7** | **0.897** | **0.920** | **0.900** | **0.806** |
| 1 at full score, then ×0.6 | 0.897 | 0.908 | 0.889 | 0.823 |

(Measured during tuning with `scripts/context-tune.ts`: before the 30 extra contest notes were added to the corpus
and while `ts_rank` was still part of the coarse SQL order; removing it left the chosen row's numbers unchanged
(0.897 / 0.920 / 0.900 / 0.806 re-measured). The final numbers are in ADR 1213.)
- **MMR with term-overlap similarity** (Jaccard of matched query words between two chunks): needs a
  similarity per pair and a λ; "same page" captures the observed failure, is deterministic and O(n).
- **Hard limit 2**: lets a page take two slots whenever both pass the floor, which is what the field
  report complained about for long pages with similar sections.

## Trade-offs
- A question whose answer spans several sections of one page ("심사위원 증언": three judges on one
  page) shows two at most; the rest are listed under "Also relevant" with their anchors, one
  `read_page(section=…)` or `read_pages` away. Recall@5 for that question is capped at 2/3.
- Part of the MRR gain is a counting effect: two sections of one page are merged into one fragment in
  page order, so a better second section printed after a weaker first one ranked second.

## Consequences
"Also relevant" carries more pointers; it is grouped per page (ADR 1212) so this costs few tokens.

## References
- apps/server/src/context/rank.ts (`DIVERSITY`, `diversify`, `pack`)
- apps/server/src/context/context.test.ts ("diversify: …"), context.db.test.ts (field case: ≤ 2 per page)
