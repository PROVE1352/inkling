# 1901. find_context: link targets and bare URLs are not words of the note

- Status: Accepted
- Date: 2026-11-10

## Context
"solar forecast best submission score" on Korean contest notes returned a 600-token table of submissions
first; the 54-token section with the answer was not shown. Every row of the table links to
`https://…/solar-forecast/submissions/…`. In Node the score finds query words at a word start
(`occurrences`), and `/` and `-` are word boundaries, so each URL counted solar, forecast and
submission(s) — twenty times.

Postgres does not do this: the `simple` parser keeps a URL path as one lexeme
(`'/solar-forecast/submissions/1001'`, `'contest.example.com'`), so `'forecast':*` never matches it.
URL words therefore change neither the candidate set nor the document frequencies; only the Node score
saw them. (A host that starts with the word, `forecast.example.com`, does match a prefix in SQL; rare,
left as it is.)

## Decision
Query time only (`rank.ts` `searchText`): before matching, `](target)` of a Markdown link is removed
(the label stays: it is the author's words) and bare `http(s)://` / `www.` addresses are blanked. The
same text is used for the score, for choosing where to cut a long chunk (ADR 1902) and for the
"words in no result" hint (ADR 1904). Wiki links `[[Title]]` stay words for the score; they are not the
section's own prose for ADR 1900.

No index change: `CHUNKER_VERSION` stays 4, nothing is re-indexed.

## The index-side alternative (not done)
Storing a URL-free search text would mean a new generated `tsv` expression or a stored column, i.e.
`CHUNKER_VERSION` 5 and the boot backfill re-indexing every page on every install. Measured cost of a
re-index on the benchmark machine: the context-bench build indexes 5,000 pages (about 15,000 chunks)
in 58 s, 11.7 ms per page, so about 2 minutes per 10,000 pages at boot, plus the GIN index rewrite. It would buy
nothing for ranking, because the SQL side already ignores URL paths.

## Measured (dev, ADR 1909)
`stripUrls` off vs on, everything else of 0.15.1 on: MRR 0.874 → 0.896, R@5 0.926 → 0.948, answer in
body 0.933 → 0.956; mean tokens per question 316 → 302. The `url-table` dev question goes from not shown
(the table filled 652 of 700 tokens) to rank 1 at 75 tokens.

## Alternatives considered
- **Down-weight URL words instead of removing them**: they never carry the meaning of the note; a weight
  would need tuning for no case found.
- **Strip link labels too**: labels are usually the words a person chose ("see the [rollback guide](…)").

## References
- apps/server/src/context/rank.ts (`searchText`, `scoreParts`)
- apps/server/src/context/rank0151.test.ts ("URL targets and bare URLs are not words …")
- docs/adr/1210-*, 1900-*, 1902-*, 1904-*
