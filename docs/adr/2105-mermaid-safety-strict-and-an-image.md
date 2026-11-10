# 2105. Mermaid safety: strict configuration, a cleaning pass, shown as an image

- Status: Accepted
- Date: 2026-11-10

## Context
A diagram's source is member text and therefore untrusted (ADR 0976). Mermaid can render HTML labels,
bind `click` callbacks and links, read `%%{init: …}%%` directives that change its configuration, and it
puts `<style>` into its SVG. The public-share sanitizer (`lib/sanitizeHtml.ts`, ADR 0852) keeps only
`svg`/`path` and drops `<style>`, so it would empty a diagram.

## Decision
- **Configuration** (`lib/mermaid.ts`): `securityLevel: 'strict'` (labels through Mermaid's DOMPurify,
  click and links off), `htmlLabels: false`, `startOnLoad: false`, `suppressErrorRendering: true`,
  Mermaid's size limits (50,000 characters, 500 edges). `secure` adds `htmlLabels`, `dompurifyConfig`,
  `themeCSS`, `fontFamily` and the math/id switches to Mermaid's own list, so a directive in the source
  cannot change them (themes and layout options stay open).
- **Cleaning pass** (`lib/mermaidSvg.ts`, pure, tested with jsdom): removes script, iframe, object,
  embed, link, meta, base, media, SMIL animation and form elements; every `on*` attribute; `href` /
  `xlink:href` / `src` other than `#ref` or a raster `data:image`; `@import` and `url(…)` other than
  `url(#…)` / raster data in `<style>` and `style=""`. Sizes the root from its viewBox.
- **Shown as `<img src="data:image/svg+xml,…">`**: an SVG image runs no script, fires no handler and
  loads nothing from outside, whatever got through. The page's CSP already allows `img-src data:`;
  Mermaid's chunks contain no `eval`/`new Function` (only lodash's `Function('return this')` fallback,
  never reached in a browser), so `script-src 'self'` holds.
- **Fonts**: an image cannot use the page's web fonts; Mermaid measures and the image draws with the
  same system font stack, so labels fit their boxes.

## Alternatives considered
- **Inline SVG after DOMPurify.** DOMPurify is a dependency of Mermaid only (a phantom import for us);
  inline SVG also shares CSS and ids with the page.
- **securityLevel `sandbox`.** An iframe per diagram (ADR 2104).

## Trade-offs
- While Mermaid measures, its temporary SVG is in the page for a moment (Mermaid's own design): an
  image node (`img:` in a flowchart) may be fetched then, as an image block's URL would be.
- Diagram text is not selectable and not found by find-in-page.
- Checked in headless Chrome 2026-11-10 (Mermaid 12.3.0, flowchart/sequence/class, light and dark): a label
  `<img src=x onerror=…>` is drawn as text, `<script>` labels are empty, `click … "javascript:…"` leaves a
  link-less `<a>`, an init directive asking for `securityLevel: loose`, `htmlLabels: true` and `themeCSS`
  changes nothing but the theme, nothing ran with or without the CSP. Under the CSP Chrome still logs
  "inline event handler" violations for such labels while DOMPurify parses them in its inert document
  (reports only; nothing executes).
