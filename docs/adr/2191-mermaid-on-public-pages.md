# 2191. Mermaid diagrams on public pages are drawn in the reader's browser

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 2104 draws ```mermaid code blocks in the editor from a lazy chunk; public pages (`/s/…`) are server
HTML shown by the web app's `PublicView` after the client sanitizer (ADR 0852), so a diagram showed
as its code there. The server cannot draw Mermaid (it needs a browser layout engine), and Mermaid's
SVG must never be put into the page as markup (ADR 2105: it would bypass the sanitizer).

## Decision
- `PublicView` runs `renderMermaidIn` (`apps/web/src/lib/mermaidPublic.ts`) on the sanitized body, as
  it runs KaTeX: every `[data-content-type="codeBlock"]` whose `data-language` is `mermaid` / `mmd`
  is drawn with the editor's renderer (`lib/mermaid.ts`: strict configuration, locked directive keys,
  the cleaning pass, an `<img>` data: URL). The image goes after the code block element, which is
  hidden (BlockNote styles that element as a dark box with `display: flex`, so the image does not go
  inside it and hiding the `<pre>` alone would not do); a diagram that fails keeps its code. Theme follows the public page's light / dark switch.
- Nothing changes on the server: the block stays a code block in the HTML, so a reader without
  JavaScript, a crawler and the Markdown download see the source.
- Mermaid is fetched only when the page has such a block (the lazy chunk of ADR 2104).

## Safety
- Same renderer and limits as the editor; the result is an image (no script, no handler, no
  external reference after the cleaning pass).
- While Mermaid lays out a diagram, an image node in the source (`img:`) may be fetched by the
  reader's browser (ADR 2105). On a public page this is not a new reach: the client sanitizer already
  keeps external `https:` image URLs of image blocks (`safeUrl(…, 'media')`) and the shell's CSP allows
  `img-src https:`, so a member can already make a public reader's browser load an external image.

## Not done
- Presentation mode on a public page builds its slides from the HTML string, so a diagram is shown
  as code there (KNOWN-ISSUES).

## Files
- apps/web/src/lib/mermaidPublic.ts, apps/web/src/lib/mermaidPublic.test.ts, apps/web/src/pages/PublicView.tsx
- apps/web/src/lib/mermaid.ts (`MERMAID_LANGUAGES`, `isMermaidLanguage` moved here from MermaidBlock.tsx)
