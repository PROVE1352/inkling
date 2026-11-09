# 1540. `known` versions: unchanged pages come back as one line

- Status: Accepted
- Date: 2026-11-09

## Context
Agents re-read the same pages: a loop that checks its context every round, a second agent working on
the same question, a user asking a follow-up. Each re-read returns the whole page again even when
nothing changed, and that body (1–2k tokens for a typical wiki page) is the largest part of an agent's
Inkling traffic. Sections already have a version (`v=…`, the patch_section baseVersion, ADR 0926);
pages did not.

## Decision
- **Page version**: `pageVersion` (`context/pageVersion.ts`) — the first 12 hex characters of a SHA-1
  over kind, title, the properties read_page prints (without `fullWidth`) and the trimmed Markdown
  body before any maxChars/budget cut. No schema column: it is computed from the same state the body is
  read from (read_page: the export route; read_pages: the live document or the stored state), so
  "unchanged" means "you would receive the same content". `updatedAt` is not part of it.
- read_page prints `- version: <v>` in its header; read_pages prints `v=<v>` in each page line.
- `read_page(pageId, known=v)`: when the version matches, the answer is one line
  `unchanged (page <id> v=<v>; can: <…>)` instead of the header and body. With `section=…`, `known` is
  the section version and the line names the section (`unchanged (page <id> §anchor v=…; can: …)`); a
  section reached through a heading rename (ADR 1501) is never "unchanged".
- `read_pages(pageIds, known={pageId: v})`: the route takes `known=id:v,…`; a known page is read first
  and, when unchanged, listed under `unchanged` without consuming budget (so it never crowds out the
  next page); the tool prints those lines first, then the pages that changed.
- `read_page(pageId, knownSections={anchor: v})`: the outline is compared with the caller's versions;
  changed and new sections come back in full, the unchanged ones as a count, missing anchors as
  `removed: §…`. Non-document pages fall back to a full read.
- **Nothing is hidden behind "unchanged"**: the comparison happens only after the normal
  permission-checked read (REST route, visibility, range), so a trashed page, a page made private or
  one outside the connection range is the usual error or "Not found or not visible"; the `can:` facts
  are always printed, so a permission change shows even when the content did not; the `applies:`
  line stays in front as on every page tool.

## Alternatives considered
- **`updatedAt` or the stored-state stamp as the version** (cheap, no body read): `pages.updated_at`
  also moves for metadata changes and trails the live document by the store debounce (ADR 0757), so
  an agent could be told "unchanged" while an open document already differs; the stamp changes on
  saves that change nothing. Hashing what the tool would print is exact. Cost: the server still
  reads and renders the body — this saves tokens, not server time (measured: read_page latency is the
  same, docs/PERFORMANCE.md).
- **Hash of the outline's section versions**: covers only text the chunker sees (light Markdown) and
  no properties or non-document pages.
- **ETag / If-None-Match on the REST routes**: the MCP tool still has to say something to the agent;
  the tool argument is the interface agents use, and the route stays a plain GET.
- **Diffs instead of full bodies for changed pages**: that is changes_since's job (cursor-based,
  ADR 0932); `knownSections` is the middle ground for one page.
- **`known` on find_context**: its fragments already carry section versions; a repeat of the same
  query is byte-identical (prompt-cache friendly, ADR 0937) — left for a later step, see the
  measurements.

## Consequences
- Bench (2,000 pages, 3 agents × 8 questions, `scripts/mcp-token-bench.ts`; each agent reads the
  pages find_context names, up to 3 per question — 11 reads per agent per pass, since find_context
  usually answered with one or two pages): re-reads with nothing changed 39,231 → 759 tokens (−98.1%); re-reads after a person edited the top page of every
  question 39,495 → 27,273 (−30.9%); the whole three-pass flow 134,301 → 83,607 (−37.7%).
  read_pages of three unchanged pages 3,781 → 70 tokens. Latency unchanged (same work on the server).
- An agent has to keep the version it read. The tool descriptions say how; the server instructions
  are unchanged (they are in every client's context).
- `read_page`'s header gains one line (`- version:`), read_pages' page line one field: additive.
- Tests: `mcpTools/tokenSaving.db.test.ts` (unchanged / changed / trashed / renamed / another member's
  private page / section / read_pages budget / knownSections).

## References
- apps/server/src/context/pageVersion.ts, apps/server/src/mcpTools/tokenSaving.ts
- apps/server/src/mcp.ts (`read_page`), apps/server/src/mcpTools/contextTools.ts (`read_pages`,
  `renderReadPages`), apps/server/src/routes/context.ts (`GET /pages/read`)
- ADR 0926, 0937, 0976, 1501
