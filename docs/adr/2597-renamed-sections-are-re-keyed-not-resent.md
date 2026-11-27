# 2597. Renamed sections are re-keyed, not resent

- Status: Accepted
- Date: 2026-11-27
- Amends: 0932 (change feed pairing), 1540 (knownSections), 1501 (old anchors)

## Context
A section anchor is its heading path slugged (ADR 0926). An agent that replaces a page with
`update_page` and renumbers its headings ("3. Risks" → "4. Risks") gives every section a new anchor
and, since a version is sha1(heading path + body), a new version, while no body changed. Measured on a
page of 10 sections of ~300 tokens (`renameResend.db.test.ts` scenarios, `estimateTokens`):

- `read_page(knownSections={old anchor: v})` sent every renamed section in full: 12,793 characters
  (3,206 tokens) for a renumbering that changed no body. The old anchors were gone and the new ones
  unknown to the caller, so all ten were "changed or new" and all ten old ones "removed".
- `changes_since` already listed a heading-only rename without a body (`renamed 1-alpha → 2-alpha`),
  but without the new version, so a copy keyed by (anchor, v) needed an outline read to re-key.
- Dropping two sections and renumbering the rest made `changes_since` resend two unchanged bodies as
  a full `-`/`+` diff (6,327 characters, 1,584 tokens). The replace's minimal edit (ADR 1500) edits
  headings in place by position, so "3. Delta" kept the heading block of the dropped "3. Charlie";
  pairing by heading block id came first and paired Charlie with Delta (body changed), and the real
  Delta section was reported removed.
- `update_page` replace and a heading renamed in the editor keep heading block ids (10 of 10 in both
  measurements); pairing by block id or identical body already worked for pure renumbering.

## Decision
- **Pairing order** (`sectionChanges.ts`): same heading block id with the same body, then identical
  non-empty body, then same heading block id with a changed body, then identical (empty) body. An
  identical body is better evidence than a heading block re-used by position; an empty body is no
  evidence, so empty sections still pair by block id first.
- **changes_since**: a section renamed with its body unchanged prints its current version,
  `renamed 1-alpha → 2-alpha v=6190d3612394 (2. Alpha)`, when the section index holds exactly the body
  and heading path the log ends with (md5 of the joined index parts against the log's after text; one
  query for the page's renamed anchors, no text read). Otherwise the line stays as before. A renamed
  section whose body changed keeps its diff and gets no version.
- **read_page(knownSections)**: a known anchor that is gone is matched to a current section only when
  the caller's version is recomputed exactly: sha1(candidate old heading path + current body). The
  old heading text is stored nowhere (ADR 1501), so candidates are the current path with the old
  anchor's slug words put back (same word count per heading: numbers, lower-case words, Korean) and
  the heading paths the change log recorded under the old anchor. Sections tried: the one the change
  log traces the old anchor to (ADR 1501), then sections whose anchor differs only in numbers, nearest
  first, at most 16. A match prints `§1-alpha → §2-alpha v=… (renamed, body unchanged)` in the header
  and no body; the count line adds `N renamed (body unchanged)`. Everything not proven is read in full
  and its old anchor listed as removed, as before.
- **update_page replace** on a page with 3 or more sections ends with
  `hint: N of M sections changed their body (headings and order aside); patch_sections changes only
  the sections you name and costs fewer tokens than replacing the whole page.` when not every body
  changed. Nothing is refused.
- Anchors, versions and their formulas are unchanged; stored cursors and indexes stay valid.

## Alternatives considered
- **Store the old heading path or version with each rename**: exact for every rename, but a
  migration (out of scope) and the log already has the bodies.
- **Treat a body-identical rename in the change log as proof**: unsound; a body edit older than the
  log's retention (or merged into the rename row) would make a stale copy look current.
- **Match by heading block id only, as the editor does**: a replace re-uses blocks by position, which
  is exactly the wrong pairing above.
- **Version without the heading path**: a heading-only rename would keep its version, but every
  stored version and baseVersion would change meaning.

## Consequences
- Renamed lines in changes_since grow by ` v=` + 12 characters (+150 characters for ten renames).
- read_page(knownSections) decodes the document and reads the page's change-log anchors once when a
  known anchor is gone and some section changed; it no longer reads each renamed section, so it is
  faster in the measured cases (p50 ~112 → ~17 ms for the renumbered page).
- update_page replace decodes the document before and after the write to count bodies (p50 ~94–100 →
  ~105–114 ms on the 10-section page) and its answer grows by the hint line (80 → 254 characters).
- A heading whose words changed in case or count is matched only through the change log's recorded
  paths; otherwise it is read in full as before.
- catch_up uses the same pairing and shows the corrected removed/renamed lines, without versions.

## Measured
`apps/server/src/mcpTools/renameResend.db.test.ts` (renumber, renumber + one body, drop two + renumber,
editor rename with kept block ids, stale known version, hint on and off) and
`apps/server/src/context/renameResend.test.ts` (pairing order, candidates, proof, hint count). Sizes and
latencies in [PERFORMANCE.md](../PERFORMANCE.md).
