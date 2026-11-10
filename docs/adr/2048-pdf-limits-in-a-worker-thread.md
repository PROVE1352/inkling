# 2048. PDF limits: a worker thread with a time limit, pages and characters per call

- Status: Accepted
- Date: 2026-11-10

## Context
A PDF is untrusted input. pdf.js parses synchronously in stretches; a hostile document can keep the
event loop busy or grow memory. Page-level yielding does not bound a single slow page.

## Decision
- Parsing runs in a `worker_threads` worker (eval'd script that imports unpdf by absolute URL, so it
  works under tsx and in the bundled image), with a heap cap (256 MB old generation) and a wall-clock
  limit of **10 s per call**: the worker is terminated at the limit; pages read so far are returned
  with "stopped after 10 s".
- **File size ≤ 20 MB** (bigger: metadata only). **Pages per call ≤ 50**, default 1–20, chosen with
  `pages` ("3", "2-5", "4-"). **Characters**: `maxChars` as for text (default 20,000, ≤ 100,000); the
  worker stops after the page that passes it. **Two PDFs at once** per process; a third waits for a
  slot within its time limit.
- The answer says what was read: `pages A–B of N`, `text cut at …`, `continue with read_file(file,
  pages="M-")`. Pages are separated by `--- page k ---`. All pages empty: "no text (a scanned PDF has
  only images of text; reading those needs OCR, which Inkling does not do)". Password-protected:
  "password-protected; its text cannot be read here". Damaged: "could not be read (damaged, or not
  really a PDF)". The text is wrapped as untrusted and scanned (ADR 2046).
- Measured (Apple Silicon Mac, Node 22.23, generated PDFs with 50 text lines per page, 5 runs each,
  measured while the database test suite ran in parallel): 3 pages / 14 KB → median 73 ms; 50 pages /
  231 KB and 200 pages / 929 KB, asking for pages 1–50 with maxChars 100,000 (it stops after page
  35 at that cap) → 122 and 129 ms. Worker start and loading pdf.js are about
  45 ms of that. The main thread's longest timer gap during a call was 2.6 ms (1 ms interval timer):
  parsing does not block the event loop.

## Alternatives considered
- **Parse in the main thread, yield between pages**: one slow page still blocks every request.
- **A long-lived worker pool**: saves ~40 ms of start-up per call, but a hostile document's state
  would outlive its call; terminate-per-call is the simple guarantee.
- **A child process**: more isolation, more memory, and the image has no other process to manage.

## References
- apps/server/src/pdfText.ts (`PDF_LIMITS`, `extractPdfText`), apps/server/src/mcpTools/historyInkFileTools.ts (`readPdf`)
