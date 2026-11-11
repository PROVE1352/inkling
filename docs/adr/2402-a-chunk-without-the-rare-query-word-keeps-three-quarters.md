# 2402. A chunk without the query's rarest word keeps three quarters of its score

- Status: Accepted (amends the score of 1210)
- Date: 2026-11-11

## Context
In the field case of ADR 2400 the rare word carried half of the query's weight (idf about 6.2 against
2.5, 2.3 and 1.7), yet the first results had none of it: they matched the three common words in the
title, the heading path and the text, and the title and heading shares (0.15 + 0.3 of each word's
weight) added more than the rare word's coverage share took away. The score is a sum of shares, so
"has every common word, prominently" can beat "has the one word the question is about".

## Decision
- `rareGroup` (`rank.ts`): the query word group with the largest idf, when that idf is at least
  `WORD_RULES.rareRatio` (1.1) × every other group's, the word occurs in scope (df > 0; an unseen word
  says nothing) and it has two or more characters (one-character words — 때, 것, 중, 수 — are mostly
  dependent nouns; a longer word must still beat them by the ratio). Queries of one word have none.
- `scoreParts`: a chunk that has that word nowhere — not in its text, title or heading, nor its shorter
  form (ADR 2401) in the title or heading — keeps `rareFactor` (0.75) of its score. Applied after the
  other factors, before diversification and the floor, so it changes order and what clears the floor.
- `rareFactor` 1 = off.

## Measured
Dev, final configuration minus this rule → with it (`context-tune.ts`):
| set | MRR | page@1 | page@3 |
|---|---|---|---|
| existing questions, padded + 5,000 distractors | 0.896 → 0.907 | 0.844 → 0.867 | 0.956 → 0.956 |
| existing questions, unpadded | 0.930 → 0.941 | 0.889 → 0.911 | 1.000 → 1.000 |
| recall set, own 3 workspaces | 0.856 → 0.938 | 0.813 → 0.938 | 0.875 → 1.000 |
| recall set + padded workspace | 0.794 → 0.802 | 0.813 → 0.813 | 0.813 → 0.938 |

Sweep on dev (other rules on, partial shares 0.5–0.7): `rareRatio` 2 / 1.5 / 1.3 / 1.2 / 1.15 / 1.1 / 1.0 → recall+padded page@3
0.813 / 0.813 / 0.875 / 0.875 / 0.938 / 0.938 / 0.938; the existing padded set's MRR rises from 0.896
at 1.15 to 0.907 at 1.1 and the unpadded set's falls at 1.0 (0.941 → 0.919). `rareFactor` 0.6 (ratio 1.15): recall
MRR 0.896 → 0.938 but the existing padded set 0.896 → 0.885 and unpadded recall@5 0.993 → 0.970 (a
second relevant section without the word drops under the floor); 0.85 (ratio 1.5): recall MRR 0.865 →
0.859. 0.75 and 1.1 kept.

The test split was looked at once with the first version: "택배를 도난당했을 때" went from rank 6 to not
shown, because the one-character 때 was the "rare" word (idf 1.49 against 택배's 1.32). The
one-character exclusion was added after that look; it changed no dev number. The test numbers of ADR
2403 are therefore not fully held out for this detail.

## Alternatives considered
- **A hard filter** (only chunks with the rare word): an idf that is high because a word is misspelt
  or absent from the notes would empty the answer; 0.75 is a preference.
- **Sharpening every idf** (power > 1): changes every query's balance, including those with no
  standout word, and the coarse SQL order would have to follow; the rule acts only where one word
  dominates.
- **Workspace-local document frequencies**: in the field case the global weights already marked the
  word as rare; the failure was in how shares add up, not in the weights. Local df would also give a
  word missing from one workspace the unseen weight (0.5) there and favour that workspace's chunks.

## Consequences
- Soft AND on one word: a second relevant section that does not repeat the word can fall under the
  relative floor. Seen once: test question "해커톤 팀 구성 확정" keeps its first result, but the checklist
  section (no 확정) is no longer shown (recall@5 1.0 → 0.5), in both the padded and unpadded runs.
- No SQL change; the rule runs on the ≤ 300 scored candidates.

## References
- apps/server/src/context/rank.ts (`rareGroup`, `scoreParts`), retrieve.ts
- apps/server/src/context/rank020.test.ts
- docs/adr/1210-*, 2400-*, 2401-*, 2403-*
