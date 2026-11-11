# 2400. Recall evaluation set: questions as people remember pages, asked over several workspaces

- Status: Accepted (extends the evaluation of 1213, 1702, 1909)
- Date: 2026-11-11

## Context
A field query of the form "<event> <compound noun> <analysis> <service>" missed the page whose short
title named the idea with the compound's stem only (the analogue in this repository: "해커톤 택배함 분석
서비스" against a page titled "02-1 아이디어1, 택배 한 상자"); a substring search for the title words
found it at once. The top results were long sections from other workspaces that repeat the three
common words. None of the 78 questions of the existing evaluation (ADR 1213, 1702, 1909) has that
shape: they are asked inside one workspace, and their key word is written the way the note writes it.
Before changing the ranking, the failure needed numbers.

## Decision
- **Corpus** (`context/evalRecallSet.ts`, fictional, written for this test): three workspaces —
  H, a hackathon team (idea pages with short numbered titles, judging, presentation, a survey, a
  three-line page "택배 도난 대응"); P, a product team wiki (release plan, weekly meeting, deploy, on-call,
  API limits, CI, code review, onboarding, one-line pages "와이파이" and "회의실 예약", pages whose key
  word is only in the title); L, a research archive of long sections that repeat 해커톤, 분석, 서비스,
  아이디어, 데이터, 회의, 일정, 팀 in varied sentences (the "other workspace" of the field report).
- **32 questions** (`RECALL_QUESTIONS`), 8 families × 4 (2 dev, 2 test), tag `r-*`: the query writes a
  longer compound than the note (택배함 ↔ 택배, 회의록 ↔ 회의, 설문지, 안내서); particles and endings
  (일정을, 배포했던, 도난당했을); spacing (출시계획 ↔ 출시 계획, 텃밭 지도 ↔ 텃밭지도, 코드리뷰,
  발표 자료 ↔ 발표자료); a key word only in the title; long questions of common words around one key
  word; English words and abbreviations in Korean questions (API rate limit, CI, PR, MVP); a short page
  against long sections; the same words in several workspaces.
- **Asked without a workspace**, as an agent asks, by a person who has the three workspaces ("own 3
  workspaces"), and by one who also has the padded wiki + 5,000 distractor pages of the existing
  benchmark (15.8k chunks, "recall + padded/5000"). `context-bench.ts` builds both and prints the
  tables; `context-tune.ts` asks the set with `RECALL_WS=H=…,P=…,L=…`.
- **Page metrics** next to the section metrics (`evalRun.ts`): page@1, page@3 (the answer page among
  the first one / three distinct pages shown) and page MRR, also printed for the existing questions.
  A person asking "where was that page" judges by page; the section metrics stay as they were.
- **A private check, not in the repository**: the maintainer's local copy of a production database,
  read-only, 36 questions written from page titles the way one remembers them (paraphrased, partial,
  respaced). Only numbers leave that machine; the notes, questions and titles are not copied anywhere.
- The two meeting-notes questions of P name a detail of the page ("회의록 알림 문구 결정", "10월 회의록
  액션 아이템"): with the bare "회의록 결정" the padded wiki's own weekly notes (titled 주간회의록, same
  sections) are an equally right answer in the large run. One is a dev and one a test question; both
  were reworded for that collision after the first dev-only run, before any test result was printed.

## Results before the ranking change (0.19.0 code, `--final`)
| set | split | page@1 | page@3 | page MRR | section MRR | tokens |
|---|---|---|---|---|---|---|
| own 3 workspaces | dev | 0.813 | 0.875 | 0.856 | 0.844 | 912 |
| own 3 workspaces | test | 0.750 | 0.938 | 0.854 | 0.819 | 569 |
| + padded/5000 | dev | 0.750 | 0.813 | 0.794 | 0.740 | 1,272 |
| + padded/5000 | test | 0.750 | 0.938 | 0.844 | 0.809 | 592 |

Families that failed: the longer compound (the field analogue not shown at all, in both sets), long
questions of common words, a short page whose key word is only in its title ("택배 도난": the word 도난
is in the title only, so it got the unseen-word weight), particles on a word that is only in a title.
The ranking changes are ADR 2401–2403.

## Alternatives considered
- **Adding the questions to `EVAL_QUESTIONS`**: the existing numbers (one workspace, `workspaceId`
  given) would move with the new pages' document frequencies and stop being comparable with
  PERFORMANCE.md. A separate set in separate workspaces leaves them unchanged.
- **A new harness**: `runRankEval`, `scoreRanking` and the bench/tune scripts already do this; the set
  plugs into them.

## Consequences
- 16 dev questions are few: one question moves page@1 by 0.0625. The set is for families, not decimals;
  the private check and the existing 78 questions are read together with it.
- The large run's statistics come from the distractor workspace, whose vocabulary has 해커톤/회의/일정
  but not 분석/서비스/아이디어/데이터: there those words count as rare, unlike in real notes.

## References
- apps/server/src/context/evalRecallSet.ts, evalRun.ts (`pageRank`, `pageAt1`, `pageAt3`, `pageMrr`)
- apps/server/scripts/context-bench.ts, context-tune.ts
- docs/adr/1213-*, 1702-*, 1909-*, 2401-*, 2402-*, 2403-*
