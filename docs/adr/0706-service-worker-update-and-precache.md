# 0706. Service worker: prompt-to-update, trimmed precache, full server-route denylist

- Status: Accepted
- Date: 2026-11-07

## Context
- `registerType: 'autoUpdate'` swapped the SW under a running tab (skipWaiting + clientsClaim). The
  old page kept running old code; with route splitting (0704) its lazy chunks were then gone from the
  precache and from the server, whose SPA fallback answers unknown GETs with `index.html` — the
  import fails with "Expected a JavaScript module… MIME text/html".
- The precache held 63 files / 7.2 MB including ~50 Shiki grammars and exceljs, downloaded on the
  first visit by every client.
- `navigateFallbackDenylist` missed `/s/` (server-rendered share page with Open Graph/robots meta)
  and used prefix regexes like `/^\/api/` that also match SPA paths such as `/apiary`.

## Decision
- `registerType: 'prompt'`, registration in `lib/pwa.ts` (hand-rolled; `virtual:pwa-register` needs
  `workbox-window`, not a dependency). A waiting worker shows a persistent toast "A new version is
  ready / Reload"; the button posts `SKIP_WAITING` and the page reloads on
  `controllerchange`. If another tab accepted the update, this tab offers a reload instead of
  reloading under the user. `registration.update()` runs hourly while visible (SPA tabs never
  navigate). Registration happens after `load`.
- Lazy chunk failures reload once per minute (`reloadOnceForStaleChunk`) for clients without a SW.
- Shiki grammars/themes and exceljs are emitted under `assets/lazy/` (`chunkFileNames`) and excluded
  from the precache; a `CacheFirst` runtime route (80 entries, 30 days) caches them on first use.
  Nothing else has a runtime route: API responses are never cached by the SW.
- Denylist, from `apps/server/src/index.ts` (`isReservedPath` + root routes): `/api`, `/files`,
  `/collab`, `/mcp`, `/.well-known/`, `/oauth/token`, `/oauth/register`, `/ical/`, `/s/`, plus the
  legacy `/maps`; each anchored to a path segment.

Measured: precache 63 entries / 7 245 KiB → 59 entries / 3 149 KiB. Update flow verified in headless
Chromium: v1 controls the page → server switched to a build with a changed sw.js →
`registration.update()` → worker waiting + toast shown → click → reload → no waiting worker, editor
loads.

## Alternatives considered
- Keep `autoUpdate` and reload the page automatically: loses unsynced input and surprises users.
- Keep old assets on the server across deploys: needs deploy tooling; still useful as a follow-up.

## Trade-offs
A user who never clicks the toast stays on the old build until all tabs close. The first use of
code highlighting or xlsx import while offline (before it was ever used online) fails.

## How others solve it
Workbox "prompt for update" recipe; GitHub/Slack web clients show a "new version" banner.

## Consequences
Server follow-up (P-server): return 404 for missing `/assets/*` instead of the SPA shell, so stale
chunk errors are explicit. The `Cache-Control` split (immutable hashed assets, `no-cache` shell) is
in 0752.

## References
- apps/web/vite.config.ts (VitePWA options, `LAZY_ONLY`, `chunkFileNames`)
- apps/web/src/lib/pwa.ts (`initPwa`, `reloadOnceForStaleChunk`), apps/web/src/main.tsx
- apps/server/src/index.ts (`isReservedPath`), apps/server/src/routes/shareMeta.ts:181, routes/ical.ts:194
