# 1702. Retrieval evaluation: Korean partial-match questions, per-family metrics, 0.14 numbers

- Status: Accepted (extends 1213)
- Date: 2026-11-10

## Context
ADR 1213 split 47 questions into dev and test. None of them wrote a compound the note spaces, a particle
on a one-syllable noun, or a page alias, which are the forms reported for "팀 구성" after 0.13.

## Decision
- **Four fictional pages** (`KO_PARTIAL_PAGES` in `evalSet.ts`): a study group (heading "팀구성", "세 팀으로
  나눈다", 벌금), a TF kickoff (alias `PayFix`; "디자인팀에서", headings 목표 and "회의 주기"), a club
  guide (alias `새내기 가이드`; "팀에 배정한다"), a project retro ("개발팀 구성", "팀을 꾸릴 때"). They avoid
  the literal phrase "팀 구성", so the field questions keep their answers. `EvalPage.aliases` is set on the
  row after `create_page` (it has no aliases argument) in `context.db.test.ts` and `context-bench.ts`.
- **15 questions** (`KO_PARTIAL_QUESTIONS`), 8 dev and 7 test, each tagged with its failure family, and
  every family in both splits: `ko-compound-query` ("해커톤 팀구성", "TF 회의주기" / "팀구성 다섯 명",
  "결제개편 목표"), `ko-particle` ("신입을 어느 팀으로 배정", "결석했을 때 벌금", "팀을 다섯 명으로 구성" /
  "팀을 나눈 방식", "팀이 배정되는 시기"), `ko-doc-compound` ("스터디 팀 구성 방법", "디자인 팀 지원" /
  "개발 팀 구성", "운영진 팀 배정 결과"), `alias` ("PayFix 회의" / "새내기 가이드 공지 방법"). Three of them
  point at the field answers (결정된 것, 우리 팀 체크리스트) in other surface forms. Total **62 questions:
  dev 37, test 25**. The ADR 0927 questions keep their position-based split (new questions are not
  appended to that list, which would move old ones between splits).
- **Per-family metrics**: `EvalQuestion.tag`, `summarizeRanks` in `evalRun.ts` (`runRankEval` returns
  `tags`), printed by `context-bench.ts` (test only with `--final`) and logged by the [db] test.
- **Protocol for 0.14**: baseline = 0.13 ranking code with the new questions (`git archive` of HEAD plus
  the evaluation files, fresh database), one `--final` run; weights tuned with `context-tune.ts` on dev
  only; one `--final` run of the result. A later change that only made queries cheaper (no weight touched)
  was re-run and its test lines compared by a script that printed only "identical"; they were. The [db]
  suite logs both splits on every run, as in 1213.

## Results (padded wiki + contest + partial-match pages + 5,000 distractors, 15,732 chunks)
| split | n | | MRR | recall@5 | nDCG@5 | precision@5 (of shown) |
|---|---|---|---|---|---|---|
| dev | 37 | 0.13 | 0.874 | 0.910 | 0.881 | 0.765 |
| dev | 37 | 0.14 | 0.901 | 0.937 | 0.909 | 0.823 |
| test | 25 | 0.13 | 0.920 | 0.927 | 0.908 | 0.865 |
| test | 25 | 0.14 | 0.940 | 0.947 | 0.931 | 0.871 |

Unpadded set (66 pages, no distractors): dev MRR 0.914 → 0.941, recall@5 0.937 → 0.991, nDCG@5
0.918 → 0.954; test MRR 0.960 → 0.980, recall@5 0.987 → 0.987, nDCG@5 0.959 → 0.971.

Per family, large set (n per split is 1–3: one question moves MRR by 0.33–1.0):
| family | split | n | MRR 0.13 → 0.14 | recall@5 | nDCG@5 |
|---|---|---|---|---|---|
| ko-compound-query | dev | 2 | 0.25 → 0.75 | 0.5 → 1 | 0.315 → 0.847 |
| ko-compound-query | test | 2 | 0.75 → 1 | 1 → 1 | 0.847 → 1 |
| ko-particle | dev | 3 | 1 → 1 | 1 → 1 | 1 → 1 |
| ko-particle | test | 2 | 0.75 → 0.75 | 1 → 1 | 0.815 → 0.815 |
| ko-doc-compound | dev / test | 2 / 2 | 1 → 1 | 1 → 1 | 1 → 1 |
| alias | dev / test | 1 / 1 | 1 → 1 | 1 → 1 | 1 → 1 |

Reading: the gain is the compound-query family (and the heading weight on the unpadded set). The
particle and doc-compound questions already passed on their other words; they guard against
regressions. The alias questions pass without aliases because 회의 주기 / 연락 방법 are rare enough; the
alias-only query is checked in the [db] test. Test ≥ dev on every metric before and after; with 25 test
questions one question moves MRR by up to 0.04.

Remaining misses (large set): dev "how do I roll back a bad deploy", "검색 지연 개선" (both since 1213),
"서울 AI 해커톤 팀 구성" rank 3, "Lumen offsite 2026 team building budget" rank 2, "해커톤 팀구성" rank 2
(the study page's heading "팀구성" outranks the decision note: nothing in that note says 해커톤);
test "alert threshold error rate" (since 1213), "팀을 나눈 방식" rank 2.

## References
- apps/server/src/context/evalSet.ts (`KO_PARTIAL_PAGES`, `KO_PARTIAL_QUESTIONS`), evalRun.ts (`summarizeRanks`)
- apps/server/scripts/context-bench.ts, context-tune.ts; apps/server/src/context/context.db.test.ts
- docs/adr/1213-*, 1700-*, 1701-*
