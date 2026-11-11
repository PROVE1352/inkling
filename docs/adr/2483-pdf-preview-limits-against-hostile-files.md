# 2483. PDF preview: limits that keep a hostile or huge PDF inside its own block

- Status: Accepted
- Date: 2026-11-11

## Context
The preview (ADR 2480, 2481) sizes its layout from numbers in the file. A review of the first version found
that a PDF with ten million pages made the preview build a ten-million-entry array and spread it into
`Math.max`, which threw. Such a file takes 1.5 KB: a page tree whose `/Kids` repeat one node (ten
references, seven levels deep) has ten million real pages, and pdf.js reports them (a `/Count` that only
lies is corrected by pdf.js, which counts the pages when the last one is missing); with no error boundary around the preview, React
unmounted the whole app and the tab showed the app's error screen for every member who opened the page.
The same kind of number decides the page size (`/MediaBox`, `/UserUnit`), and the canvas resolution had a
floor of 0.25, so a page of 190,000 pt asked for a canvas of tens of thousands of pixels a side. Members
attach files from anywhere; the preview must treat every number in a PDF as hostile and keep any failure
inside the block it belongs to.

## Decision
All limits live in `lib/pdfPreview.ts` (pure, unit tested) and are applied in `PdfPreview.tsx`.
- **Page count**: a PDF of more than `PDF_MAX_PAGES` = 5,000 pages, or whose count is not a positive
  integer, is not previewed: the block says "This PDF has too many pages (N) to preview here" with the
  download link (`checkPageCount`). Nothing is sized from the count before this check, and no array is
  spread into a function call (`widestOf`). 5,000 is several times the longest documents people attach
  (books, standards); the layout keeps one number per page.
- **Only nearby page boxes exist**: the layout keeps one size per page, but only the page boxes near the
  view are in the DOM, placed at their computed tops, so 5,000 pages are a handful of elements.
- **Drawing per pass**: at most `MAX_DRAW_PER_PASS` = 8 pages are drawn at once (`cappedWindow`), however
  many fit in the view (2,000 pages of 0.5 pt all "fit").
- **Page size**: a page box is at most `MAX_PAGE_CSS` = 5,000 CSS px on its long side at 100% (`pageBox`);
  larger pages (a 190,000 pt MediaBox, `/UserUnit 1000`) are scaled down to it. Sizes that are not finite
  and positive count as a Letter page.
- **Canvas size**: one page canvas holds at most 8,388,608 pixels (32 MiB of RGBA) and 8,192 px a side
  (`outputScale`, no floor). Below a factor of 0.05 the page keeps its place undrawn instead of drawing an
  unreadable picture. Image limits inside pdf.js are in ADR 2480.
- **Error boundary per preview**: each portal renders inside its own boundary (`PdfFileBlock.tsx
  PreviewBoundary`); anything a preview throws while rendering becomes "The preview could not open this
  PDF" and the download link in that block. The page, the editor and the other previews go on.
- **Failures on a page**: a page whose `getPage` or render fails is left for a later pass (after 3 s)
  instead of staying blank; when page 1 cannot be read the block shows an error.
- **Stalled downloads**: a download that has not moved for 30 s ends in "The file stopped loading" with a
  retry, instead of a progress bar forever.
- **Offscreen previews**: more than 1,200 px away from the screen a preview lets go of its canvases at
  once and, after 10 s, of its document (the box keeps its height, so nothing below moves; the document
  closes 15 s later unless another preview of the same file uses it, ADR 2480). Coming back loads it again
  at the page and zoom it had. A full-screen view is never parked. A page of 12 PDFs scrolled to the end
  keeps the documents of the previews near the view only.

## Alternatives considered
- **A byte-size limit only**: the counts and sizes that break the layout fit in a few hundred bytes.
- **Asking pdf.js for every page's size up front**: 5,000 `getPage` calls before the first picture, and the
  same hostile numbers come back.
- **A global error boundary**: the app already has one; it is what turned one bad file into an app-wide
  error screen.

## Trade-offs
- Files over 5,000 pages are download-only. Pages larger than 5,000 CSS px are shown scaled down at 100%;
  zooming in up to 400% still works, at the canvas cap's resolution.
- Parking means a reader who scrolls away and back after 25 s has the file parsed again (the bytes can come from
  the browser's HTTP cache: `/files` is `private, max-age=31536000, immutable`).

## Consequences
- `lib/pdfPreview.ts` (`PDF_MAX_PAGES`, `checkPageCount`, `pageBox`, `outputScale`, `cappedWindow`,
  `widestOf`) and its test, `components/pdfPreview/PdfPreview.tsx`, `PdfFileBlock.tsx`, `pdfDocument.ts`
  (`__inklingPdfStats` for the browser check), `i18n/{en,ko}/pdf-preview.ts`.

## References
- ADR 2480, ADR 2481, ADR 2482
