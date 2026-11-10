# 1700. Korean partial match at query time: split compounds, one-syllable nouns with particles

- Status: Accepted (amends the word groups of 1210)
- Date: 2026-11-10

## Context
After 0.13 the field query "팀 구성" was reported to miss notes that write "팀구성", "구성원" or "팀을".
Measured on the evaluation corpus (ADR 1213 plus the pages of ADR 1702) before changing anything, the
document side was already covered: "팀구성" in a note is one token whose bigrams (`grams`, ADR 0927)
include 구성 and whose prefix is 팀, "구성원" starts with 구성, "팀을" starts with 팀. All four questions
whose note writes such a form (the `ko-doc-compound` family, ADR 1702) were at rank 1. The misses were
on the query side:

- **A compound in the query, spaced in the note.** "해커톤 팀구성" against "팀 구성은 다섯 명으로
  확정했다": `'팀구성':*` and `ILIKE '%팀구성%'` both miss, so the answer was not shown (dev MRR of this
  family 0.25). "TF 회의주기" against the heading "회의 주기" tied the three TF sections.
- **A particle on a one-syllable noun in the query.** "팀을" has two characters, which ADR 1210 never
  strips (회의, 평가, 휴가 end in particle-like syllables), so `'팀을':*` matched only notes that also
  wrote 팀을, and the rare inflected form got a high idf.
- **Endings that hid a stem**: "결석했을" stripped to "결석했".

pg_trgm was the other candidate (the extension and `page_chunks_text_trgm_idx` exist since 0007/0028).
Korean nouns are mostly two syllables, and pg_trgm pads words, so the forms share few trigrams:
`similarity('팀구성', '팀 구성')` = 0.29 (default threshold 0.3), `word_similarity('팀구성', '팀 구성은 다섯
명으로 확정했다')` = 0.25 (default 0.6), while the unrelated `word_similarity('팀을', '팀 구성')` = 0.33.
A similarity probe would rank noise next to the answer and still need a threshold per query length.

## Decision
All of it happens at query time in `rank.ts` `queryGroups` and the SQL built from it; no migration, no
new index, no re-index (`CHUNKER_VERSION` stays 4).

- **Split readings.** A Hangul query word of 3–8 syllables (after stripping a particle or ending) also
  counts as two adjacent words, at every split point whose tail has two or more syllables: "팀구성" →
  팀 + 구성, "회의주기" → 회 + 의주기, 회의 + 주기. In SQL each is a phrase in the group's tsquery
  (`('회의':* <-> '주기':*)`), answered by the existing GIN index on `tsv` with a position check. A
  one-syllable head is matched as a whole word or with a particle (`('팀' | '팀의' | '팀을' …) <->
  '구성':*`), not as the prefix `'팀':*`: with a prefix every three-syllable word ("해커톤" → 해 + 커톤)
  scanned all words starting with its first syllable. A wrong split ("해 커톤") costs a little work and
  matches almost nothing, because the two words must be adjacent.
- **One-syllable noun + particle.** "팀을", "팀이", "팀으로", "내가" → stem 팀/내 when the particle fits
  the stem's last sound: 을/은/이 after a final consonant, 를/는/가 after a vowel, and 에, 에서, 에게,
  까지, 부터, 처럼, 보다, (이)랑, 으로 after either. "가을", "마을" (vowel + 을), "아이" (vowel + 이),
  "평가", "국가" (consonant + 가) are therefore never split; 의, 도, 만, 로, 과/와 never split a
  two-character word (회의, 정도, 불만, 도로, 결과). The stem is added as **whole words only**: the stem
  alone and with each particle that fits it (`exact` on `TermGroup`, about 16 lexemes, exact tsquery
  lexemes without `:*`). So "휴가" (which does split: 휴 + 가) adds 휴, 휴를, 휴는 … and never matches
  휴식 or 휴일 — the objection to stripping in ADR 1210 ("가을" matching every word starting with 가)
  does not apply. "팀을" now finds 팀, 팀에, 팀으로 but not 팀장 or 팀원.
- **More endings** in the strip list (longest first): 했을, 했나, 했던, 했고, 했어, 해야, 하면, 할까,
  하나, 하지, 되나, 됐나, 됐다, 되면, 받는, 받은, 처럼, 마다, 보다, 이란, 라는, 이라는, 했는지,
  했습니다, 합니다, 입니다. A one-syllable stem takes the whole-word path first, so "팀으로" is 팀 + 으로,
  not 팀으 + 로 as before.
- **One group, one weight.** The split readings and the whole-word forms belong to the query word's
  group: df counts chunks that have any of them, and the coarse SQL flags and the Node score
  (`groupSpans`) use the same forms. In Node the whole-word forms are found with one scan for the stem
  and a set lookup of the word around it, and the split regexes are compiled once per group (scoring
  runs for up to 300 candidates).
- Title and heading flags in SQL (which only steer the 300-row cut) test the stem and "head tail" with
  `ILIKE`; Node checks word boundaries exactly.

## Alternatives considered
- **pg_trgm similarity or word_similarity** for Korean words: numbers above; also no help for a
  one-syllable noun.
- **Doc-side n-grams** (index the last syllable of every Hangul word so "디자인팀" answers "팀"): needs the
  chunk hash to include `grams` (today a grams-only change is skipped by `reindexPageChunks`), a
  `CHUNKER_VERSION` bump and a boot re-index of every page on every install. Deferred; see Consequences.
- **Stripping 1-character particles to a prefix stem** ("팀을" → `'팀':*`): the same as typing "팀", but
  "휴가" → 휴:* and "작은" → 작:* (작업, 작성) would sink those words' weight. Whole words only.
- **Splits for every word, prefix head**: same quality on dev, +10 to +20 ms on queries with
  three-syllable words.

## Consequences
- Latency on the 15,732-chunk benchmark workspace (`context-bench.ts`, interleaved A/B with the same
  data): p50 36.5 → 40–42 ms, p95 90–109 → 96–99 ms. Queries whose one-syllable noun is common get
  more candidates: "팀을 나눈 방식" 11 → 40 ms, the same as "팀 나눈 방식".
- Still not found: a one-syllable query word inside a note's compound ("디자인 팀" vs "디자인팀에서",
  "개발 팀" vs "개발팀"); the prefix query never sees a word's last syllable. The evaluation's questions
  of that family pass on their other words. Doc-side last-syllable grams are the follow-up.
- The whole-word family of a vowel-final stem contains real nouns: "차를" → 차도, 차로; "제가" → 제도,
  제의, 제로. Such hits only add to that word's df (lowering its weight) and give it some coverage; the
  gate above prevents the wrong *strip*, not every collision of the *family*.
- `TermGroup` gains optional `exact` and `splits`; callers that read only `variants` see the old forms.

## References
- apps/server/src/context/rank.ts (`queryGroups`, `oneSyllableStem`, `particleFamily`, `compoundSplits`,
  `groupTsquery`, `groupSpans`)
- apps/server/src/context/retrieve.ts (group tsqueries in the `q` row, `patterns`)
- apps/server/src/context/context.test.ts, context.db.test.ts ("Korean partial match …")
- docs/adr/1210-*, 1701-*, 1702-*
