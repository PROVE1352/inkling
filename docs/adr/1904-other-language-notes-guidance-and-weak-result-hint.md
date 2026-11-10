# 1904. find_context: notes in another language — ask with queries=[original, translation], and say so when an answer is weak

- Status: Accepted
- Date: 2026-11-10

## Context
Retrieval is lexical (ADR 0927, 1210): an English question does not find Korean notes. Semantic search
(ADR 1214, 1740–1743) is optional and off by default. Agents already can pass several phrasings in one
call (ADR 1720), but the tool description mentioned translations only in passing, and nothing in an
answer told the agent that its words were not in the notes: "team dinner budget per person" on Korean
notes returns the English offsite budget section, a plausible wrong answer.

## Decision
Within the "no new dependency" rule:
- **Description** of find_context: "Unsure of the wording, or notes may be in another language? Pass
  queries=[original, translation, …] (up to 5): one merged answer, one budget." (replaces "Korean and
  English both work … synonyms/translations", same length).
- **Server instructions** (`SERVER_INSTRUCTIONS`, mcp.ts, owned by the tool-surface change of 0.15.1):
  one sentence for the integration, see the release drafts: "If the notes may be in another language than
  the question, pass queries=[question, translation]."
- **Empty answer**: `No sections match "q". Try other or fewer words (synonyms), queries=["q",
  "<translation>"] if the notes may be in another language, or list_pages.`
- **Weak answer, one query** (`otherLanguageHint`): the query words (word groups, so a stem or particle
  form counts) that occur in no shown section — title, heading path or text, URLs not counted (ADR 1901)
  — are listed when they are more than half of the query's words and at least two:
  `Not in any result: solar, forecast. If the notes may be in another language, ask again with
  queries=["solar forecast …", "<translation>"].` The line is computed from the rendered result only (no
  REST field, no database), so it is deterministic and costs nothing when absent. Not printed for a
  merged answer: `queries=[…]` (that caller already asked in several ways) and a single query while
  semantic search is on (a section found by meaning shares no word with the query by design). A
  one-word query never gets it ("PayFix" matches its page only through an alias, which the shown
  fragment does not carry).

## Measured (ADR 1909 corpus, padded + 5,000 distractors)
- The first rule was "half or more". On the 74 single-query evaluation questions it printed the line 5
  times, every time on an answer that was right (rank 1–2): "what did people say about the offsite food"
  (did, say, about), "해커톤 팀구성" (해커톤), "PayFix 회의" and "새내기 가이드 공지 방법" (aliases: the fragment
  carries no aliases), "reviewers answering pull requests" (pull, requests). With "more than half": 0 of 74.
  This was decided after the final evaluation run, looking at all 74 outputs (dev and test); it changes no
  rank metric, and the token numbers of ADR 1909 were measured again after it.
- The English phrasings of the four `cross-lang` questions asked alone: the line appears for "how are
  newcomers assigned to teams" (newcomers, assigned; 7 English results about teams). The other three get no
  line: their English words are found in English sections ("team dinner budget per person" → the offsite's
  "budget per person"; "solar forecast best score" → the Korean log's English intro and "best"). So the hint
  catches a mostly-foreign question, not a plausible wrong answer (docs/KNOWN-ISSUES.md).
- Asked as `queries=[English, Korean]` the four are answered in the body before and after; the merge was
  already there (ADR 1720).

## Alternatives considered
- **Translate on the server**: needs a model or a service — a dependency and, for a hosted one, notes
  leaving the server.
- **A score threshold** ("best score < x"): scores are relative (ADR 1210 normalises by the query's idf);
  an absolute threshold would differ by query length and corpus. Missing words are visible and explain
  themselves.
- **Hint on every answer with any missing word**: "how do I roll back a *bad* deploy" would always carry
  it. "Half or more" fired on right answers (above).

## References
- apps/server/src/mcpTools/contextTools.ts (`wordsInNoResult`, `otherLanguageHint`, description, empty message)
- apps/server/src/context/rank0151.test.ts ("weak answer: …")
- docs/adr/1214-*, 1720-*, 1723-*, 1901-*
