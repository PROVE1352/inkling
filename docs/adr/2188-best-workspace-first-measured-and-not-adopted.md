# 2188. Several-workspace evaluation cases; "best workspace first" measured and not adopted

- Status: Accepted (extends 1213, 1909)
- Date: 2026-11-10

## Context
With one workspace per contest, find_context without workspaceId mixes contests (ADR 2185). Besides
labelling the results, a ranking rule could keep them apart: answer from the workspace that matches the
query best and push the other workspaces' results to pointers. The retrieval evaluation (ADR 1213, 1909)
has one workspace, so it could neither show the problem nor judge a rule.

## Decision
- **Evaluation cases** (`context/evalSet.ts`): `EvalPage.workspace` labels a page of another workspace;
  `evalPageKey` names it `<label>:<title>` in questions, so two workspaces can hold pages with the same
  title. `MULTI_WS_PAGES`: two more fictional contests, B "Wind Power Forecast Cup" and C "Air Quality
  Challenge", each with a `HARNESS.md` (Run / Validate / Submission rules) and a `실험 일지` (two
  experiments and a `최고 기록` section saying "best submission … score", like the main workspace's solar
  contest log); B also has a `풍력 대회 요강` with `팀 구성` and `제출 횟수`, the words of the main
  workspace's hackathon questions. `MULTI_WS_QUESTIONS`: 12 questions (tag `multi-ws`, dev 6 / test 6),
  each naming its contest, one `queries=[en, ko]` bundle per split, and some whose best lexical match is in
  the wrong workspace ("air quality harness submissions per day" vs B's "3 submissions per day").
  They are **not** in `ALL_EVAL_PAGES`/`EVAL_QUESTIONS`: the one-workspace evaluation is unchanged.
- **Harness** (`context/context.db.test.ts`, "several workspaces"): a member of the main evaluation
  workspace who owns B and C (padded like the main pages) answers all 90 questions (78 + 12) through MCP
  find_context without workspaceId. Besides MRR and recall@5 it prints **intrusion**: the share of the
  first five shown fragments whose page is in another workspace than the answer, per question, averaged.
  Test-split lines only with `INKLING_EVAL_FINAL=1` (one final look, ADR 1213).
- **The rule** (measured as `WORKSPACE_FOCUS` + `focusWorkspace` in `routes/context.ts`, removed at
  integration): when the fragments of a call
  without workspaceId come from two or more workspaces, ask again of the best workspace alone (its whole
  budget) and put the other workspaces' fragments first among the pointers; the tool then prints one line
  under the header, `Best-matching workspace first: <id>; results of other workspaces are under Also
  relevant.` Best = `top` (the workspace of fragment [1]) or `sum` (largest summed fragment score).
- **Not adopted.** Both variants lower MRR and recall@5 on dev, and the final test run agrees, so the
  route answers as before. The cases and numbers stay.

## Measurements
Migrated test database (Postgres 16, local), MCP find_context through `app.inject`, default budget unless
the question sets one, pages padded to typical length (`padPages`). Rule off = what ships.

One workspace (the owner of the main workspace; 78 questions), unchanged by this work and by the rule's
code being present: dev MRR 0.93 / recall@5 0.993, test 0.924 / 0.99; `[eval] after` success 0.962,
sectionAt1 0.833 — the numbers given for HEAD bd30a54 (measured by the integrator; my own run of HEAD
failed on another work stream's half-done import and was not repeated). With the rule switched on (both
picks) the owner's 78 rows and three find_context answers are byte-identical to rule off (asserted in the
test).

Several workspaces (90 questions; dev 51, test 39; `multi-ws` = the 12 new ones):

| run | split | rule | MRR | recall@5 | in body | intrusion | multi-ws MRR | multi-ws R@5 | multi-ws intrusion |
|---|---|---|---|---|---|---|---|---|---|
| 1 | dev | off | 0.910 | 0.984 | 1.000 | 0.082 | 0.917 | 1.000 | 0.350 |
| 1 | dev | top | 0.899 | 0.954 | 0.961 | 0.039 | 0.833 | 0.833 | 0.167 |
| 1 | dev | sum | 0.879 | 0.935 | 0.941 | 0.059 | 0.667 | 0.667 | 0.333 |
| 2 | dev | off | 0.897 | 0.984 | 1.000 | 0.082 | 0.806 | 1.000 | 0.350 |
| 2 | dev | top | 0.879 | 0.935 | 0.941 | 0.059 | 0.667 | 0.667 | 0.333 |
| 2 | dev | sum | 0.879 | 0.935 | 0.941 | 0.059 | 0.667 | 0.667 | 0.333 |
| 2 | test | off | 0.902 | 0.991 | 0.974 | 0.076 | 0.806 | 1.000 | 0.389 |
| 2 | test | top | 0.897 | 0.966 | 0.949 | 0.026 | 0.750 | 0.833 | 0.167 |
| 2 | test | sum | 0.872 | 0.940 | 0.923 | 0.051 | 0.583 | 0.667 | 0.333 |

- The rule does what it says (intrusion roughly halves) but loses the answer whenever the first result is
  in the wrong workspace: "대기질 최고 기록 leaderboard score" (answer at rank 2 behind B's "최고 기록"),
  "wind best submission score", "풍력 최고 기록 public score" go from rank 2–3 to not shown. Picking by
  summed score does not help: the wrong contest's "best submission … score" sections match as well.
- **Run-to-run spread**: the two runs differ on the B/C questions (multi-ws dev MRR 0.917 vs 0.806: "wind
  best submission score", a `queries=[en, ko]` bundle, at rank 1 in run 1 and 3 in run 2). Not inspected;
  likely ties with the main workspace's "best submission … score" sections broken by the random page ids,
  and the recency reference (newest candidate) moving with each run's creation times. The one-workspace
  numbers did not move. With 6 questions per split, one question is ±0.08–0.17 of multi-ws
  MRR; the decision does not depend on it (every run and variant is lower than "off" on MRR and recall@5).
- New baseline for later work on this problem: rule off, dev MRR 0.897–0.910 / recall@5 0.984,
  test 0.902 / 0.991 (90 questions).

## Alternatives considered
- **A margin** (focus only when the best workspace leads by some factor): tunes how often the rule fires,
  not what it does when the lead is wrong, and the losing questions are exactly the ones with a
  confident wrong lead; not tried, to keep the dev set from being fit with a threshold.
- **Interleaving by workspace** (round robin): changes the order without knowing the right workspace;
  the labels of ADR 2185 give the agent the same information without moving answers down.
- **A default workspace per connection**: ADR 2187.

## Consequences
- find_context ranks across workspaces exactly as before; ADR 2185's labels and ADR 2186's names are the
  answer to the report. The cases stay in the evaluation, so a later rule is measured on them.
- `context.db.test.ts` answers the 90 questions once and asserts that MRR and recall@5 stay above
  0.8 / 0.85 with several workspaces.
- The switch, `focusWorkspace`, the renderer's focus line and the test's rule-on loop were removed at
  integration (wave 16): an unadopted rule is not kept as a dormant code path. To measure a later rule,
  add it back behind a switch in the same place; the measurement above (the 2026-11-10 tree) is its
  baseline.
- `scripts/context-bench.ts` and `context-tune.ts` still build one workspace (not changed).

## References
- apps/server/src/context/evalSet.ts (`MULTI_WS_PAGES`, `MULTI_WS_QUESTIONS`, `evalPageKey`),
  context/context.db.test.ts
- docs/adr/1213-*, 1909-*, 2185-*, 2187-*
