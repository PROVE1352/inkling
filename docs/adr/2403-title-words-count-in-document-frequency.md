# 2403. Title words count in a word's document frequency; results of the 0.20 word rules

- Status: Accepted (amends the word weights of 1210)
- Date: 2026-11-11

## Context
Scoring treats the page title as part of every chunk (BM25F with equal field weights, ADR 1210), but a
word's document frequency counted only chunks whose text has it. A word written only in titles got
df 0 and the unseen-word weight (0.5), the lowest possible. In the recall set (ADR 2400), "택배 도난"
asks for a three-line page titled "택배 도난 대응" whose text never says 도난: 도난 weighed 0.5 against
택배's 6.75, and the idea page about parcels came first. A key word that people put in titles and
not in the text is common (a page named after its topic).

## Decision
- With `WORD_RULES.titleDf` (on), the title and alias flags of each candidate are computed once in the
  `matched` step (pages joined there) and a word group's df = candidate chunks whose text **or page
  title** has it. The coarse order reads the same flags (no second per-row title test in `ranked`).
- df stays a statistic of the candidates (≤ 6 chunks per title-matching page join them), as before for
  text matches; N (chunks in scope) is unchanged.
- Off: the SQL text is the same as 0.19.

## Measured
Dev, final configuration minus this rule → with it: recall set + padded workspace MRR 0.760 → 0.802,
page@1 0.750 → 0.813 ("택배 도난" rank 2 → 1); every other dev number equal.

### All three rules (ADR 2401–2403), `context-bench.ts --pages 5000 --final`
0.19.0 = `git archive` of 958a9b4 with only the evaluation files and the bench script copied in; each
run on a freshly created and migrated database (15,806 chunks); Postgres 16 in Docker on localhost,
Node 22, Apple-silicon MacBook Air.

| set | split | page@1 | page@3 | page MRR | section MRR | recall@5 | tokens |
|---|---|---|---|---|---|---|---|
| recall, own 3 workspaces | dev | 0.813 → 0.938 | 0.875 → 1.000 | 0.856 → 0.958 | 0.844 → 0.938 | 0.844 → 0.906 | 912 → 790 |
| recall, own 3 workspaces | test | 0.750 → 0.750 | 0.938 → 0.938 | 0.854 → 0.854 | 0.819 → 0.819 | 0.875 → 0.875 | 569 → 531 |
| recall + padded/5000 | dev | 0.750 → 0.813 | 0.813 → 0.938 | 0.794 → 0.865 | 0.740 → 0.802 | 0.781 → 0.844 | 1,272 → 1,206 |
| recall + padded/5000 | test | 0.750 → 0.813 | 0.938 → 0.938 | 0.844 → 0.885 | 0.809 → 0.851 | 0.875 → 0.875 | 592 → 583 |
| existing 78, unpadded | dev | 0.889 → 0.911 | 1.000 → 1.000 | 0.941 → 0.952 | 0.930 → 0.941 | 0.981 → 0.993 | 211 → 167 |
| existing 78, unpadded | test | 0.848 → 0.879 | 1.000 → 1.000 | 0.924 → 0.939 | 0.924 → 0.939 | 0.990 → 0.975 | 190 → 173 |
| existing 78, padded + 5,000 | dev | 0.844 → 0.867 | 0.956 → 0.956 | 0.896 → 0.907 | 0.896 → 0.907 | 0.948 → 0.948 | 318 → 319 |
| existing 78, padded + 5,000 | test | 0.848 → 0.848 | 0.970 → 0.970 | 0.909 → 0.909 | 0.909 → 0.909 | 0.960 → 0.944 | 290 → 272 |

The two recall@5 drops are one question ("해커톤 팀 구성 확정", ADR 2402 Consequences). Old-flow table
(find_context after): unpadded page@1 0.86 → 0.88, padded 0.83 → 0.85, page@3 unchanged, mean tokens
199 → 166 and 302 → 296. Private check (ADR 2400, 36 questions, read-only local copy, numbers only):
page@1 0.917 → 0.944, page@3 0.917 → 0.972, MRR 0.928 → 0.964, tokens 1,789 → 1,770; the field case
rank 5 → 1.

Still failing: long questions of common words with one key word (dev page 5 → 3 and 2 → 1; the answer
section itself not shown), "택배를 도난당했을 때" (the stem 도난당 is not 도난: an ending the strip list
lacks), "온보딩 안내서 첫 주" (rank 2).

Latency, same data, rules off / on interleaved per question, 3 rounds, direct calls: 78 existing
questions on the 15.8k-chunk workspace p50 36.2 → 34.6 ms, p95 102.2 → 90.8 ms; 32 recall questions
over four workspaces p50 27.9 → 26.8 ms, p95 141.5 → 137.7 ms. Bench runs: p50 38.4 → 35.2 ms, p95
108.8 → 92.7 ms. No cost: the title flags are computed once instead of twice.

## Alternatives considered
- **Count a title match as df once per page** (not per chunk): the df would mix units (chunks for
  text, pages for titles) against N in chunks.
- **A per-field df** (title df separate from text df, BM25F with field idf): another set of weights to
  tune for one case; the combined df is what scoring's "title is part of every chunk" already implies.

## Consequences
- Words common in titles (a contest name in every page title) weigh less than before; on the measured
  sets that changed no first result.
- No migration and no re-index: every rule of ADR 2401–2403 is query time only.

## References
- apps/server/src/context/retrieve.ts (`matched`, `dfCols`), rank.ts (`WORD_RULES.titleDf`)
- apps/server/scripts/context-bench.ts, context-tune.ts
- docs/adr/1210-*, 2400-*, 2401-*, 2402-*
