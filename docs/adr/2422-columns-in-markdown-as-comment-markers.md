# 2422. Columns in Markdown are comment markers around each column

- Status: Accepted
- Date: 2026-11-11

## Context
Agents read and write pages as Markdown (read_page, update_page, create_page, patch_section); people
export Markdown and zips, import them, and sync an Obsidian vault. Inkling writes nodes Markdown has no
syntax for as `<!-- inkling:… -->` lines (ADR 1500, 2122, 2169). Markdown has no columns.

## Decision
```
<!-- inkling:columns -->                      (or <!-- inkling:columns {"widths":[60,40]} -->)
<!-- inkling:column -->
left blocks
<!-- inkling:column -->
right blocks
<!-- /inkling:columns -->
```
- Written in **every** notation mode (agent, plain, file): vault sync, zip/Markdown export, templates and
  history previews carry the group; a tool that does not know the markers shows the blocks one after
  another, and Obsidian hides the comments. Embeds stay agent/file-only as before.
- `widths` (whole percent, adding up to 100) only when the columns differ; read back as weights, so
  doc → Markdown → doc keeps the stored numbers (`weightsToPct` / `pctToWeights`).
- Reading (md/notation.ts `extractNotation` + `groupColumns`): only top-level markers (no indent, no `>`)
  count. A group is an open marker, a column marker right after it, 2–4 columns and a close marker; an
  empty column gets an empty line. Anything else drops its markers and keeps every block: no close, a
  nested group (all markers from the outer open to its close), stray column/close markers, blocks before
  the first column, 1 or 5+ columns, props on a column or close marker. Widths that do not fit
  (wrong count, not numbers, out of range) are ignored (equal columns). Indented or quoted markers stay
  comments, which BlockNote's parser drops.
- Server writers: `appendOnConnection` (update_page append) counts a top-level `columnList` as a block.

## Alternatives considered
- **JSON for the whole group in one token**: unreadable to people and other tools; the content would
  not be Markdown.
- **A fenced block (` ```columns `)**: other tools would show the content as code.
- **Attribute syntax** (`widths="50,50"`): every other Inkling token is JSON; the parser already
  validates JSON props.

## Consequences
- Tests: md/columnsNotation.test.ts (modes, round trip, ten broken inputs), md/columnsMcp.db.test.ts
  (create_page, read_page, update_page replace/append, zip export → import).
