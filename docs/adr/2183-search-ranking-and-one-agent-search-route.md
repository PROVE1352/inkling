# 2183. search ranks title > heading > body, whole word before part; one agent search route over every workspace

- Status: Accepted
- Date: 2026-11-10

## Context
The MCP `search` tool was a substring match ordered per workspace. It listed the person's workspaces
(`GET /api/workspaces`) and called the web app's `GET /api/workspaces/:id/search` once per workspace,
one after another, concatenating the answers: each workspace's 20 newest title matches and then its body
matches. Field report: searching `harness` returned 20 results in which a hackathon document, another
project's `HARNESS.md`, an experiment log and test cases came mixed, because a body that merely
contained `prharness` in workspace 1 printed before an exact `HARNESS.md` title in workspace 2, and the
person has one workspace per contest. Measured on the old code (same data as the example in ADR 2184):
the `Harness test plan` and `HARNESS.md` titles printed third and fourth, after two body matches of
another workspace; `limit` did not exist; each extra workspace added one request and one full-table
trigram probe of `page_texts` (the body probe has no workspace column).

The web route's order and size are part of the web app's search screen and stay as they are.

## Decision
- **New route** `GET /api/search?q&workspaceId&limit` (`routes/agentSearch.ts`), used by the MCP tool,
  plain session/bearer route like `/api/context`. With `workspaceId`: `requireMembership` (the same
  membership, range, 2FA and agent-block checks and errors as the web route). Without: the workspaces
  find_context searches (`memberWorkspaceIds`: live, not 2FA-blocked, not blocking this agent, in the
  connection range). Pages: live, `visibleTo` rule (private pages are the author's) and
  `pageInRangeSql` (connection range, guest scope). `limit` 1–50, default 10. Read-only tokens may call it
  (GET). Like the web route it records no taint read (ADR 2040): snippets are short and the old route did
  not either.
- **Match set unchanged**: title `ILIKE` or `page_texts.text ILIKE` (escaped), from 3 characters through
  the two trigram probes of ADR 0755, the OR form below that. Only order, cap and counts are new.
- **Rank** (one integer per page, then `updated_at DESC`, then `id`; same documents → same order,
  ADR 0937):
  0 title equals the query (case-insensitive) · 1 title contains it as a whole word · 2 title contains it ·
  3 a heading (`page_chunks.heading_path`) contains it as a whole word · 4 a heading contains it ·
  5 the body contains it as a whole word · 6 the body contains it. Recency is only the tie-break inside a
  grade.
- **Whole word** (`agentSearchText.ts wholeWordPattern`, run by Postgres `~*` and by JS for the
  snippet): the escaped query with `(?<![W])` before and `(?![W])` after, where W is a written-out class
  (ASCII letters/digits/_, Latin-1 and Latin Extended letters, Greek, Cyrillic, Hangul jamo and syllables,
  kana, CJK) instead of `[[:alnum:]]` or `\m \M`: those follow the database's LC_CTYPE, and in a "C"
  database every non-ASCII letter is a non-word character (Korean would always be "whole word"). A side
  whose edge character is not a word character gets no test (`C++`, `.md`, `v1.2` work; `\m…\M` never
  matched those). Regex characters are escaped (same escape set valid in both engines). **Korean**: a query
  ending in a Hangul syllable may be followed by a particle that fits its final sound
  (`context/rank.ts particleFamily`: 을/를, 은/는, 이/가, 에서, 으로, 까지 …) and one more of 는/은/도/만,
  then the boundary: `해커톤에서`, `해커톤에서는`, `하네스를` are whole words for 해커톤/하네스;
  `해커톤장`, `하네스테스트` and copulas (`해커톤이다`) stay partial. Measured on this database (en_US.utf8):
  `'해커톤에서' ~* '\m해커톤\M'` is false, so the plain rule would make Korean whole-word matches rare.
- **One statement**: candidates (`cand`, materialized, with the body regex computed while the row's text
  is at hand and skipped for title matches), heading flags as one grouped join of the candidates' section
  rows, grades, per-workspace match counts (`counts`, from the whole candidate set, so workspaces without a
  shown result are counted too), the top `limit` rows, and for those only: the first matching section
  (anchor, heading path, all anchors of the page for find_context's short anchor, ADR 1212) and a ±160
  character window of the body around the first (whole-word first) match, from which Node cuts the
  ±60-character snippet. No full body leaves the database.

## Alternatives considered
- **Keep the per-workspace calls and sort in the tool**: N requests and N global body probes remain, and
  the per-workspace cap of 20 hides matches before the sort sees them.
- **Change the web route**: its order and page size are the web app's; agents and people want
  different defaults (count, grouping, sections).
- **find_context's ranking (bm25-like, idf, phrases)**: search is the "exact string" tool; a scored
  ranking would answer the same question find_context answers. The grade order is explainable in one line.
- **Correlated heading probes per candidate** (`EXISTS (… page_chunks WHERE page_id = p.id …)` twice):
  about 10 µs per probe (one flag over 10,000 pages: 96 ms for "ai", 25 ms for "deploy"); in a first, short run (N = 10, a
  database holding 10,000 pages) "ai" in one workspace took 194 ms against the web route's 115 ms. Rejected.
- **Heading flags from a scan of every section row of the searched workspaces**: fast for common words,
  but a rare word paid the scan (6.3 ms vs 3.8 ms, one workspace). Replaced by the join on the candidates.
- **Body regex in a second pass** (join `page_texts` again after the heading join): read each body twice;
  "ai" 78 ms vs 72 ms. Rejected.
- **`\m…\M` or `[[:alnum:]]`**: locale-dependent and wrong at non-word edges (above). Timing was the same
  (≈4 µs per 1.8 KB body for every form measured).
- **Full-text (`tsv @@`) for whole words**: the `simple` parser keeps `harness.md` and URLs as single
  tokens, so it disagrees with the title rule; and bodies are not in a tsvector per page.

## Consequences
- Latency (`scripts/search-bench.ts`, 5,000 pages, OAuth bearer through `app.inject`, p50 ms, before =
  list + one web search per workspace, after = `/api/search`): 1 workspace — "ai" 50.6 → 72.2,
  "deploy" 19.8 → 20.3, "zanzibar" 4.3 → 2.8; 5 workspaces — 79.3 → 72.6, 102.4 → 24.2, 35.5 → 6.6;
  10 workspaces — 106.2 → 73.4, 182.7 → 22.5, 29.8 → 3.1. These "after" numbers repeat three terms,
  so Postgres's per-connection regex cache always holds the compiled pattern. A term not seen before
  compiles its pattern once per call (the written-out class is large; case-insensitive compilation costs
  more than for `\m…\M`): +0.5–0.6 ms p50 measured with rotating case variants of the same words
  ("zanzibar" 3.08 → 3.69 ms over 10 workspaces, 3.02 → 3.52 ms in one 500-page workspace; "deploy"
  21.27 → 21.77 ms). So the one-workspace rare-word gain is about 4.3 → 3.4 ms for a new term, not
  4.3 → 2.8. A two-character query that matches every page
  of one workspace is slower (it now grades all 5,000 matches instead of sorting the newest 20); with
  several workspaces every query is faster and one request instead of W + 1.
- The ranking explains itself (`match`, `exact` in JSON), and a heading match names its section, so the next
  call can be read_page(section=…) or find_context.
- Recall is the old route's: pages whose only occurrence is in the middle of a body cut at 200 KB
  (ADR 1040) are still not found by search (find_context covers the whole document).
- Tests: `mcpTools/search017.db.test.ts` (grades, ties, regex characters, Korean particles, visibility,
  read-only tokens), `routes/agentSearchText.test.ts` (patterns, snippets), `tokenRange.db.test.ts` (the
  route under a subtree range).

## References
- apps/server/src/routes/agentSearch.ts, routes/agentSearchText.ts, mcp.ts (`search`),
  mcpTools/testHarness.ts, index.ts
- apps/server/scripts/search-bench.ts
- docs/adr/0755-*, 0937-*, 1040-*, 1200-*, 1212-*, 1700-*, 2184-*
