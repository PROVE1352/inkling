# 2482. PDF preview: files up to 10 MB load on sight, larger ones on a press

- Status: Accepted
- Date: 2026-11-11

## Context
Uploads go up to 25 MB (`MAX_FILE_BYTES`). `GET /files/:id` answers no byte ranges (no `Accept-Ranges`, no
`Content-Length` on the stream), so pdf.js cannot draw page 1 before the whole file has arrived: the
cross-reference table is at the end. Opening a page to read its text would otherwise spend the whole PDF on
mobile data. The proposed default was 15 MB, to be checked by measurement.

## Decision
- A preview loads by itself when it comes near the screen and the file is at most **10 MiB**
  (`lib/pdfPreview.ts AUTO_LOAD_MAX_BYTES`). A larger file, a size the server does not give, and any file in
  a browser with the data saver on (`navigator.connection.saveData`) show "Load preview (25.1 MB)" and fetch
  nothing until it is pressed; the size and type come from `GET /api/files/:id/meta`.
- While loading, a bar shows the bytes against the size from the meta (pdf.js gets no total from the route).
- No range support is added to the route here. pdf.js already asks for ranges when a response offers them,
  so adding `Accept-Ranges` + `Content-Range` to `/files/:id` later would draw page 1 of a large file after a
  few hundred KB without changes in the web app.

## Measurement
Real Chrome (headless, playwright-core 1.65, `channel: 'chrome'`) against the server on localhost, the built
app, 2026-11-11, MacBook Air (Apple silicon). Hand-written PDFs of 20-25 pages, each page one uncompressed
580 x 580 RGB image (the worst case for size per page). Each row a fresh context with pdf.js already fetched
once; time from the start of the `/files/<id>` request to page 1's canvas in the DOM (20 ms polling); network
emulation through CDP `Network.emulateNetworkConditions` (40 ms latency):

| File | local | 20 Mbit/s | 5 Mbit/s |
| --- | --- | --- | --- |
| 5.0 MB | 0.47 s | 2.1 s | 8.2 s |
| 10.1 MB | 0.47 s | 4.2 s | 16.3 s |
| 16.2 MB | 0.07 s* | 6.6 s | 26.0 s |
| 21.2 MB | 0.08 s* | 8.6 s | — |
| 25.2 MB | 0.09 s* | 10.2 s | — |

\* pressed after the worker was up; the 5 and 10 MB rows start while the worker is still starting.
Download and first page differ by under 80 ms in every throttled row: the time is the transfer. Local
parsing and drawing are not the limit at any allowed size.

## Alternatives considered
- **15 MB** (the proposal): 6.6 s at 20 Mbit/s and 26 s at 5 Mbit/s spent without being asked on a page
  opened for its text. The papers this is for are mostly a few MB, so 10 MB still opens them without a press.
- **5 MB**: shows the button for many scanned handouts that load in 2-4 s on a good connection.
- **Always on a press**: the request was to see the PDF in the page; a click per PDF per visit is what
  downloading already was.
- **By connection type** (`effectiveType`): Chromium only and coarse; only the explicit data-saver flag is used.

## Consequences
- Files from 10 MiB up to 25 MiB need one press per file per tab (kept while the tab lives, not across a
  reload or another device: the next session's network may differ).
- With byte ranges on the route, the limit could rise or apply only to what is fetched before page 1; a
  proposal for later, not part of this change.

## References
- `apps/web/src/lib/pdfPreview.ts` (+ test), `apps/web/src/components/pdfPreview/PdfPreview.tsx`,
  `apps/server/src/routes/files.ts`, ADR 2480, ADR 2481
