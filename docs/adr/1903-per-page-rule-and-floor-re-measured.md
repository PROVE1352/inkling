# 1903. find_context: per-page rule and relevance floor re-measured, kept at 1 / 0.7 / 0.6

- Status: Accepted (confirms 1211)
- Date: 2026-11-10

## Context
The 0.15 evaluation report read `pageCap 1`, decay 0.7 and the 0.6 relative floor as "a page's second
section is practically dropped" (it must reach 0.86 × the best score) and suggested revisiting them
after the slot rule of ADR 1900.

## Decision
Keep `DIVERSITY = { pageCap: 1, pageDecay: 0.7 }` and `FLOOR.relative = 0.6`. The field failure was the
wrong section in the slot, not the bar for the second one.

## Measured (dev, 45 questions, ADR 1909 corpus, every other 0.15.1 change on; `context-tune.ts`)
| rule | MRR | R@5 | nDCG@5 | P@5 (of shown) | answer in body | tokens/question |
|---|---|---|---|---|---|---|
| **cap 1, decay 0.7, floor 0.6** | **0.896** | **0.948** | **0.909** | **0.817** | **0.956** | **302** |
| decay 0.6 | 0.896 | 0.941 | 0.902 | 0.828 | 0.933 | 301 |
| decay 0.8 | 0.881 | 0.956 | 0.903 | 0.806 | 0.956 | 306 |
| decay 0.9 | 0.867 | 0.956 | 0.892 | 0.773 | 0.956 | 316 |
| cap 2, decay 0.5 | 0.874 | 0.948 | 0.892 | 0.743 | 0.956 | 307 |
| cap 2, decay 0.7 | 0.859 | 0.956 | 0.886 | 0.739 | 0.956 | 310 |
| floor 0.5 | 0.896 | 0.948 | 0.909 | 0.740 | 0.956 | 443 |
| floor 0.55 | 0.896 | 0.948 | 0.909 | 0.776 | 0.956 | 347 |
| floor 0.65 | 0.885 | 0.926 | 0.893 | 0.802 | 0.933 | 296 |
| floor 0.7 | 0.885 | 0.907 | 0.882 | 0.821 | 0.911 | 291 |
| decay 0.8, floor 0.65 | 0.885 | 0.926 | 0.893 | 0.799 | 0.933 | 297 |

A looser rule gains one question's recall (decay 0.8: R@5 +0.008) and loses MRR and precision; a lower
floor adds 45–141 tokens per question for nothing. The 1,000-token pass gives the same order.

## Consequences
"Also relevant" still lists a page's further sections; ADR 1900 decides which one is shown.

## References
- apps/server/src/context/rank.ts (`DIVERSITY`, `FLOOR`), apps/server/scripts/context-tune.ts
- docs/adr/1211-*, 1900-*, 1909-*
