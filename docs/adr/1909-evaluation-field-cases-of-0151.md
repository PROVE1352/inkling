# 1909. Retrieval evaluation: the 0.15.1 field cases, answer-in-body and tokens per question, 0.15.1 numbers

- Status: Accepted (extends 1213, 1702)
- Date: 2026-11-10

## Context
Two failures were reported from a production server after 0.15: a one-line `_intro` of links taking a
page's slot (ADR 1900) and a long table whose URLs matched the query filling a small budget (ADR 1901,
1902). Both happened at small budgets, and the second one with an English question on Korean notes.
The evaluation of ADR 1213/1702 asks every question at the default budget, one query at a time, and
scores the anchors named in headers only — a cut fragment that kept its header but lost the answer
line counted as found.

## Decision
- **Fictional pages with the same structure** (`FIELD_PAGES` in `evalSet.ts`): two ideas with three
  ruling pages each (1심/2심/3심; a link-only `_intro`, then `# 판결문`; the 3심 title says 폐기, its ruling
  explains without the words 폐기/이유, the 1심 ruling mentions both), and two Korean contest logs (an
  English contest name in the intro, a 22-row submissions table with a `score` column and links under
  `…/solar-forecast/submissions/…`, a short "최고 기록" section).
- **16 questions** (`FIELD_QUESTIONS`), each family in both splits: `thin-intro` (budget 800),
  `url-table` (budget 700), `cross-lang` (asked as `queries=[English, Korean]`), `en-inflection`,
  `ko-double`. `EvalQuestion` gains `queries`, `budget` and `evidence`. Total **78 questions: dev 45,
  test 33**; the old questions keep their split.
- **Metrics** (`evalRun.ts`): besides MRR, recall@5, nDCG@5 and precision@5 (ADR 1213): **answer in
  body** — the question's evidence text (explicit, or the first 16 characters of the expected section's
  first line) occurs in the data block before "Also relevant"; **tokens per question** — `estimateTokens`
  of the whole tool output. `context-bench.ts` also runs every question at a budget of 1,000.
- **Protocol** (as 1702): baseline = HEAD 771e6cc (0.15.0) from `git archive` with only the new
  evaluation files and bench script copied in, one `--final` run on the migrated scratch database; the
  new questions were checked to fail on the baseline (dev lines only) before any ranking change; tuning
  on dev only with `context-tune.ts` (every knob of ADR 1900–1905 can be switched there; all off
  reproduces the baseline's dev numbers exactly); constants frozen; one `--final` run of the result.
  Page ids are parsed at 8–36 characters and compared by prefix (ADR 1906).
- **Disclosure**: after that run three things changed and the final run was repeated (the numbers here
  are from the repeat; rank metrics on the bench corpus did not move): the weak-answer hint threshold
  (ADR 1904; decided while reading the outputs of all 74 single-query questions, dev and test — it
  prints outside the data block and changes no rank metric), `can:` in the header only for two or more
  results (ADR 1906), and `PACKING.minWeight` 60 → 80 (ADR 1902), found because the [db] suite's dev
  field query failed on its corpus and tuned on dev only.

## Results (padded wiki + contest + partial-match + field pages + 5,000 distractors, 15,806 chunks)
Each question at its own budget (default 3,500):
| split | n | | MRR | recall@5 | nDCG@5 | precision@5 (of shown) | answer in body | tokens/question |
|---|---|---|---|---|---|---|---|---|
| dev | 45 | 0.15 | 0.841 | 0.881 | 0.850 | 0.761 | 0.889 | 361.6 |
| dev | 45 | 0.15.1 | 0.896 | 0.948 | 0.909 | 0.817 | 0.956 | 317.6 |
| test | 33 | 0.15 | 0.879 | 0.899 | 0.876 | 0.821 | 0.909 | 399.1 |
| test | 33 | 0.15.1 | 0.909 | 0.960 | 0.914 | 0.842 | 0.970 | 290.2 |

All questions at a budget of 1,000: dev answer in body 0.889 → 0.956, tokens 252.6 → 213.5; test
0.909 → 0.970, 250.7 → 220.5 (rank metrics as above). Unpadded set (no distractors): dev MRR 0.863 →
0.930, recall@5 0.915 → 0.981, answer in body 0.933 → 1.000, tokens 251.8 → 211.4; test MRR 0.894 →
0.924, recall@5 0.929 → 0.990, answer in body 0.939 → 1.000, tokens 189.5 → 189.9. The [db] suite's corpus
(padded, no distractors) logs dev MRR 0.930, recall@5 0.993, answer in body 1.0; test 0.924 / 0.990 / 1.0.

Tokens per question: −12.2% (dev) and −27.3% (test) at the questions' own budgets, −15.5% / −12.0% at
1,000. Of this, the output format alone (ADR 1906/1907, ranking switched back to 0.15) is −4.2% at the
default budget (the two header lines per result −25.7%); the rest is ranking that shows fewer wrong
sections (the URL table) and cuts large ones. At a filled budget (1,500, floor off) the same budget carries
+19.0% section text (700.9 → 834.1 tokens) and −9.3% other tokens.

Per family (large set; n = 1–3, one question moves MRR by 0.33–1.0):
| family | split | MRR 0.15 → 0.15.1 | answer in body |
|---|---|---|---|
| thin-intro | dev / test | 0 → 0.5 / 0 → 0.5 | 0 → 1 / 0 → 1 |
| url-table | dev / test | 0 → 1 / 1 → 1 | 0 → 1 / 1 → 1 |
| en-inflection | dev / test | 0.5 → 1 / 0.5 → 1 | 0.5 → 1 / 0.5 → 1 |
| ko-double | dev / test | 1 → 1 / 1 → 1 | 1 → 1 |
| cross-lang | dev / test | 0.75 → 0.75 / 0.75 → 0.5 | 1 → 1 |
| older families (alias, ko-*) | both | unchanged | 1 → 1 |

Reading:
- The thin-intro questions reach rank 2, not 1: the 1심 ruling says 폐기 and 이유 itself and stays first;
  the 3심 ruling is now in the body instead of a pointer. The test idea (공유 우산) behaves like dev.
- The test `url-table` question already passed on 0.15 (its query says "entry", the links say
  "entries": no URL match), so it guards the URL rule without showing it.
- One test question lost: "how are newcomers assigned to teams" (+ "신입 팀 배정") rank 1 → 2. With the
  inflection rule the English phrasing now finds an English "team" section at its rank 1; both lists
  put their best at rank 1 and the RRF tie goes to the first query (ADR 1720). Known since 1720 (consensus
  and order effects); not tuned on test.
- Test ≥ dev on MRR, recall and answer-in-body after the change (0.909 vs 0.896 MRR); the test gain
  (+0.030 MRR) is smaller than dev's (+0.055), and the dev gain is mostly the dev field questions, which
  the rules were written for. With 33 test questions one question moves MRR by up to 0.03.

Remaining misses (large set): dev "how do I roll back a bad deploy", "검색 지연 개선" (since 1213),
"서울 AI 해커톤 팀 구성" rank 3, "Lumen offsite 2026 team building budget", "해커톤 팀구성", "team dinner
budget per person" rank 2, the two thin-intro questions rank 2; test "alert threshold error rate"
(since 1213), "팀을 나눈 방식", "study group fine for absence" and the newcomers bundle rank 2.

## References
- apps/server/src/context/evalSet.ts (`FIELD_PAGES`, `FIELD_QUESTIONS`, `answerEvidence`), evalRun.ts
  (`answerInBody`, `findContextArgs`, `samePage`)
- apps/server/scripts/context-bench.ts (budget-1,000 pass, new columns), context-tune.ts (budgets, bundles,
  `RRF.k`, all 0.15.1 knobs)
- docs/adr/1213-*, 1702-*, 1900-* .. 1906-*
