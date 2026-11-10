# 2261. Article extraction uses server-util's DOM and a small reader-mode heuristic, not Readability

- Status: Accepted
- Date: 2026-11-10

## Context
`mode: 'article'` keeps a page's main text. That needs a fetch, an HTML parser, a way to find the
article among menus and comments, sanitizing, and a conversion to BlockNote blocks. The server
already has `safeFetch` (ADR 0500), `decodeHtml` (link previews), and JSDOM through
`@blocknote/server-util` (`md/editor.ts`), whose `tryParseHTMLToBlocks` turns HTML into blocks with
the editor's own schema. Dependency policy: ADR 0882.

## Decision
- Fetch (`clip/fetchArticle.ts`): `safeFetch` with http allowed, ports 80/443, ≤ 3 redirects each
  re-validated, 10 s deadline, 2 MiB read (`truncate: true`, a longer page is cut, not refused),
  `allowedContentTypes` text/html and application/xhtml+xml (a PDF or image is never read). Any
  failure is the same `fallback: 'fetch_failed'` (no internal-network oracle), non-HTML is
  `not_html`. Test mode `CLIP_TEST_ALLOW_LOOPBACK=1` (ignored in production) allows only loopback,
  as `WEBHOOK_TEST_ALLOW_LOOPBACK` does.
- Encoding: `decodeHtml` (HTTP charset, then `<meta>`), now mapping cp949/ms949/x-windows-949/uhc to
  WHATWG `euc-kr`.
- Before parsing (`prepareHtml`, one linear pass): comments and the content of script/style/
  noscript/template dropped, start tags counted (cut after 20,000), nesting estimated (over 400 →
  no article). The tag pattern stops at the next `<` or `>` so unclosed markup stays linear.
- Parse with the JSDOM window of the server editor (`DOMParser`: no scripts, no resource loads).
  Junk removal in one element walk (drop tags, nav/banner/footer roles, hidden elements, the
  "unlikely candidate" class/id rule of Firefox's reader mode). Root: `[itemprop=articleBody]`, then
  `article`, then `main`/`[role=main]` with enough text and link density ≤ 0.5; else paragraph
  scoring (length, commas, class/id weight, a `<div>` without block children counts as a paragraph
  for blogs written as `<div>text<br>`), score × (1 − link density); else the body. "Enough text" is
  140 characters with CJK counted double.
- Output is serialized from an allow-list by a read-only walk (`serializeElement`): text,
  p/h1–h6/lists/blockquote/pre/code/tables/figure/emphasis/br/hr, links with absolute http(s)/mailto
  `href` (relative ones resolved against `<base href>` then the page URL), https images (lazy
  `data-src`/`srcset` read, 1–2 px pixels dropped, at most 100), `colspan`/`rowspan`; every other
  attribute is never written, text and attributes are escaped. The text is cut at 100,000
  characters (`truncated`, and a note at the end of the page).
- `tryParseHTMLToBlocks` makes the blocks; `clip/blocks.ts` checks them again (known types only,
  heading level ≤ 3, http(s)/mailto links, https images, block ids left to the writer, ≤ 3,000 blocks).
- Images stay hotlinked to the original https URL (v1). The app's CSP already allows `img-src https:`
  and documents already show external images.

## Alternatives considered
- `@mozilla/readability`: better on unusual layouts (sibling merging, retries with looser rules),
  ~90 KB, no dependencies, needs the same DOM. Not added: the heuristic passes the news, blog,
  EUC-KR, empty and huge fixtures; Readability would still need the allow-list rebuild and the
  pathological-markup guards; a new runtime dependency needs a reason (ADR 0882). It can replace
  `pickRoot` later without changing the route.
- Mutating the DOM to sanitize (unwrap, remove): JSDOM mutations cost 0.15–0.4 ms each; a 1.6 MB
  page took 3.4 s in that phase alone. The string serializer takes the same page in ~0.35 s total
  on an idle machine.
- Downloading images as attachments: upload quotas, a second SSRF surface per image, storage of
  third-party copyrighted files; not in v1.
- Turning the HTML into Markdown and calling `markdownToBlocks`: brings back the notation problem
  of ADR 2260.

## Trade-offs
- Extraction is synchronous CPU in the request: ~0.3–0.9 s for a 1.6 MB page, up to ~1 s at the
  20k-tag cut on an idle machine (2–5× more under load). Bounded by the limits of ADR 2262; a worker
  thread was not added (build and dev-mode cost).
- Hotlinked images reveal the reader's IP to the image host and can disappear.
- Pages that render their text with JavaScript have no article → link fallback.

## Consequences
- Fixture and pathological-markup tests: `clip/extract.test.ts`; end-to-end with a local origin:
  `clip.db.test.ts`.
