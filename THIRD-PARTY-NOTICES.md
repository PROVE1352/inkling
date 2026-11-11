# Third-party notices

This file lists the third-party components that the app ships as separate files in its build. It is not a list of
every npm dependency.

Inkling itself is under the MIT licence ([LICENSE](LICENSE)). The components below are in the web build
(`apps/web/dist/`), which the Docker image carries as `/app/web-dist/`. Paths in the tables are relative to that
folder. Each licence text travels with the files it covers.

## pdf.js (`pdfjs-dist` 6.5.438)

Used by the PDF preview in the page editor ([ADR 2480](docs/adr/2480-pdf-preview-with-pdfjs-from-the-apps-own-origin.md)).
The library and its worker are built into two files that load only when a preview loads a PDF. Its data files are
copied unchanged to `assets/lazy/pdfjs-6.5.438/`, each with its licence file next to it.

| Component | Files in the build | Licence | Copyright, as the licence files name it | Licence text in the build |
|---|---|---|---|---|
| pdf.js | `assets/lazy/pdfDocument-*.js`, `assets/lazy/pdf.worker.min-*.mjs` | Apache-2.0 | Mozilla Foundation (the licence header of `build/pdf.mjs` and `build/pdf.worker.min.mjs`) | `assets/lazy/pdfjs-6.5.438/LICENSE` |
| Adobe CMaps (CJK text) | `assets/lazy/pdfjs-6.5.438/cmaps/*.bcmap` (168 files) | BSD-3-Clause | Adobe Systems Incorporated | `assets/lazy/pdfjs-6.5.438/cmaps/LICENSE` |
| Foxit standard fonts | `assets/lazy/pdfjs-6.5.438/standard_fonts/Foxit*.pfb` (10 files) | BSD-3-Clause | The PDFium Authors | `assets/lazy/pdfjs-6.5.438/standard_fonts/LICENSE_FOXIT` |
| Liberation Sans | `assets/lazy/pdfjs-6.5.438/standard_fonts/LiberationSans-*.ttf` (4 files) | GPL-2.0 with the font exception (Red Hat's Liberation licence agreement) | Red Hat, Inc. | `assets/lazy/pdfjs-6.5.438/standard_fonts/LICENSE_LIBERATION` |
| JBIG2 decoder | `assets/lazy/pdfjs-6.5.438/wasm/jbig2.wasm`, `jbig2_nowasm_fallback.js` | BSD-3-Clause and Apache-2.0 (PDFium); Apache-2.0 (pdf.js's build) | The PDFium Authors; Mozilla Foundation | `assets/lazy/pdfjs-6.5.438/wasm/LICENSE_JBIG2`, `LICENSE_PDFJS_JBIG2` |
| OpenJPEG (JPEG 2000) | `assets/lazy/pdfjs-6.5.438/wasm/openjpeg.wasm`, `openjpeg_nowasm_fallback.js` | BSD-2-Clause (OpenJPEG and pdf.js's build) | Universite catholique de Louvain (UCL) and the other holders listed in the file; Mozilla Foundation | `assets/lazy/pdfjs-6.5.438/wasm/LICENSE_OPENJPEG`, `LICENSE_PDFJS_OPENJPEG` |
| qcms (colour profiles) | `assets/lazy/pdfjs-6.5.438/wasm/qcms_bg.wasm` | MIT (qcms and pdf.js's build) | Mozilla Corporation, Marti Maria (`LICENSE_QCMS`); `LICENSE_PDFJS_QCMS` names no holder | `assets/lazy/pdfjs-6.5.438/wasm/LICENSE_QCMS`, `LICENSE_PDFJS_QCMS` |
| ICC profile `CGATS001Compat-v2-micro.icc` | `assets/lazy/pdfjs-6.5.438/iccs/CGATS001Compat-v2-micro.icc` | CC0 1.0 Universal | None named (a public domain dedication) | `assets/lazy/pdfjs-6.5.438/iccs/LICENSE` |

Liberation Sans is the one GPL text in the build. The fonts are shipped unmodified as separate files that pdf.js
loads to draw a PDF's text; they are not linked into the app's code.

Not shipped: pdf.js's scripting sandbox (QuickJS, `quickjs-eval.*` with `LICENSE_QUICKJS` and
`LICENSE_PDFJS_QUICKJS`) is left out of the build, because the preview runs nothing from a PDF. pdf.js's optional
Node canvas (`@napi-rs/canvas`) is not installed. pdf.js has no NOTICE file.
