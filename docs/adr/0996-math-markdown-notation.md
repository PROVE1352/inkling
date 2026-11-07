# 0996. Math in Markdown: `$$` blocks and `$…$` spans, cut out around BlockNote's converter

- Status: Accepted
- Date: 2026-11-07

## Context
Every Markdown path of the server goes through `md/convert.ts` (`blocksToMarkdown`,
`markdownToBlocks`): export (.md / zip), MCP `read_page` / `find_context` output, `update_page` /
`patch_section` input, Markdown and zip import, Notion import, vault sync and templates.
BlockNote's Markdown converter knows no math syntax. Its parser also treats `_…_`, `*…*` and `\\`
as Markdown, which is most of LaTeX, and keeps `\$` as a backslash plus a dollar.

## Decision
- Notation: a math block is a `$$` line, the LaTeX verbatim (line breaks kept), a `$$` line. An
  inline equation is `$latex$`, written on one line without surrounding spaces. On import a line
  holding only `$$…$$` is also a block, and `$$x$$` inside a line is an inline equation.
- Inline rule (`scanInlineMath`, shared with the editor's typing rule): pandoc's
  `tex_math_dollars` — the opening `$` is followed by a non-space, the closing `$` is preceded by
  one and not followed by a digit, `\$` never delimits, no span crosses a line. This is what keeps
  `$5 and $10` as text.
- Mechanism: on export each math node is replaced by an alphanumeric sentinel (random nonce +
  counter, no punctuation, so the converter neither escapes nor splits it) and the LaTeX is put
  back after conversion, keeping the line prefix (indent, `>`) of a block. On import the spans are
  cut out of the source before parsing (outside fenced code, code spans, link destinations and
  autolinks) and the sentinels are turned back into nodes after; a sentinel that ends up inside a
  link label or code comes back as its `$…$` text.
- Escaping: a literal `$` in text is written as `\$` only where re-import would otherwise read math
  (the line has inline math or `$$`, or its text matches the inline rule). Prices stay unescaped.
  On import `\$` outside code becomes `$` (CommonMark; BlockNote's parser keeps the backslash).
- Tables: `|` inside inline LaTeX would end the cell, so in a table `\|` is written `\Vert` and `|`
  `\vert` (same rendering).
- Existing ```latex code blocks are not converted. The Notion importer, and only it, turns
  ```latex / ```tex fences into `$$` blocks (Notion's LaTeX code blocks), and Notion's `` $`x`$ ``
  inline form into `$x$`; its `$$` and `$x$` now import as math instead of code (it used to turn
  equations into code because the server had no math node).

## Alternatives considered
- **remark-math / micromark extensions**: a new dependency, and BlockNote's internal pipeline is
  not configurable from outside.
- **Emit math as text inside a paragraph**: corrupted by the parser on the way back (`a_1 * b_2`).
- **Escape every `$`**: changes the Markdown of every existing note with a price in it.

## Consequences
- `apps/server/src/md/math.test.ts`: export of blocks, inline, prices, literal dollars, tables,
  code; re-import gives the same nodes and a second export is byte-identical; hand-written input
  (one-line `$$`, indented `$$` in a list, unclosed delimiters, `\$`, code spans, latex fences in
  plain imports); Notion import; patch_section with math.
- Limits: LaTeX containing a `$` (e.g. `\text{$x$}`) or a line that is exactly `$$` does not round
  trip; inline LaTeX loses line breaks and surrounding spaces; a math block nested under a list item
  is exported flat like every other nested non-list block (BlockNote).
