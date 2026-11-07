# 0502. Link preview cards: bounded head scan, in-memory LRU, hotlinked thumbnails

- Status: Accepted
- Date: 2026-11-07

## Context
Links that are not embeddable should show a card (title, description, site, image, favicon). The server has to fetch an untrusted page and parse untrusted HTML, many users may paste the same links, and the image has to be shown somehow.

## Decision
- `GET /api/link-preview?url=` requires a session and is rate limited per session (30/min; key = hash of the session cookie, because the rate-limit hook runs before `requireUser`). Responses carry `Cache-Control: private, max-age=3600`.
- Fetch via `safeFetch` with http allowed (read-only metadata, many links are still http), ports 80/443, 6 s deadline, first 256 KiB only (`truncate`).
- Parse with a single forward scan: a hand-written start-tag/attribute tokenizer (bounded at 8 KiB per tag and 64 attributes), skipping comments/script/style, stopping at `</head>`/`<body>`. No regex runs over the document, so there is no ReDoS. Charset: HTTP header, then `<meta charset>`, then UTF-8 (`TextDecoder`, so EUC-KR and others work).
- Prefer `og:*`, then `twitter:*`, then `<title>`/`<meta name=description>`; icon from `<link rel=icon>` (then apple-touch-icon), falling back to `/favicon.ico`. Image/favicon URLs are resolved against the FINAL URL and only `https:` URLs are returned.
- Cache: in-memory LRU (`Map`), 1000 entries, 6 h TTL, 10 min negative TTL, in-flight de-duplication. No DB table.
- Thumbnails are hotlinked (no image proxy) with `referrerpolicy="no-referrer"` and `loading="lazy"`.
- Failures return 422 `PREVIEW_UNAVAILABLE` with a generic message (no "private address" vs "DNS failed" oracle). The client falls back to a host-only card.

## Alternatives considered
- Image proxy (`/api/image-proxy?url=`): hides the viewer's IP from third parties and avoids mixed content, but re-introduces SSRF surface, costs bandwidth, and needs an image-type sniffer and resize limits.
- Caching images server-side: storage growth plus copyright and retention questions.
- DB cache table: survives restarts and is shared across instances, but needs a migration and cleanup job for little gain on a single-instance self-hosted app.
- A full HTML parser (parse5/htmlparser2): new dependency (not allowed in this change) and more work than metadata extraction needs.

## Trade-offs
- Hotlinking exposes the viewer's IP and User-Agent (not the page URL, thanks to `no-referrer`) to the image host, and images can disappear later.
- The cache is lost on restart and is per process.
- Truncated documents whose `<head>` is larger than 256 KiB lose late meta tags.

## How others solve it
Slack and Discord unfurl server-side and proxy images (they run large proxy fleets). Mastodon fetches OpenGraph server-side and stores a copy of the image. Outline and many self-hosted tools hotlink with `no-referrer`. For a self-hosted single container, hotlinking is the conventional low-risk choice.

## Consequences
- Parser and charset tests: `apps/server/src/linkPreview.test.ts` (includes adversarial inputs that must finish in < 500 ms).

## References
- apps/server/src/linkPreview.ts:17-19 (cache limits), :41 (parseTag), :128 (extractHeadMeta), :296 (getLinkPreview)
- apps/server/src/routes/linkPreview.ts
- apps/web/src/components/blocks/LinkEmbed.tsx:112, :127 (no-referrer images)
