# 1908. find_context output in 0.15.1: what changed in the bytes, and the tests that pin them

- Status: Accepted
- Date: 2026-11-10

## Context
find_context answers are pinned by determinism tests (same call → same bytes, ADR 0937/1543), by
"single query = byte-identical to before" tests (ADR 1720, 1723) and by format assertions in other
suites. ADR 1900–1907 change the bytes on purpose. This record lists every change, so a later diff of
an answer can be read against it.

## What changed in an answer
| part | 0.15 | 0.15.1 | ADR |
|---|---|---|---|
| page id in headers, pointers, title-only lines | 36 characters | 8 (longer only on a clash inside the answer) | 1906 |
| `can:` | in every fragment header | once at the end of the header line when the same for all fragments | 1906 |
| verification marks | `; verified` etc. in fragment headers | one `Verification: [n] …` line at the very end | 1907 |
| a cut section | `; truncated` | `; truncated, section ~N tok` | 1902 |
| text of a cut chunk | from a couple of lines before the first hit of any word | around the line with the most (idf-weighted) query words, table header kept | 1902 |
| chunks above 40% of the budget | whole when they fit | cut to 40% around their best lines | 1902 |
| which sections are shown | link lines / title-only matches could hold a page's slot; URL words counted | the page's own best section holds the slot; URL words ignored; English inflections and double particles matched | 1900, 1901, 1905 |
| empty answer | "…(synonyms, the other language), or list_pages." | names `queries=["q", "<translation>"]` | 1904 |
| weak answer, one query | — | `Not in any result: …` line before the verification line | 1904 |
| several queries | RRF k = 60, cut from the start | k = 10, cut around the query's words | 1905, 1902 |

Unchanged: the order of header parts otherwise (`§anchor v=…`, `matched:`, `edited by`, suspicious,
large page, review note, ink), the `<untrusted_content>` wrapper, the `Next:` line and the large-page
hint, the REST JSON (full ids; it gains `fragments[].fullTokens` on cut fragments).

## Tests
- Still true and unchanged: same call → same bytes, also after an unrelated edit (`context.db.test.ts`);
  `queries` with one distinct entry = the single-query answer (`multiQuery.db.test.ts`); semantic off =
  the lexical path.
- Updated to the new form: `context.db.test.ts` (8-character id patterns, `samePage`),
  `multiQuery.db.test.ts` and `multiQueryCorpus.ts` `includesSection` (8-character ids, header may end
  with `; can: … (all results)`, `; truncated, section ~N tok`), `semantic.db.test.ts` (ids, header),
  `verifyStatus.db.test.ts` (the `Verification:` line), `editLock.db.test.ts` (`can:` may be in the
  header). `evalRun.ts` parses ids of 8–36 characters and compares by prefix.
- New: `context/rank0151.test.ts`.

## References
- docs/adr/0937-*, 1543-*, 1720-*, 1723-*, 1900-* .. 1907-*
