# 1902. find_context packing: a chunk above 40% of the budget is cut around its best lines

- Status: Accepted (amends the packing of 0927, 1211 and the merge of 1720)
- Date: 2026-11-10

## Context
`pack` put the best chunk in whole, then filled by score per token; a chunk that did not fit was cut
to the rest only when at least 80 tokens were left (`MIN_TAIL`), else it became a pointer. With a
small budget one long chunk (a 600-token table, a meeting log) took everything and the short answer
after it was a pointer. The cut, when it happened, started a couple of lines before the *first*
occurrence of *any* query word — often a common word, or (before ADR 1901) a URL. The multi-query merge
(ADR 1720) cut from the start of the text, not around the query's words at all.

## Decision
- **Cap** (`PACKING.largeShare = 0.4`): a chunk whose tokens exceed 40% of the budget (at least
  `minTail`) is cut to that size even when it would fit. Per chunk: in `pack`, and in
  `fuseContextResults` for the raw section chunks of extra lists (semantic candidates); per-query
  fragments were already packed with the same budget, and a fragment of two merged neighbours stays whole
  when it fits. The
  rest of the loop is unchanged: later chunks that fit whole are taken, one that does not fit is cut to
  the remaining room when ≥ 80 tokens are left, else it is a pointer.
- **Where to cut** (`cutAroundHit`): the line with the largest idf-weighted number of *different* query
  word groups (URLs removed, ADR 1901; first such line on a tie), up to two lines of context before it,
  then as many lines after it as fit, then earlier lines if room is left. For a table row below the
  column names, the first row is kept with a `…` line after it (room is reserved for it). One line longer
  than the room (a paragraph) starts about 120 characters before its first hit, at a word boundary. The
  multi-query merge cuts around the words of the query whose list produced the piece (weights 1, the
  merge has no df).
- **Pointer**: the fragment header says `; truncated, section ~N tok` with the size of the whole section
  (sum of its index parts, read with the short anchors in the same statement), so the agent knows what
  `read_page(pageId, section=…)` will cost. REST `fragments[].fullTokens` carries it.
- **Small-chunk weight** (`PACKING.minWeight` 60 → 80): after the first chunk, packing goes by score per
  token, and a chunk counts as at least `minWeight` tokens. The [db] evaluation corpus (padded pages, no
  distractors, plus the field pages of ADR 1909) showed the 1213 field query at a 1,500 budget filled by
  fourteen 54-token notes that scored 0.508 just above the floor (ratio 0.508/60) while the 72-token
  answer scored 0.594 (0.594/72): the answer became a pointer — on 0.15 as well, once the field pages
  were in the corpus. 80, 100, 150 and pure score order give the same dev numbers on the large set;
  80 is the smallest that restores it (dev, budget 1,000, that corpus: recall@5 0.981 → 0.993, answer
  in body 0.956 → 0.978).
- Deterministic: the cut is a function of the text, the query words and the size.

## Measured
On the evaluation set the cap changes no dev metric (`largeShare` 0.25, 0.33, 0.4, 0.5 and off give the
same MRR/recall/answer-in-body at the default budget and at 1,000; tokens per question 310 / 313 / 316
/ 319 / 328 with ADR 1901 off): after ADR 1901 no dev question has a relevant chunk above 40% of its
budget. With ADR 1901 switched off the cap alone does not rescue the field case either: there the
answer fell under the relative floor (0.6 × the table's score), so it never reached packing. The cap is
kept as the guard for the reported shape (a large first chunk, a short relevant one passing the floor),
checked by `rank0151.test.ts` ("a chunk above largeShare × budget is cut …"): at a budget of 1.3 × the
table, before both did not fit; now the table is cut around its matching row with its header and the
answer follows.

`minTail` 40 instead of 80: no dev change; kept 80. `minWeight`: see Decision.

## Alternatives considered
- **Never put the first chunk in whole (pure value per token)**: the best section would lose to small
  noise chunks at large budgets.
- **Skip a large first chunk to a pointer**: the agent then needs another call for the best match.
- **Cut at a fixed token count from the start**: tables and logs keep their head, which is rarely the hit.

## References
- apps/server/src/context/rank.ts (`PACKING` largeShare / minTail / minWeight, `cutAroundHit`, `pack`), multiQuery.ts (`fuseContextResults`)
- apps/server/src/context/retrieve.ts (`sectionLabels` totals), apps/server/src/mcpTools/contextTools.ts
- docs/adr/0927-*, 1211-*, 1720-*, 1901-*
