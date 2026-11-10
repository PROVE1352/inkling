# 1900. find_context: a line of links or a title-only match does not take its page's slot

- Status: Accepted (amends the per-page rule of 1211)
- Date: 2026-11-10

## Context
A member asked "<idea> 폐기 이유" at a small budget. The third ruling's page (title "… 3심 폐기") starts
with a one-line `_intro` that is only links (`← [[… 2심 판결]] · [기록](https://…)`, 24–40 tokens), then
the ruling. The ranking put that link line first on its page: every chunk of a page carries the title in
its tf (BM25F, ADR 1210), the title says 폐기, and a 24-token chunk gets a near-maximal length
normalisation. The ruling became the page's second section; with `pageCap 1`, decay 0.7 and the 0.6
relative floor (ADR 1211) a second section must score ≥ 0.86 × the best result, so it was a pointer, and
the rest of the budget went to the first ruling of another page. Reproduced on the evaluation corpus
(`context-explain.ts`, baseline 0.15): 1심 판결문 0.727, 3심 `_intro` 0.636, 3심 판결문 0.623 → shown
1심 판결문, 3심 `_intro`, 2심 `_intro`; the answer not shown.

## Decision
Two rules in `rank.ts`, both decided per chunk from its own text:

- **Thin chunk** (`SECTION_RULES.thinLetters = 8`): a chunk whose prose — the text without wiki links,
  Markdown links (label and target) and bare URLs — has fewer than 8 letters or digits is scored like a
  heading-only chunk (× 0.7, the existing "little to read" factor) and is `weak`. A link line has 0;
  the shortest real answer in the evaluation set ("매주 화요일 오전 10시에 30분 동안 모인다.") has 19.
- **Representative of a page** (`SECTION_RULES.representative`): `Scored.weak` is set when the chunk is
  thin or none of the query words occur in its own heading path or prose (the match is through the page
  title, or only in link labels). In `diversify` a page's slots go to its non-weak sections first, best
  first, then to weak ones; a section is weak only when every part of it in the pool is. A page whose
  matching sections are all weak keeps its best one as before.

`own` (the idf-weighted share of query words in the heading path or prose) is a new field of
`scoreParts`; it is not part of the score.

## Measured (dev, ADR 1909 corpus; `scripts/context-tune.ts`)
| rule set (the other 0.15.1 changes on) | MRR | R@5 | nDCG@5 | answer in body |
|---|---|---|---|---|
| neither | 0.885 | 0.926 | 0.895 | 0.933 |
| thin only | 0.896 | 0.948 | 0.909 | 0.956 |
| representative only | 0.893 | 0.948 | 0.906 | 0.956 |
| both (chosen) | 0.896 | 0.948 | 0.909 | 0.956 |

(0.15 itself: 0.841 / 0.881 / 0.850 / 0.889. Each rule alone fixes the field case; both are kept because
they cover different shapes: a thin chunk whose link label repeats the query, and a long section that
matches only through the title.)
`thinLetters` 4, 8 and 16 give the same dev numbers; 30 loses MRR (0.896 → 0.885) by demoting short
real answers.

## Alternatives considered
- **Drop `_intro` sections from ranking**: an intro is often the answer (a page's summary line).
- **Replace the weak section by the page's best non-weak one and give it the weak one's score**: makes the
  printed score of a section depend on a sibling; the slot order gives the same output on the evaluation
  set without that coupling.
- **Remove the title from tf** (no BM25F): changes every ranking (ADR 1210 measured the title field as
  useful) to fix a slot rule.
- **Lower the 0.86 bar (decay 0.8, floor 0.55)**: re-measured in ADR 1903; the slot, not the bar, was the
  problem.

## Consequences
- The field case: the 3심 ruling is shown (rank 2 after the 1심 ruling, which says 폐기 and 이유 itself);
  the link line is a pointer.
- A heading-only section that names the query is weak too (it is thin): a sibling with text wins the
  slot. Unchanged on dev.

## References
- apps/server/src/context/rank.ts (`SECTION_RULES`, `proseText`, `proseLetters`, `scoreParts` own/weak, `diversify`)
- apps/server/src/context/retrieve.ts (`weak` on `Scored`)
- apps/server/src/context/rank0151.test.ts; evalSet.ts (`FIELD_PAGES`, family `thin-intro`)
- docs/adr/1211-*, 1903-*, 1909-*
