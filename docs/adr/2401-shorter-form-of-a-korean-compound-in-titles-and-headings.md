# 2401. The shorter form of a Korean compound counts in titles and headings, with a discount

- Status: Accepted (amends the word groups of 1210/1700)
- Date: 2026-11-11

## Context
The field query of ADR 2400 (analogue: "해커톤 택배함 분석 서비스" against a page titled "02-1 아이디어1,
택배 한 상자") wrote a longer compound than the note. ADR 1700 handles a compound the query writes
without a space (split readings) and the note's compound found by a shorter query word (bigrams,
prefixes), but not this direction: the note's title and headings say 택배, the query says 택배함, and
`'택배함':*` never matches 택배. In the trace of the field case the answer's chunks were candidates and
had the rare word in their text, but got 0 of the title and heading weight (WEIGHTS.title 0.15,
heading 0.3) while long sections of other workspaces got that weight for the three common words.

Korean writes many nouns as a stem and a one-syllable noun (회의록, 설문지, 안내서, 계약서, 지원서,
택배함, 당번표); titles often keep only the stem.

## Decision
- `partialForm` (`rank.ts`): a Hangul query word of 3+ syllables, after a particle or ending is
  stripped, has a shorter form = the word without its last syllable ("택배함" → 택배, "회의록" → 회의,
  "기능정의서" → 기능정의). It is stored on the word group as `partial`, not as a variant: it is not
  searched in the text, not highlighted, and not part of the group's document frequency.
- Scoring (`scoreParts`): when the group's own forms are not in the page title (or an alias) but the
  shorter form is, the title share gets `WORD_RULES.partialTitle` (0.7) of the group's weight; the same
  for the heading path (`partialHeading` 0.7); a group found nowhere else gets `partialCover` (0.7) of its
  coverage once. The shorter form counts as "having" the word for ADR 2402's rule.
- SQL (`retrieve.ts`): pages whose title has a shorter form join the title probe (≤ 6 chunks each, as
  for title matches); the coarse order before the 300-row cut has the same discounted title and
  heading flags. Title-only pages (no text) are still listed on the query's own words only.
- All three shares 0 = off; the SQL text is then the same as 0.19.

## Measured
Dev, final configuration minus this rule → with it (`context-tune.ts`, same data, ADR 2400 sets):
recall set (own 3 workspaces) page@1 0.875 → 0.938, page@3 0.938 → 1.000, MRR 0.887 → 0.938; with
the padded workspace page@3 0.875 → 0.938, MRR 0.794 → 0.802. Existing dev questions unchanged (padded
MRR 0.907, unpadded 0.941). Private check (ADR 2400): with this rule alone the field case goes from
rank 5 to 1 and a second question of the same shape from not shown to rank 2.

Weights 0.5 / 0.7 / 1.0 were tried on dev: 0.5 lost one recall question's first place, 0.7 and 1.0
were equal; 0.7 keeps a discount for collisions (below).

## Alternatives considered
- **The shorter form as one more variant of the group** (searched as a prefix, df of either form): on
  dev with the other rules on, recall MRR 0.938 → 0.844 and page@3 1.000 → 0.938, padded recall page@3
  0.938 → 0.875; private page@1 0.944 → 0.889 and more tokens (1,770 → 1,847). The stem is much more
  common than the compound (회의 vs 회의록), so the group's weight fell and body text with the stem
  matched as strongly as the compound.
- **Character bigrams of title, heading and body as separate weighted fields, a bigram-OR query and
  RRF over phrasings** (an outside proposal): needs a new stored index (grams per field) and a
  re-index of every page, and bigram OR matching brings back the noise ADR 1700 measured for trigram
  similarity. The useful part — a partial match in the title or heading should count — is this rule,
  on the existing index.
- **pg_trgm / pg_bigm similarity**: an extension (not allowed) or the numbers of ADR 1700.
- **Every shorter prefix (택배함 → 택, 택배)**: one-syllable stems are the whole-word problem of ADR 1700.

## Consequences
- Collisions: "자동차" → 자동 gives a title "자동화 정리" 0.7 of the word's title weight. It only adds
  title/heading credit, never text matches; the measured sets have no loss from it.
- Per query, one more ILIKE per shorter form on titles (pages) and heading paths (candidates). No
  latency change measured (ADR 2403's table).

## References
- apps/server/src/context/rank.ts (`partialForm`, `WORD_RULES`, `scoreParts`), retrieve.ts
- apps/server/src/context/rank020.test.ts, recallEval.db.test.ts
- docs/adr/1700-*, 2400-*, 2402-*, 2403-*
