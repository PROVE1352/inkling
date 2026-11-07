# 0501. Link embeds: client-side provider table, constructed iframe URLs, frame-src-only CSP

- Status: Accepted
- Date: 2026-11-07

## Context
Pasting a YouTube / Figma / Google Docs / … link should show the live embed. Embeds are iframes of third-party origins, so the main risks are (1) a crafted link turning into an iframe of an arbitrary origin, (2) a collaborator writing a malicious `src` into the shared Yjs document, and (3) the app having no CSP at all on its HTML shell.

## Decision
- A provider table in `packages/shared/src/embeds.ts` (YouTube, Vimeo, Loom, Figma, Miro, Google Docs/Sheets/Slides, GitHub Gist, CodePen, Excalidraw share links, Spotify). For each: exact host set, anchored bounded ID patterns, and a builder that CONSTRUCTS the official embed URL from the extracted parts. The original query string is never passed through.
- The block (`linkEmbed`) stores only `{ url, display }`. The iframe `src` is recomputed with `toEmbed(url)` on every render, so block props cannot inject a frame source.
- Per-provider least-privilege `sandbox` + `allow`: players get `allow-scripts allow-same-origin allow-popups allow-presentation`; apps also `allow-popups-to-escape-sandbox`; Gist uses the static `.pibb` page with no scripts at all (Gist's official embed is a `<script>`, which we never load). `allow-same-origin` on a cross-origin frame only lets the provider use its own storage; it never grants access to the Inkling origin. YouTube uses `youtube-nocookie.com`.
- `referrerpolicy="strict-origin-when-cross-origin"` on embeds (YouTube refuses embeds without a referrer origin); `loading="lazy"`.
- The server adds `Content-Security-Policy: frame-src 'self' <providers>` to every `text/html` response that does not already carry a CSP. A policy with only `frame-src` restricts nothing else, so the inline theme script, PWA and editor styles are unaffected; stricter existing CSPs (public JSON, file downloads) are left untouched. Extra origins: `EMBED_EXTRA_FRAME_SRC`.
- Paste UX: a bare URL pasted on an empty line becomes a `linkEmbed` block (embed when supported, otherwise a preview card). The block toolbar switches Embed / Card / plain Link, which is the "embed or link" choice. URLs pasted inside text or over a selection keep the default behaviour. A slash-menu item inserts an empty embed block.

## Alternatives considered
- oEmbed via the server: one fetch per paste, more SSRF surface, and providers' oEmbed HTML usually contains scripts we would have to sanitise.
- Iframely/Embedly: third-party service and API key, which is a bad fit for self-hosted.
- A full app CSP (`default-src 'self'`, …): desirable, but needs an audit of inline scripts/styles and PWA; out of scope, so frame-src is the safe first step.
- Paste-time popup ("Embed or link?"): an extra modal step for every paste; a persistent toggle is reversible and works for collaborators too.

## Trade-offs
- New providers need a code change (table + `EMBED_FRAME_ORIGINS`).
- Other features that frame a new origin must add it to the list or to `EMBED_EXTRA_FRAME_SRC`, or the browser will block it (plugin frames are same-origin and covered by `'self'`).
- The server's BlockNote schema does not know `linkEmbed`; public share HTML and Markdown export drop it, the same v1 limitation as `pageEmbed` and `callout`. `toExternalHTML` falls back to a plain link for client-side copy.

## How others solve it
Notion and Outline keep a provider allowlist with regexes that map share URLs to embed URLs on the client (Outline: `shared/editor/embeds/*.ts`), and sandbox the iframes. Discourse "onebox" uses an allowlist of iframe origins plus CSP `frame-src`.

## Consequences
- Conversion table is unit-tested (32 cases including spoof attempts): `apps/server/src/embeds.test.ts`.

## References
- packages/shared/src/embeds.ts:74 (sandbox profiles), :286 (EMBED_FRAME_ORIGINS), :321 (toEmbed)
- apps/server/src/embedCsp.ts:25 (policy), apps/server/src/index.ts:135 (registration)
- apps/web/src/components/blocks/LinkEmbed.tsx:151 (iframe attributes), :196 (block spec), :250 (paste handler)
