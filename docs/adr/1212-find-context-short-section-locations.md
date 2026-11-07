# 1212. find_context: the last heading and a short anchor instead of the whole path

- Status: Accepted (amends the output format of 0927)
- Date: 2026-11-07

## Context
Each fragment printed its location three times: the title line `[n] Title › H1 › H2 › H3`, the anchor
(the slugged path again, `h1/h2/h3`) on the id line, and once more in "Also relevant" lines, which also
repeated the page title and id per section. On the field query one location ran past 200 characters;
Korean counts one token per character (ADR 0926), so the headers of five results cost ~750 tokens of a
1,500 budget. `pack` charged a flat 30 tokens per header, so the real output was 2,511 tokens for a
budget of 1,500.

## Decision
- **Short anchor** (`chunker.ts` `shortAnchors`): the shortest suffix of the anchor, in `/` segments,
  that no other anchor of the same page equals or ends with. `요강-요약/준비-사항/우리-팀-체크리스트`
  → `우리-팀-체크리스트`; two "Decided" sections under "Alpha" and "Beta" print `alpha/decided` and
  `beta/decided`; `setup/backups~2` → `backups~2`. retrieve.ts reads the anchors of the pages that may
  be shown (one query on `page_chunks`, `part = 0`) after ranking.
- **Heading tail**: the title line shows as many trailing headings as the short anchor has segments
  (`[2] 00 대회요강 › 우리 팀 체크리스트`); the full path only where the leaf heading alone is
  ambiguous on the page. Merged neighbours are separated by `§short — heading`.
- **"Also relevant"** is one line per page: `- page of [2]: §a ~N tok, §b ~M tok` for a page already
  shown, `- Title (page <id>): §a ~N tok` otherwise. Sections of merged fragments are no longer listed
  again (the old de-duplication looked at the first section only).
- **Honest budget**: `pack` charges each chunk its real header (title, heading tail, short anchor,
  page id, version) plus 15 tokens for the `can:`/`edited by` facts the MCP layer adds
  (`HEADER_FACTS_TOKENS`).
- **Compatibility**: `findSection` (used by read_page `section`, patch_section, comments) accepts a
  short anchor: right after the exact anchor/block-id check, a reference that is the suffix of exactly
  one anchor (and equals none) resolves to it. Full anchors, `A › B` / `A > B` paths, heading text and
  block ids resolve as before; a suffix shared by two anchors falls through to the old rules. Outline
  output keeps full anchors. The REST answer (`GET /api/context`) keeps every old field and adds
  `short` and `heading` to `sections[]` and `more[]`. The renderer prints the old form for result
  objects without them.

## Numbers
Same ranking, budget 1,500, `estimateTokens` of the tool output (`scripts/context-bench.ts`, 47 questions,
15,693 chunks), relevance floor off so every answer fills the budget:

| location | section text | everything else | fragments |
|---|---|---|---|
| full path (old) | 689.9 | 579.4 | 8.1 |
| short | 735.2 (+45.3, +6.6%) | 439.1 (−24%) | 8.7 |

The synthetic headings are short. On the restored production copy (field query, budget 1,500, same new
ranking): section text 845 → 990 tokens (+145, +17%), everything else 902 → 621 (−31%), fragments
5 → 6. Before this change the same query printed header lines of up to 310 characters; now at most 119.

## Alternatives considered
- **Block id or a hash as the id** (`§k3f9`): shortest, but meaningless to the agent, and a new
  reference form every tool would need to accept; the suffix is readable and already resolvable.
- **Last segment only, always**: ambiguous on pages with repeated headings ("결정된 것" under several
  parents); a wrong section would be read or, for `append`, edited.
- **Keep the full path, drop the title line**: saves less and loses the page title the agent cites.

## Trade-offs
- A short anchor depends on the rest of the page: adding a second "결정된 것" makes `결정된-것`
  ambiguous; that reference then answers 404 with the list of anchors (the full anchor always works).
  The same holds today for renamed headings.
- The header estimate now varies per chunk; packing is still O(n log n).

## References
- apps/server/src/context/chunker.ts (`shortAnchors`, `headingTail`, `findSection`)
- apps/server/src/context/rank.ts (`headerTokens`, `sectionSeparator`, `pack` labels)
- apps/server/src/context/retrieve.ts (`sectionLabels`), apps/server/src/mcpTools/contextTools.ts (`renderFindContext`)
- context.db.test.ts ("short anchors from find_context round-trip …")
