# 0814. Full Content-Security-Policy for the SPA shell

- Status: Accepted
- Date: 2026-11-07
- Audit: C-M8 (server part), C-L5; supersedes the frame-src-only policy of 0501

## Decision
`embedCsp.ts` sends `SPA_CSP` on every `text/html` response that has no CSP of its own (the
`@fastify/static` index, the SPA fallback, the `/s/:token` share shell):

```
default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self';
frame-src 'self' <EMBED_FRAME_ORIGINS + EMBED_EXTRA_FRAME_SRC>; img-src 'self' data: blob: https:;
media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;
font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'
```

- `script-src 'self'` works because the shell has no inline script (theme-init.js is a file).
  No `'unsafe-eval'` and no `'wasm-unsafe-eval'`: Shiki highlighting worked without them in the
  check below.
- zod v4 probes `new Function` once when the first object schema is built. The throw is caught,
  but the browser still reports a violation. `packages/shared/src/zodConfig.ts` (imported first by
  the shared index) sets `z.config({ jitless: true })` in the browser only. The server keeps zod's
  JIT path.
- `style-src 'unsafe-inline'`: BlockNote, Mantine, React Flow and React set inline styles.
- Plugin frames and scripts, file downloads and public share JSON set their own stricter CSP
  first, so the hook leaves them alone.

## Verification
Built web (vite build into a scratch directory), production server, Playwright Chromium:
register → home → document (imported Markdown with a code block and an external image; typing,
a new code block) → YouTube embed pasted on an empty page (iframe `youtube-nocookie.com`) → ink
layer drawing → canvas page → graph → settings. With the zod probe disabled: 0
`securitypolicyviolation` events, 0 console errors, 0 page errors, 16 Shiki-coloured tokens, and
the external image loaded. Without it, the only violations were the zod `eval` probe (one per full
load). The service worker registered under the policy.

## Consequences
- Plain `http:` images and media in documents are blocked (https, data and blob only).
- A feature that needs another origin (fonts, scripts, connect) must extend `SPA_CSP`.
