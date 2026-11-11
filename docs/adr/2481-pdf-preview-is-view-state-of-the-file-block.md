# 2481. The PDF preview is view state of the file block, drawn under its name line

- Status: Accepted
- Date: 2026-11-11

## Context
The preview (ADR 2480) has to appear in the page editor in editable pages, locked (read-only) pages and pen
mode, follow real-time edits of other members, and not get in the way of what the editor does with a file
block: a click on the name selects the block (toolbar: replace, caption, download, delete), a drag moves it,
keys edit the document. 0.20 added a document schema version so older tabs go read-only on pages with node
types they do not know (ADR 2425): a new block type or prop would start that machinery for every page that
holds a PDF.

## Decision
- **No schema change.** The block stays BlockNote's `file` block with the same config, parse rules and HTML
  export; nothing is written to the document. The editor's schema uses a copy of the default file spec whose
  `render` is wrapped (`components/pdfPreview/PdfFileBlock.tsx` `pdfFileSpec`, wired through
  `editorSchemaSpecs({ file })`, like the image spec of ADR 2386).
- **Which blocks**: a file uploaded to this server (`/files/<uuid>`, `lib/pdfFile.ts fileIdOf`) whose name
  ends in `.pdf`, or has no extension and the server's mime (`GET /api/files/:id/meta`) is
  `application/pdf`. External addresses get no preview (CORS, `connect-src 'self'`, not the workspace's bytes).
- **Where**: only the live editor's node view (`renderType === 'nodeView'`) gets a non-editable host right after
  the file name line; `<PdfPortals>` inside `BlockNoteView` renders the preview into it through a React portal
  (the pattern of `MermaidPortals`, ADR 2104). Exports, the clipboard's HTML and the public page render as
  before. Presentation slides are copies of the live DOM: `cloneForSlides` drops the host, and the host is
  shown only inside `.bn-editor`. Print and "Export as PDF" hide it (`@media print`), so paper keeps the name line.
- **Events**: the node view's `stopEvent` returns true for pointer, mouse, touch, key, input, composition,
  clipboard, focus and wheel events inside the host, and `ignoreMutation` for every mutation and selection
  inside it, so ProseMirror neither selects or drags the block nor reads the reader's text selection as a
  document selection. Outside the host `ignoreMutation` gives ProseMirror's own answer for a node view
  without content (prosemirror-view 1.42.4: everything but a selection change), so a style change on the
  block's own DOM does not rebuild it. Drops stay the editor's. A drag whose press began in a preview is
  cancelled by one capture `dragstart` listener for the tab, whatever the drag's target (a selected block is
  draggable, and with Alt, Ctrl or ⌘ held the target can be the block rather than the host), so PDF text is
  never dropped into the document and the block is not moved from inside its preview. The host carries
  `data-own-keys`: the editor's own key commands (`lib/shortcuts/editorKeys.ts`: undo, indent, fold with
  Mod+., …), which listen on the editor in the capture phase, skip keys typed in it, and Mod+Z / Mod+Y are
  cancelled inside the preview and its full-screen view: the browser's own undo works on the document's
  undo stack and would otherwise undo the body's last edit while the focus is in the page number box. The preview's root takes
  focus on a press (`tabIndex -1`), so keys typed after a click in it do not reach the editor. The image viewer needed a double-click for the
  same reason (ADR 2386); here the preview is a separate area under the block's own name line, so a single
  press works and the name line keeps selecting the block.
- **Real-time**: BlockNote rebuilds a node view on every change of its block's props (no `update`), and
  removes it with the block. The preview follows: a member who deletes or replaces the file block removes or
  replaces the preview in every tab. Documents are shared by address for 15 s after the last preview lets go (ADR 2480) and page and zoom are
  kept per block for the tab, so a rebuild for an unrelated prop (background colour) does not refetch or jump;
  the file's meta is kept for a minute and a file that is not a readable PDF for half a minute, so a rebuild
  asks the server nothing.
  Following another reader's page is not part of it.
- **Lazy**: the host is empty until it is within 300 px of the screen (`IntersectionObserver`); then the
  preview chunk (`PdfPreview-*.js`, 20 KB) loads and asks for the file's meta. pdf.js loads only when bytes
  are fetched (ADR 2482).
- **The area**: pages stack vertically in an area at most 70% of the screen tall (`70dvh`), scrolled inside;
  the scrollbar's room is kept from the start (`scrollbar-gutter: stable`). Pages are laid out from page 1's
  size until each is fetched, and only the page boxes near the view are in the DOM (placed at their tops).
  The pages in view and one each side are drawn, at most eight per pass; one more each side keeps its
  canvas, everything else is released (`width = height = 0`, removed, `page.cleanup()`). Page size, canvas
  size, the page count and offscreen previews have limits against hostile files (ADR 2483). A page that
  fails to draw is tried again on a later pass; if page 1 cannot be read the block shows an error. The text layer (pdf.js `TextLayer`) makes text
  selectable and copyable. Toolbar: hide, page number (type and Enter) / page count, zoom out, zoom %, zoom in
  (25-400% steps), fit width (the default), full screen, download. A zoom or a resize keeps the place that was
  at the top of the area.
- **Full screen**: a dialog on `<body>` like the image viewer: the rest of the body is `inert`, the page does
  not scroll, keys are taken in the capture phase (Esc closes, `+`/`-`/`0` zoom), browser Back closes, focus
  returns. It opens on the inline page and the inline preview shows its page when it closes.
- **Hide**: per viewer and file in `localStorage` (`inkling-pdf-collapsed`, newest 300 ids, every read and
  write in try/catch); a hidden preview fetches nothing. Never in the document.
- **Ink**: no preview in pen mode or on a page that has ink strokes (`lib/pdfFile.ts previewsAllowed`).
  Ink is stored in the body's coordinates (896 px wide, scaled with the column; `INK_CANVAS_WIDTH`), so
  anything that changes the body's height
  under a stroke moves the stroke off what it marked, and a PDF that scrolls in its own area cannot carry
  ink. On such pages every host stays empty and hidden: the file block is exactly as tall as in 0.20 and
  nothing of the preview is fetched. Turning the pen on removes the previews (and closes a full-screen
  view); turning it off on a page without strokes brings them back. The page's strokes are asked for once
  per page with a PDF (`GET /api/pages/:id/ink`, `api.ts usePageInkPresence`), again every 60 s and when
  the tab comes back to the front, because the server does not announce ink changes: a member's first
  stroke hides the preview in other open tabs within a minute. While a save of this tab's ink is under way
  the previews stay away. If the ink request fails the previews are shown (an unreadable ink list must not
  hide every PDF). Next step: a preview of fixed height on pages with ink, with the ink layer over it, and
  an ink change message on the collaboration socket instead of the poll.
- **Strings**: `i18n/{en,ko}/pdf-preview.ts`. Dark theme uses the app's tokens around paper-white pages.

## Alternatives considered
- **A new `pdf` block or a `showPreview` prop on `file`**: stored in documents, so the schema version, the
  server converters, Markdown and MCP all change, and older tabs go read-only (ADR 2425).
- **An overlay positioned over the block from outside the editor**: has to follow every layout change
  (typing above, images loading, columns) and still has to keep ProseMirror from taking its events.
- **A React block spec (`createReactBlockSpec`)**: re-implements BlockNote's file rendering instead of wrapping it.
- **Every page drawn at once**: a 300-page paper would hold 300 canvases (gigabytes at 2x).
- **One click opens a full-screen viewer, no inline area**: the request was to read it in the page, next to
  the notes.

## Trade-offs
- The preview lives in `CollabEditor`'s schema only: page embeds, row templates and the offline recovery
  preview keep BlockNote's plain file block; the public page is unchanged (it has no download link either,
  KNOWN-ISSUES PUB-3).
- No search inside the PDF, no annotations, no links to a page, no following another reader.
- A node view rebuilt while a preview is in full screen closes the dialog.
- On a page with ink strokes PDFs show only their name line, as in 0.20; another member's first stroke can
  take up to a minute to hide the preview in an open tab.

## Consequences
- `apps/web/src/components/pdfPreview/` (`PdfFileBlock.tsx`, `PdfPreview.tsx`, `pdfDocument.ts`,
  `pdfPreview.css`), `lib/pdfFile.ts`, `lib/pdfPreview.ts` (+ test), `lib/present.ts` (+ test), `index.css`,
  `CollabEditor.tsx` (`penMode` to `PdfPortals`), `pages/PageView.tsx`, `api.ts` (`usePageInkPresence`, the
  ink save's mutation key), `lib/shortcuts/editorKeys.ts` (`data-own-keys`), `blocks/PageEmbed.tsx`
  (`editorSchemaSpecs` file option).

## References
- ADR 1340, ADR 2104, ADR 2386, ADR 2425, ADR 2480, ADR 2482, ADR 2483
