# 1905. find_context query forms (English inflection, Korean double particles) and RRF k = 10

- Status: Accepted (amends the word groups of 1210/1700 and the merge constant of 1720)
- Date: 2026-11-10

## Context
The 0.15 evaluation listed three smaller points: an English query word in another form than the note
("deploys", "answering", "approved") finds nothing, because the prefix query matches "deploy" → deploys
but not the reverse; a Korean word with two particles ("회의에서는") was stripped once ("회의에서"),
which is not a prefix of the note's "회의"; and RRF k = 60 (ADR 1720), the value for many long lists,
makes rank 1 and rank 10 of a 15-entry list nearly equal (1/61 vs 1/70).

## Decision
- **English inflection** (`englishStem`, `QUERY_FORMS.enInflection`): a query word that ends in -ies
  (→ y), -sses/-shes/-ches/-xes/-zes (→ without es), -s (not -ss, -us, -is), -ed (not -eed, word ≥ 6)
  or -ing (word ≥ 7) also searches its stem as a prefix, in the same word group (one df, one coverage
  share, ADR 1210); a doubled final consonant is undone ("planned" → plan; ll/ss/ff/zz kept). Stems
  shorter than 3 letters are not used. The note side needs nothing.
- **Korean double particle** (`QUERY_FORMS.koDoubleParticle`): after the first strip, a stem of 3+
  characters is stripped once more with the same list and the same "two characters remain" rule:
  "회의에서는" → 회의에서 → 회의, "정리하기로" → 정리하기 → 정리. Both stems join the group.
- **RRF k = 10** (`RRF_K`).

## Measured
Dev (45 questions, ADR 1909 corpus), everything else of 0.15.1 on, feature off → on:
| change | MRR | R@5 | nDCG@5 | answer in body | tokens/question | note |
|---|---|---|---|---|---|---|
| enInflection | 0.874 → 0.896 | 0.926 → 0.948 | 0.887 → 0.909 | 0.933 → 0.956 | 303 → 302 | "reviewers answering pull requests" not shown → rank 1; no question lost |
| koDoubleParticle | 0.896 → 0.896 | same | same | same | 305 → 302 | the two dev questions passed before on their other words; kept: no question lost, fewer tokens |

False positives were the risk ("proceed" → proce:*, "indeed" → inde:*): -eed is excluded, and on dev no
question's first result changed for the worse. A stem is one more prefix in the same group, so a
collision raises that group's df (lowering its weight) rather than adding a new strong word.

RRF k, 5 bundles of 3–5 phrasings (`mcpTools/multiQueryCorpus.ts`, 10 topic + 60 filler pages; the 1720
measurement corpus, used here as dev), gold sections shown / MRR of the first gold / nDCG@5:
| filler | k = 60 | 30 | 15 | 10 | 5 |
|---|---|---|---|---|---|
| 20% query words, budget 3,500 and 1,200 | 10/10, 1.000, 0.923 | same | same | same | same |
| 100% query words (worst case), 3,500 | 9/10, 0.850, 0.759 | 9/10, 0.850, 0.759 | 9/10, 0.900, 0.800 | 9/10, 1.000, 0.845 | 9/10, 1.000, 0.845 |
| 100% query words, 1,200 | 9/10, 0.900, 0.800 | same | same | 9/10, 1.000, 0.845 | 9/10, 1.000, 0.845 |

The two dev bundles of the evaluation set (`cross-lang`) give the same result for every k (their tie is
rank 1 vs rank 1). 10 is the largest value with the gain. Smaller k favours one list's first entry over
agreement: with k = 10 a section that two phrasings both rank 12th ties with one phrasing's first
(2/22 = 1/11); with k = 5 already at rank 7 (2/12 = 1/6).

## Alternatives considered
- **A full English stemmer (Porter/Snowball)**: an algorithm to carry and test for small gains; Postgres's
  `english` config would need a second tsvector and a re-index.
- **Stripping particles repeatedly until nothing matches**: two passes cover the forms seen ("에서는",
  "에서도", "으로는", "하기로"); more passes start eating stems.
- **Keep k = 60**: no loss on normal bundles either; 10 is chosen for the worst case and for the
  semantic join (ADR 1723), where a list's first item should count.

## Consequences
- Cache keys of bundles change (`multi k=10`); entries are in process memory, so a restart clears them
  anyway.
- `queryTerms("deploys rollbacks")` = deploys, deploy, rollbacks, rollback.

## References
- apps/server/src/context/rank.ts (`QUERY_FORMS`, `englishStem`, `queryGroups`), multiQuery.ts (`RRF_K`)
- apps/server/src/context/rank0151.test.ts ("query forms …")
- docs/adr/1210-*, 1700-*, 1720-*, 1723-*, 1909-*
