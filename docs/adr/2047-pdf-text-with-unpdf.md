# 2047. PDF text for read_file with unpdf 1.9.1

- Status: Accepted
- Date: 2026-11-10

## Context
read_file answered PDFs with metadata only: "no PDF parser on the server". Reading the text layer
needs a dependency (ADR 0882). Criteria: actively maintained; MIT/Apache license; pure JavaScript (no
native build, no extra Alpine packages in the Docker image); runs on Node 22 (CI and the image); small
in the server runtime; a version published more than a day ago (pnpm's minimum release age), pinned
exactly.

## Decision
**unpdf 1.9.1** (MIT; bundles a serverless build of Mozilla pdf.js, Apache-2.0; published 2026-10-19;
no dependencies; `@napi-rs/canvas` only as an optional peer that is not installed; engines `node >=22`;
2.2 MB unpacked). Text only: `getDocumentProxy` → `getPage(i).getTextContent()`.

| Candidate | License | Native / extra deps | Node 22 | Unpacked | Verdict |
|---|---|---|---|---|---|
| unpdf 1.9.1 | MIT (+ pdf.js Apache-2.0 inside) | none; canvas only as optional peer | yes (`>=22`) | 2.2 MB | chosen |
| unpdf 2.x (2.1.0) | MIT | none | **no** (`>=24`) | 3.2 MB | needs Node 24 |
| pdfjs-dist 6.5.438 | Apache-2.0 | `@napi-rs/canvas` as an **optional dependency** (pnpm installs it: prebuilt native binaries) | yes | 37.6 MB | too large, native optional |
| pdf-parse 2.4.5 | Apache-2.0 | depends on pdfjs-dist 5 **and `@napi-rs/canvas`** | yes | 21.3 MB + deps | native dependency |

- Options passed to pdf.js: `useSystemFonts: false`, `disableFontFace: true`, `enableXfa: false`,
  `isOffscreenCanvasSupported: false`, `verbosity: 0`; no `standardFontDataUrl`/`cMapUrl` (nothing is
  fetched: the data is passed in, no URLs exist). This pdf.js build has no `eval` path (PostScript
  functions are interpreted) and never runs a document's JavaScript (that is the viewer's scripting
  feature, not in the parser).
- The upgrade path is unpdf 2.x once the image moves to Node 24.

## Consequences
- `apps/server/package.json` + `pnpm-lock.yaml`; `pnpm install --frozen-lockfile` passes without
  release-age exceptions. Image size grows by the package (see PERFORMANCE/OPERATIONS notes of 0.16).

## References
- apps/server/src/pdfText.ts, apps/server/src/pdfText.test.ts; https://github.com/unjs/unpdf
