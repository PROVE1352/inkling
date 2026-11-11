# 2480. PDF preview: pdf.js in the web app, every file from the app's own origin, nothing in the PDF runs

- Status: Accepted (extends 0882 for one dependency)
- Date: 2026-11-11

## Context
A PDF attached to a page shows only its file name; reading it means downloading it. People asked to read it
in the page, together with the rest of the team ("PDF 다운은 됨"). `GET /files/:id`
(`apps/server/src/routes/files.ts`) sends every non-raster file with `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so a browser
never renders a stored PDF (or SVG, HTML, text) as a document of the app's origin. That stays. The web app
had no PDF code; the server extracts PDF text with `unpdf` 1.9.1 (`apps/server/src/pdfText.ts`).

## Decision
- **Library**: `pdfjs-dist` **6.5.438** (Apache-2.0), the one new dependency, in `apps/web` only, pinned
  without a caret. Published 2026-11-01 (10 days before this change; the latest release, pdf.js ships
  monthly and has no patch line, so the newest release carries the newest fixes). pnpm 11 here reports no
  `minimumReleaseAge`, so no exception list was needed. The **legacy build** (`legacy/build/pdf.mjs` and its
  worker), not the modern `build/`: pdf.js 6's modern build calls `Promise.try`, `Map.prototype.getOrInsertComputed`,
  `Math.sumPrecise` and `Uint8Array` base64/hex methods without polyfills, which only the newest browser
  releases have (some not even in every current browser), while the rest of the app runs on older ones. The legacy build carries polyfills and is what pdf.js supports for older browsers: Firefox ESR,
  Chrome 125+ (Edge and Opera on the same engine) and, as pdf.js puts it, "mostly" Safari 18+. Those are the
  preview's minimum browsers; elsewhere the file block shows its name line and download as before (an
  unsupported browser ends at the preview's error message). Its Node-only optional
  dependency `@napi-rs/canvas` is not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`):
  installing it would also have resolved unpdf's optional peer on the server, changing the server's
  dependency graph and pulling 12 native packages into the lockfile.
- **Bytes**: pdf.js fetches `/files/<id>` itself (same origin, so the session cookie goes along; the
  attachment header does not matter to `fetch`). It asks for byte ranges only when the response says
  `Accept-Ranges: bytes`; the route does not, so the whole file streams once (ADR 2482 for when).
- **Where pdf.js lives**: `components/pdfPreview/pdfDocument.ts` imports pdf.js and is itself a lazy chunk
  (`assets/lazy/pdfDocument-*.js`), imported only when a preview starts loading a file. The worker is
  imported with `?url` and emitted under `assets/lazy/` (`assetFileNames` in `vite.config.ts`). The
  `inkling-pdfjs-assets` Vite plugin copies the Adobe cMaps (CJK text is unreadable without them), the
  standard fonts, the wasm image decoders with their no-wasm fallbacks, the ICC profile and their LICENSE
  files to `assets/lazy/pdfjs-<version>/`, and serves the same paths from `node_modules` in `vite dev`.
  The version is in the path because `assets/` is served `immutable` for a year (`httpCache.ts`) and these
  files have no content hash. `assets/lazy/` keeps all of it out of the PWA precache (`globIgnores`);
  the service worker caches what is used, in a cache of its own (`inkling-pdfjs`, 60 entries, 30 days), so a
  CJK PDF's cMaps do not push Shiki grammars or exceljs out of `inkling-lazy-assets` or the other way round.
  pdf.js's own `LICENSE` is copied to the same folder (the worker keeps pdf.js's licence header, the bundled `pdfDocument-*.js` chunk does not). No CDN.
- **CSP**: unchanged. The SPA policy has `worker-src 'self' blob:` and `script-src 'self'`; the worker is a
  same-origin module worker. The worker's response carries no CSP of its own (only `text/html` gets the
  SPA policy, `embedCsp.ts`), so pdf.js compiles its wasm decoders there (checked in Chrome 157: openjpeg,
  jbig2 and qcms compile inside the running pdf.js worker); the page itself never needs `wasm-unsafe-eval`
  or `unsafe-eval`.
- **One worker per tab**: one `PDFWorker` serves every document; documents are shared by address and kept
  15 s after the last preview lets go (a node view is rebuilt on every prop change, ADR 2481). A download
  whose last preview went away (the reader left the page) is cancelled after 1.5 s, and a load that failed
  is dropped at once. Each loading task is destroyed and awaited; the worker goes when the last document
  has gone.
- **Images and canvases**: pdf.js leaves out images over 2^26 pixels (`maxImageSize`) and scales decoded
  images over 64 MiB down in the worker (`canvasMaxAreaInBytes: 2^26`), so a small file cannot make the tab
  decode a gigapixel picture. Page canvases have their own limits (ADR 2483).
- **Nothing in a PDF runs or acts**:
  - The core API never runs PDF JavaScript; scripting is the viewer's QuickJS sandbox (`pdf.sandbox*`,
    `quickjs-eval.*`), which is not imported and not copied. `isEvalSupported` no longer exists in pdf.js 6
    (and `eval`/`new Function` appear in neither `pdf.mjs` nor `pdf.worker.mjs`), so there is nothing to
    turn off there.
  - XFA off (`enableXfa: false`); no annotation layer, so no form fields, no attachment list, no
    "open/launch" actions; annotation appearances are painted onto the canvas as pictures only.
  - Links are read from `getAnnotations()`: a URI link becomes an `<a target="_blank" rel="noopener
    noreferrer">` only for `http:`/`https:` (`lib/pdfPreview.ts safeLinkUrl`); `javascript:`, `file:`,
    `data:`, `mailto:` and Launch actions are dropped. A link to a place in the same PDF becomes a button
    that scrolls the preview to that page.
  - A password-protected PDF, a broken one and a file that is not a PDF stop at a message with the download
    link (`PasswordException`, `InvalidPDFException`); the preview never asks for a password.
- **Drawing on the main thread** (`disableWorkerRendering: true`): pdf.js 6's renderer worker would be a
  second worker file; rendering on the page thread is what every pdf.js before 6 did.

## Alternatives considered
- **The browser's own viewer** (`<iframe>`/`<embed>` of the file with `Content-Disposition: inline`): needs
  the route's headers relaxed for PDFs, which brings a PDF back as an active document of the app's origin
  (Chrome's viewer runs PDF JavaScript, other viewers differ), and mobile browsers do not embed it at all.
- **Pages rendered as images on the server** (pdf.js through unpdf, or poppler): a native canvas or binary on
  the server, CPU and storage per page, and no text to select. Out of scope by decision.
- **A CDN copy of pdf.js and its cMaps**: a third-party origin in `script-src`/`connect-src` and a request
  that leaks which pages hold PDFs; offline use would break.
- **`react-pdf` or another wrapper**: a second dependency around the same pdf.js; the wrapper's annotation
  layer and its CSS are what this change leaves out.
- **Passing the bytes (`data:`) after our own `fetch`**: loses pdf.js's range loading if the route gains
  `Accept-Ranges` later, and holds the file twice on the page thread.

## Trade-offs
- The pdf.js chunk is 445 KB (132 KB gzip) and the worker 1.27 MB (378 KB gzip), fetched on the first PDF
  preview of a session; data files are fetched per need (two cMaps for a Korean PDF, 49 KB). The entry
  chunk is unchanged; strings add 2.6 KB to the modulepreloaded i18n chunk (PERFORMANCE.md).
- pdf.js 6 is a month-old major line; an upgrade is a version bump and a browser check (the paths carry the
  version). The legacy build is larger than the modern one (polyfills), and the browser check exercises
  the polyfills on the page only (Chrome 157 with the newest built-ins removed), not inside the worker. A browser without module workers falls back to pdf.js's main-thread "fake worker", which works
  but blocks the page while it parses.
- The wasm decoders (JPEG 2000, JBIG2, colour profiles) compile in the worker, but the browser check's test
  files hold no such images, so decoding itself is not exercised; the no-wasm fallbacks are copied too.

## Consequences
- `apps/web/package.json` gains `pdfjs-dist`; `pnpm-workspace.yaml` gains `ignoredOptionalDependencies`;
  `vite.config.ts` gains the asset plugin, a `LAZY_ONLY` entry and `assetFileNames`.
- Third-party notices: pdf.js is Apache-2.0 (`assets/lazy/pdfjs-<version>/LICENSE`). The copied data keeps each
  licence file next to it under `assets/lazy/pdfjs-<version>/`: Adobe cMaps (BSD-3-Clause, `cmaps/LICENSE`),
  Foxit fonts (PDFium BSD-3-Clause, `LICENSE_FOXIT`), Liberation Sans (GPL-2.0 with the font exception,
  `LICENSE_LIBERATION`, unmodified), the JBIG2 decoder (PDFium BSD-3-Clause + Mozilla Apache-2.0), OpenJPEG
  (BSD-2-Clause), qcms (MIT) and the ICC profile (CC0). The QuickJS files and licences are not copied.

## References
- `apps/web/src/components/pdfPreview/pdfDocument.ts`, `apps/web/vite.config.ts`, `apps/web/src/lib/pdfPreview.ts`
  (+ test), `apps/server/src/routes/files.ts`, `apps/server/src/embedCsp.ts`, `apps/server/src/httpCache.ts`,
  ADR 0706, ADR 0752, ADR 0882, ADR 2481, ADR 2482, ADR 2483
