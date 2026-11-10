# 2361. "Save as PDF" on public pages is the browser's print, with the article marked while it is shown

- Status: Accepted
- Date: 2026-11-10

## Context
Visitors asked to keep a public page as PDF. The app already exports a page as PDF with the browser's
print dialog and `print.css` (ADR 0307: `printElement` marks the element and its ancestors, adds
`html.nd-printing`, calls `window.print()`); every print rule is scoped to `html.nd-printing`. A visitor
who uses the browser's own Print command, and a PDF made by a headless browser, never passes through a
button, so a scoped rule set that is only switched on around `window.print()` would print the whole
screen: the toolbar, the folder list, the dark palette.

## Decision
- No PDF on the server, no library: "Save as PDF" waits for diagrams (`mermaidIdle`, bounded as in the
  app), sets `document.title` to the page title (the PDF's default file name) and calls `window.print()`.
- `printElement` is split into `markPrintRoot(el)` and `printWhenReady(title, done)` (`lib/printPage.ts`);
  the app's page menu still calls `printElement`, unchanged in behaviour. The public article calls
  `markPrintRoot` when it mounts and undoes it when it unmounts, so the print rules apply to every print
  of the page. The rules sit in `@media print`, so the screen is not affected.
- One `print.css` for both: the public page adds a section (column at paper width, light text colour
  over the dark-mode override, tables as real tables with wrapping cells and a smaller type from seven
  columns, `.tableWrapper` unclipped, code wrapped, toggles open and without their arrow, button blocks
  hidden, Mermaid images inverted when they were drawn in the dark theme, as the app's PDF does).
- Headings: `break-after: avoid` did not keep a heading off the bottom of a page in Chrome (the headings
  sit in nested block wrappers; measured: two of four pages ended on a heading). Every printed heading,
  in the app and on public pages, now reserves 4.5em under itself (`::after` spacer with a negative
  margin, `break-inside: avoid`), which moves it to the next page instead.
- Link addresses are not printed after the link text: Chrome's PDF keeps links clickable, and the text
  would double every link in tables.

## Alternatives considered
- **Mark the article only around `window.print()` (as the app does)**: Ctrl+P and headless PDFs would
  print the whole screen.
- **`beforeprint` / `afterprint` listeners**: print emulation (`emulateMedia`) fires neither, so the
  print result could not be checked the way the dialog produces it; a mark that is always there needs no
  event.
- **Server-side PDF (headless browser) or a PDF library**: a new dependency and process for something
  the browser does (ADR 0882).

## Consequences
- The public page loads `print.css` (shared chunk, 5.4 KB, 1.3 KB gzip) with its own chunk.
- While a public article is shown, `html` carries `nd-printing`; nothing outside `@media print` uses it.

## References
- `apps/web/src/lib/printPage.ts`, `apps/web/src/print.css`, `apps/web/src/components/PublicToolbar.tsx`
  (`usePublicPrint`), ADR 0307, ADR 2106
