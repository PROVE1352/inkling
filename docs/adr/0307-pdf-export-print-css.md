# 0307. "Export as PDF" = print-only CSS + window.print()

- Status: Accepted
- Date: 2026-11-07

## Context
Users want a PDF of a page. BlockNote's PDF exporter (`@blocknote/xl-pdf-exporter`) is GPL-3.0 and
cannot ship in an MIT app; server-side headless Chrome is heavy for a self-hosted install.

## Decision
The page header (desktop button, mobile ⋯ menu) calls `printElement(bodyRef)`: it marks the page body
`[data-print-root]` and each ancestor `[data-print-ancestor]`, adds `html.nd-printing`, and calls
`window.print()`. `print.css` (only under `@media print`) hides everything off the ancestor chain
(sidebar, header, right panel, portals), flattens the chain to block flow so long pages paginate,
hides editor chrome (side menu, toolbars, table handles, collaboration cursors, `[data-print-hide]`),
forces the light palette, avoids breaks inside images/code/rows and after headings, wraps code blocks
(`pre-wrap`), lets wide tables shrink and repeats table headers. Windowed collection views render all
rows (up to 3 000) on `beforeprint`. Cleanup runs on `afterprint` with a fallback on the next
interaction (some browsers never fire it).

## Alternatives considered
- **@blocknote/xl-pdf-exporter**: GPL — excluded.
- **Server-side Puppeteer/Chromium**: pixel-perfect, but a large binary and attack surface.
- **jsPDF/html2canvas**: rasterized text, poor quality, large bundle.

## Trade-offs
Output depends on the browser's print engine; the user picks "Save as PDF" in the print dialog.

## How others solve it
Notion's web "Export → PDF" is server-rendered; Obsidian and many web editors rely on print CSS.

## Consequences
Verified in headless Chromium: sidebar/header hidden, collection timeline printed across pages, a
220-character code line wrapped.

## References
- apps/web/src/lib/printPage.ts:6
- apps/web/src/print.css
- apps/web/src/pages/PageView.tsx (Export as PDF button / menu item)
- apps/web/src/lib/useWindowedRows.ts (`PRINT_CAP`, beforeprint)
