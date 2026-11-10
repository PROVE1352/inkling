# 0308. The app's "Export as PDF" reaches the editor's node views

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR 0307 (what print.css does to the page body)

## Context
ADR 0307 prints the page body with print-only CSS. Its table, toggle and heading rules were written for plain
HTML; the page body is the BlockNote editor (0.51.4, pinned), whose screen styles outrank or bypass them. A
Chrome check on 0.18 (`page.pdf()` after the page menu's "Export as PDF", A4) found:

- A 12-column table lost its last columns. prosemirror-tables puts the sum of the column widths on the table as
  an inline `min-width` (120 px per column without a width, so 1440 px), BlockNote's
  `.bn-editor [data-content-type="table"] table { width: auto !important }` outranks print.css's
  `html.nd-printing table { width: 100% !important }` on specificity, and `.tableWrapper` clips what overflows.
- A closed toggle printed without its children: BlockNote hides them with `display: none` on the block group
  while `data-show-children="false"`, and the closed state is the default (per device, localStorage).
- Pages ended on a heading ("Code 3", "Code 6", … on pages 2–5 of the check page) with its code block on the next
  page. `break-after: avoid` was set on the heading, but Chrome ignores it on a block inside BlockNote's flex column (`.bn-block`); the code block is
  `break-inside: avoid`, so it moved alone. The 4.5em room under headings from the public page work (ADR 2361
  on w19/share, taken here verbatim) does not help when the next block is taller than that.
- In the dark theme the body text printed in the dark palette's ink (#e6e6e4, near white): BlockNote's root
  carries the `dark` class too, which redefines `--color-ink` below the html element where print.css sets the
  light palette.

## Decision
A separate `@media print` section at the end of `print.css`, for the editor's DOM only (`.bn-editor`,
`.bn-container`, BlockNote's toggle and table classes); the public page section and the shared rules above it
are unchanged, so it merges with w19/share line for line.

- Light palette on every `.dark` element below `html.nd-printing`, the editor's text in `--color-ink`, the
  Shiki light token colours and the light divider in the dark theme.
- The block-handle gutter (`.bn-editor` padding-inline, 54 px a side) and the header's matching inset are
  dropped on paper, as on phones.
- Tables: `.tableWrapper` without overflow or widget padding; the table 100 % wide with no `min-width`, `<col>`
  widths auto, cells without the 120 px minimum and wrapping at word boundaries (`overflow-wrap: break-word`);
  from 7 columns 8 pt type and smaller cell padding, as on the public page.
- Toggles (lists and toggle headings) print open; their arrow is screen-only.
- `.bn-block` is a plain block on paper, so `break-after: avoid` on a heading's block works; toggle headings
  get the same reserved room as plain ones.

## Alternatives considered
- Landscape pages or horizontal overflow for wide tables. The paper size is the person's choice in the print
  dialog; shrinking keeps every column on the page whatever it is. A very wide table (20 columns, long words)
  still wraps inside its cells.
- Opening toggles in the DOM before printing (`printPage.ts`). It would change the per-device toggle state
  and needs a restore; CSS leaves the document and the state alone.
- Making code blocks breakable so they start under their heading. Short code blocks would then split
  across pages; keeping the heading with its block is the rule people expect.

## Consequences
- Screen rendering is unchanged (every rule is under `html.nd-printing` inside `@media print`).
- `.bn-block` as a block on paper also means its two children no longer get flex-column layout when printed;
  they are full-width blocks either way.

Tests: Chrome check (scratchpad `w19-browser/uifix/check.mjs`, part B): a page with a 12-column table, a closed
toggle with two children, a toggle heading, a long code block and 22 headings, printed light and dark with
`page.pdf()`; `pdftotext` finds every cell of the last column inside the page width, both toggle children and
the toggle heading's child, and no page whose last line is a heading; under print media the body background is
white and body and code text dark. Before (5b43427): R1C12–R3C12 and all three toggle children missing, pages
2–5 ending on "Code 3", "Code 6", "Code 9", "Code 12", dark-theme body text luminance 0.94 and code 0.57; with
w19/share's print.css alone the same except two pages ending on a heading instead of four. After: all present,
the last column inside the page width, no page ends on a heading, body text 0.12.
