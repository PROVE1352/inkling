# 0852. Client-side allowlist sanitizer for public share HTML; app shell ready for `script-src 'self'`

- Status: Accepted
- Date: 2026-11-07

## Context
`PublicView` renders the server's `blocksToFullHTML` output with `dangerouslySetInnerHTML`
(audit C-M8). The server neutralises internal links and rewrites asset URLs, but that was the
only layer. Media block `props.url` values reach `src` as-is, and the SPA CSP (`embedCsp.ts`) has
no `script-src` or `frame-ancestors`. Adding DOMPurify would be a new dependency, which this phase
does not allow.

## Decision
- `apps/web/src/lib/sanitizeHtml.ts` is a small allowlist sanitizer built on the browser's inert
  `DOMParser` (scripts do not run and images do not load in a parsed document).
  - Elements: HTML formatting and structure, tables, `img` / `video` / `audio` / `source`, inert
    `input type=checkbox` (forced `disabled`), `button` (forced `type=button`), and an SVG subset
    of `svg` + `path` for BlockNote's icons. These are removed with their content: script, style,
    template, iframe, object, embed, math, forms, noscript and similar elements, and any other
    SVG element (`foreignObject`, `use`, `animate`, SVG `a`). Other unknown elements are unwrapped,
    so their text survives. Comments are removed.
  - Attributes: per-element allowlist plus `class`, `title`, `data-*`, `aria-*`. Every `on*`
    attribute, `srcset`, `formaction`, `xlink:href` and anything unlisted is dropped.
  - `href` / `src` / `data-url`: parsed with `new URL(value, origin)`. Allowed are `http:`/`https:`
    (written as absolute URLs), `mailto:` for links only, and same-origin paths under
    `/api/public/`, `/files/` and `/s/` (public assets and folder-share links). `javascript:`,
    `data:`, `blob:`, `vbscript:`, `//host` and `/\host` are removed.
  - `style`: kept per declaration for layout properties BlockNote emits (`width`, `height`,
    `position`, `left`/`right`, `display`, `text-align`, `--default-cell-min-width`, …). A value
    is kept only if it is plain (`[-\w\s.,%#()]`) and has no `url(`, `expression(`, `image-set`,
    `javascript:`, backslash or comment.
  - `target` other than `_blank` is dropped, and `_blank` links always get
    `rel="noopener noreferrer nofollow"`.
- `PublicView` sanitises `data.html` (memoised) and passes cover and icon URLs through the same
  media URL allowlist (`safeUrl(url, 'media')`).
- The dark-mode bootstrap moved from an inline `<script>` in `index.html` to
  `public/theme-init.js`, also precached by the service worker. The app shell now has no
  inline script, so the server can send `script-src 'self'` without hashes.

Tests: `apps/web/src/lib/sanitizeHtml.test.ts`, run under jsdom from `@blocknote/server-util`
with no new dependency. BlockNote markup must round-trip unchanged. The tests also cover script,
style, iframe and form removal, `on*` attributes, dangerous schemes, CSS `url()`/`expression()`,
SVG `foreignObject`/`use`/`animate`, unwrapping, inert controls, comments, and idempotence on
mXSS-style inputs.

## Proposed server header (fix-server owns `embedCsp.ts`)
For the SPA shell (index.html responses):
```
Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self';
  frame-ancestors 'self'; frame-src <existing embed allowlist>; img-src 'self' https: data: blob:;
  media-src 'self' https: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:;
  connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'
```
`style-src 'unsafe-inline'` is needed because BlockNote, Mantine and React set inline styles.
`img-src https:` covers external images in documents and link-preview cards. If adding this
in one step is too risky, the minimum is `script-src 'self'; object-src 'none'; base-uri 'self';
frame-ancestors 'self'` added to the existing `frame-src`-only policy. Plugin frames
(`plugins/frame.ts`) are separate responses with their own policy and are not affected.

## Alternatives considered
- DOMPurify: the standard choice, but it is a new dependency (not allowed in this phase). Worth
  adopting later in place of this file.
- Server-only sanitisation: a single layer, so a renderer bug or a new block type would reach the
  DOM directly.

## Trade-offs
Markup outside the allowlist disappears from public pages. A future block type that needs a new
element or style property must be added here.
