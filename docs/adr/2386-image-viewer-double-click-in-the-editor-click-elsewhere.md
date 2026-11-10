# 2386. Image viewer: double-click or the corner button in the editor, one click where nothing can be edited

- Status: Accepted
- Date: 2026-11-11

## Context
A picture in a page is drawn at most as wide as the body column. A large screenshot (3910 × 2060) shrinks to a
third of its size and there was no way to see it larger short of copying its address. The viewer has to work
in the page editor (BlockNote 0.51.4, pinned) and on the public page (`/s/:token`, server HTML), and it must
not change what a click on an image block already does in the editor: select the block (for the toolbar,
caption, replace, delete, alignment), show the resize handles, start a block drag.

## Decision
- **Opening**
  - Editable page: a **double-click** on the image, or the **magnifier button** in the image's top right corner.
    The button is shown on hover, while the block is selected, on keyboard focus and always on screens
    without hover (touch). One click keeps selecting the block.
  - Read-only body (edit lock): **one click** opens it; the button is there too. In pen mode the ink layer
    lies over the body and takes the pointer, so the image is not reached (not checked in the browser).
  - Public page: **one click** on an image block opens it; an image inside a link follows the link.
- **The button** is part of the image block's node view from the start: the editor's image spec is rebuilt
  with BlockNote's own `createImageBlockConfig`, `imageParse`, `imageRender` and `imageToExternalHTML`, and the
  render only appends one `<button contenteditable=false>` inside `.bn-visual-media-wrapper`
  (`components/imageViewer/zoomableImage.ts`). Nothing is inserted into the editor's DOM afterwards, the
  stored block, its HTML export and the server schema are unchanged. The button stops `pointerdown` /
  `mousedown` / `touchstart` so ProseMirror does not take it as a click or a drag on the block. The page-embed
  viewer and `LocalDocEditor` (row templates, the offline recovery preview) keep BlockNote's plain image.
  Copies of blocks (presentation slides, the internal clipboard HTML) carry the button's markup; it is
  hidden by default and drawn only inside a live `.bn-editor`.
- **Double-click and the caption**: BlockNote 0.51.4 edits a caption through the toolbar's "Caption" button,
  not on the image, and the caption (`figcaption`) is outside the `<img>`; the handlers look only at the
  `<img>` of an image block, so double-clicking a caption, a resize handle or empty space does nothing new.
- **Viewer** (`components/imageViewer/ImageViewer.tsx`, a lazy chunk; `openImageViewer.ts` is the small part
  the editor and the public page import):
  - Its own React root on `<body>`; the rest of the body is `inert` and the root element stops scrolling
    while it is open. Browser Back (`popstate`) closes it, so it never stays over another screen. `role="dialog"`, `aria-modal`, labelled buttons, Tab trapped, focus back to what had it
    on close (Esc, a click on the backdrop, the close button).
  - Every key is taken in the capture phase on `window` and stopped there, so neither the editor nor the app's
    shortcut dispatcher nor other window listeners see it; keys with ⌘/Ctrl/Alt keep their browser meaning.
  - Wheel and trackpad pinch (wheel + ctrlKey, a non-passive listener so the page itself does not zoom) about
    the cursor, `+`/`-`, `0` fits, double-click fit ↔ 100%, drag pans, two-finger pinch and one-finger drag on
    touch (Pointer Events, `touch-action: none`). Fit never enlarges a small image; the largest zoom is 800%.
  - The image moves by `transform` only; input updates refs and one `requestAnimationFrame` writes the
    transform and the % label, so React does not re-render while zooming.
  - The images of the same body in document order, ←/→ and side buttons, "2 / 5". The top bar shows the caption,
    else the file name (the block's `name`, else the last part of the address), the zoom and "Open original"
    (new tab). There is no download button.
  - The address is the `src` the page already drew, so signed, public (`/api/public/…/f/…`) and external
    images work without new permission code.
  - A backdrop press closes on its `click`, not on `pointerup`: on touch the click would otherwise land on the
    page under the finger after the viewer is gone and open the image again.
  - `prefers-reduced-motion`: no fade. Its stylesheet ships with the lazy chunk.
- **Shortcut help**: a new scope "Image viewer" lists the keys (`via: 'viewer'`, not remappable, not in the
  palette). The viewer is modal, so `liveTogether` never pairs it with another scope.
- **Strings**: `i18n/{en,ko}/image-viewer.ts`, one import and one spread line in each dictionary.

## Alternatives considered
- **One click opens it in the editor too**: a click on an image is how the block is selected for its toolbar
  (caption, replace, alignment, delete) and how a drag starts; taking the click would need a second way to
  select an image and changes a habit every editor user has.
- **A floating button outside the editor, positioned over the hovered image**: needs to follow layout changes
  (typing above, images loading, resizing) and cannot be "always visible" on touch for every image.
- **Inserting the button into the editor DOM after render (effect or MutationObserver)**: ProseMirror
  observes its own DOM and may redraw the node, dropping or duplicating the button.
- **A lightbox library (PhotoSwipe, yet-another-react-lightbox, medium-zoom)**: a new dependency for about
  9 KB of our own code (ADR 0882); the libraries bring their own markup and keyboard handling that would still
  need the editor's key isolation.
- **Opening a new tab with the image**: no gallery, no return to the same place, and a browser tab cannot
  pinch-zoom inside the page on desktop.

## Consequences
- New chunk `ImageViewer-*.js` (about 9.7 KB raw, 3.5 KB gzip, plus 0.4 KB of CSS), loaded on the first open;
  the entry `index-*.js` is unchanged in size. The strings and shortcut rows add about 2.2 KB raw (0.5 KB gzip)
  to the modulepreloaded i18n chunk, the button's rules and the viewer's Tailwind classes go into the entry
  stylesheet. The magnifier button and the open helper live in the editor's and the public page's chunks.
- Out of scope: presentation mode, database cover and file fields, the canvas, images in comments, the row
  template editor and the offline recovery preview. Images inside an embedded page's own viewer have no button,
  but a double-click (or, on a read-only page, a click) there opens the viewer with the host page's images,
  since they share the container.
- There is no keyboard way to open the viewer on an image in an editable page: the button is not in the Tab
  order (it lives inside the editable body).
- If BlockNote's image render changes in an upgrade, `zoomableImage.ts` follows it automatically (it calls
  `imageRender`); only the wrapper class `.bn-visual-media-wrapper` is assumed.

## References
- `apps/web/src/components/imageViewer/`, `apps/web/src/lib/imageZoom.ts` (+ test),
  `apps/web/src/components/CollabEditor.tsx`, `apps/web/src/components/blocks/PageEmbed.tsx`
  (`editorSchemaSpecs` image option), `apps/web/src/pages/PublicView.tsx`, `apps/web/src/lib/shortcuts/registry.ts`,
  ADR 0882, ADR 1281, ADR 1400
