# 1960. A section name that passed to another section needs the version read

- Status: Accepted
- Date: 2026-11-10

## Context
find_context prints short section anchors (ADR 1212): the shortest end of the anchor that no other
section of the page ends with, `decided` for `alpha/decided`. Writes resolve them with findSection,
which takes "the one anchor ending in `/decided`", and falls back to heading-text rules that take the
first match. A short anchor is a name, and a name can pass to another section after it was printed:

- `# Alpha / ## Decided`; find_context prints `§decided v=…`. Someone inserts `# Beta / ## Decided`
  between `# Alpha` and its `## Decided`. The old section is now `beta/decided~2`; the new one is
  `beta/decided`, the only anchor ending in `/decided`. `patch_section(section='decided', mode='append')`
  (no version needed for append) wrote into the new section (wave 14 T, KNOWN-ISSUES draft MCP-SA-1).
- `# Beta / ## Decided` inserted above `# Alpha / ## Decided`: `decided` now ends two anchors and the
  heading-text fallback took the first, the new one.
- The same happens to an exact anchor: a second top-level `## Decided` inserted above the first takes
  `decided` and pushes the old one to `decided~2` (anchors number repeated paths in page order). The
  change log recorded this as "`decided` modified (keep me → new one)" and "`decided~2` added", so even
  ADR 1501's rename follow-up could not see it.

Full anchors that disappear are followed through the change log (ADR 1501); nothing checked a name that
still resolves, but to a different section.

## Decision
1. **Which section a write means** (`resolveSectionWriteRef`, context/sectionMoves.ts), before the claim
   check, the suggestion and the patch, in POST /pages/:id/section (patch_section, create_chart with a section), POST
   /pages/:id/sections (patch_sections, every edit), claim_section and add_comment:
   - `matchSectionRef` (chunker.ts, the same rules and order as findSection) classifies the ref:
     **exact** (the whole anchor, a heading block id, the whole heading path) or **loose** (only the
     end of the path: a short anchor, a heading text), and returns every section a loose ref fits.
   - **Rivals**: live sections other than the candidates that answered to the name before, from
     (a) the change log: anchors a `renamed` row moved away from that carry the name, followed to where
     they are now with traceAnchor (ADR 1501); a page's pending change-log rows are applied first, as
     changes_since does; (b) the section index, for the seconds before the change log catches up with
     typing: an indexed section with the name whose heading block is now another live section. A
     deleted section is no rival (as ADR 1501, a new section under the old name takes it over).
   - One candidate and no rival: that section, **no version needed** (the usual find_context →
     patch_section(append) flow is unchanged, no extra call). Otherwise `baseVersion` (the `v=…`
     find_context and the outline print next to every anchor) picks the section whose version equals
     it. Otherwise 409 `SECTION_AMBIGUOUS`, nothing written:
     `Section "decided" now names §beta/decided, but §beta/decided~2 answered to that name before (a
     heading was added, moved or renamed since you got it). Nothing was written. Read the one you mean
     with read_page(pageId, section=<anchor>) and retry with that anchor and its version as
     baseVersion; read_page(pageId, outline=true) lists every section.` / `Section "decided" fits 2
     sections: §beta/decided, §alpha/decided. …`. A version that matches none adds `; none of them has
     version <v>, so the one you read has changed`.
   - **No version in the error** (as ADR 1947): an agent that retried with a version handed to it could
     write into the wrong section with a "matching" version.
   - Exact anchors are checked the same way for writes that take a version (patch_section,
     patch_sections). claim_section and add_comment take no version, so an exact anchor is used as it
     is there; their loose refs are checked, and the error leaves out "and its version".
   - The section version covers the heading path and the body (chunker `sectionVersion`), so the
     version read picks the old section in the `decided` → `decided~2` case (same heading text, same
     body) and refuses in the `alpha/decided` → `beta/decided~2` case (the path changed: the agent must
     look).
2. **Change detection pairs an anchor that passed between headings** (context/sectionChanges.ts): when
   an anchor is held by a different heading block than before and the old block lives on under another
   anchor (or the new holder's block had another anchor before), both sides go through the rename
   pairing: `renamed decided>decided~2` + `added decided` instead of `modified decided` + `added
   decided~2`; deleting the first of two `Decided` gives `removed decided` + `renamed decided~2>decided`.
   A heading retyped as a new block (the old block gone) stays `modified`. The change feed says what
   happened, and rule 1 and ADR 1501 see it.

## Alternatives
- **Require `v=` for every write by a non-exact anchor.** Closes the case without history, but every
  agent that appends by short anchor without a version (what the tool description allows) gets one
  refusal first, and an append to a section someone else edited conflicts. Kept as the tie-breaker only.
- **Refuse only when the suffix fits two sections now.** Misses the reported case (the new section is
  the only one ending in `/decided`).
- **Print full anchors in find_context.** Costs tokens on every answer (ADR 1212) for a rare event, and
  does not help the exact-anchor case.
- **A block-id column in page_changes.** Exact identity, but a migration and a backfill; the anchor
  replay plus the index's block ids answer the question without it.

## Consequences
- Normal writes cost two small queries more (renamed anchors of the page; the page's distinct indexed
  anchors and block ids) and one outbox lookup; the events are loaded only when a rename carries the
  name. patch_section is rate-limited to 30 per minute per user.
- A write without a version is refused for up to CHANGE_FEED_RETENTION_DAYS (30) when a section that
  still exists once answered to the name (e.g. "Notes" renamed to "Old notes" and a new "Notes" added):
  the error says to read the section and pass its version. Deliberate: the agent's read may be older
  than the rename.
- Residual window: a structural edit whose change-log row was written by another process and is not yet
  committed, after its index pass; with the single-instance guard (ADR 1925) there is one process.
- Change feed consumers (changes_since, catch_up, activity, revert) see `renamed` + `added` where they saw
  `modified` + `added` for a heading inserted above a same-named one.

## Tests
`context/sectionNames.test.ts` (matchSectionRef, rivalSections incl. an index not caught up with typing,
computeSectionChanges pairing); `mcpTools/sectionNames.db.test.ts` (the T counterexample end to end:
refused, then written where the error points; two candidates picked by the version find_context printed;
the `decided~2` case; the usual flow with printed 8-character ids through read_page, patch_section,
patch_sections, add_comment, claim_section; no false alarm after a rename into the name or a delete and
re-add). The section-index branch (typing not yet in the change log) is covered by the unit test on
index rows only; no DB test edits a live document without its index pass.

## Not covered
- Reads still resolve a loose ref to the first match (findSection): `read_page(section='decided')` after
  the insert reads the new section and prints its version, so a read → `replace` with that version passes
  this check. The agent did read what it overwrites, but may have meant the other section.
- The added queries per write are not timed.
