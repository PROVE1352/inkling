# 0503. Server-injected Open Graph meta for public share links

- Status: Accepted
- Date: 2026-11-07

## Context
`/s/:token` is an SPA route. Unfurl bots (Slack, Discord, iMessage, X, KakaoTalk) do not run JavaScript, so a shared Inkling link previewed as just "Inkling". Private pages must never leak through previews.

## Decision
- In production (`WEB_DIST` set) the server registers `GET /s/:token` and `GET /s/:token/p/:ref` on the root app (registered routes win over the SPA fallback). It serves the same `index.html` with `<title>` replaced and `og:type=article`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` (only when the cover can be given as an absolute URL), `twitter:card` and `twitter:title/description/image` inserted before `</head>`. Every value is HTML-escaped. The shell is read once and re-read when its mtime changes.
- Metadata comes only from `findSharedPageByToken` / `loadFolderShare` (public.ts), which already require a live page with `scope='shared'` and exclude private subtrees. Anything else gets the untouched shell and the SPA shows its normal 404.
- Description: the first ~200 characters of `page_texts.text` (the existing plain-text search index), with whitespace collapsed. Folders: "Shared folder · N pages". Collections: title only.
- Unknown tokens are not counted as brute-force failures here (the SPA's API call already counts them; bots must not get an IP banned). The route is rate limited (120/min/IP, overriding the global allowList that exempts non-API GETs).
- `Cache-Control: no-store`, so stopping a share takes effect immediately.

## Alternatives considered
- Pre-rendering / SSR of the whole page: big change for the SPA, and the public page is already fetched as JSON.
- Serving meta only to bot User-Agents: fragile UA sniffing, and it creates divergent responses.
- Putting the full body into `og:description`: leaks more than needed and is cut by unfurlers anyway.

## Trade-offs
- In dev (Vite) there is no injection; it works only when the server serves the built SPA.
- `og:url`/`og:image` need `PUBLIC_URL`/`APP_URL`, falling back to the request Host (only affects that no-store response).
- One indexed query per share-link hit, plus a subtree query for folder links.

## How others solve it
Outline, HedgeDoc and Ghost inject meta server-side into the app shell for share routes; Notion server-renders public pages. The shell-injection pattern is the standard approach for SPAs that want unfurls without SSR.

## Consequences
- Verified in smoke: OG tags for shared docs, folders and folder children; no meta for a private page even when it has a token; plain shell for unknown tokens.

## References
- apps/server/src/routes/shareMeta.ts:33 (rate limit), :85 (injectMeta), :103 (description), :125 (routes)
- apps/server/src/routes/public.ts (findSharedPageByToken, loadFolderShare — now exported)
- apps/server/src/index.ts:241 (registration)
