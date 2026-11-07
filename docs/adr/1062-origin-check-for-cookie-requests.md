# 1062. Cross-site requests refused by Origin; the collab upgrade too

- Status: Accepted
- Date: 2026-11-07

## Context
CSRF and cross-site WebSocket protection relied on `SameSite=Lax` alone (C-L4). Lax treats sibling
subdomains as same-site, an older browser or a misconfigured proxy can weaken it, and a WebSocket
handshake carries cookies regardless.

## Decision
- An `onRequest` hook on the `/api` scope (`csrf.ts`) checks every request whose method is not
  GET/HEAD/OPTIONS:
  - `Authorization` present → skipped (bearer clients carry no ambient credential; a cross-site page
    cannot add the header without a CORS preflight, which `/api` never grants).
  - `Sec-Fetch-Site: cross-site` → 403. `Origin` (else the origin of `Referer`) present → must equal
    an allowed origin, else 403 `CROSS_SITE_REQUEST`. `Origin: null` → 403.
  - Neither header → allowed: browsers always send `Origin` on such requests, so this is a
    non-browser client (inklingctl, curl, scripts with a cookie).
- Allowed origins: the origins of `PUBLIC_URL` and `APP_URL`. A loopback `PUBLIC_URL` also accepts other
  loopback origins (Vite dev server). With neither set (development without mail), the origin must
  match the request `Host`, or both must be loopback (the Vite proxy rewrites Host to :3001).
- `/oauth/token`, `/oauth/register` and `/mcp` live outside `/api` and are not checked. Public share
  routes under `/api/public` are checked; the SPA calls them same-origin. Plugin frames talk to the
  host by postMessage, never to `/api` directly.
- The `/collab` WebSocket upgrade applies the same rule before the session lookup (403).
- `SameSite=Lax` stays: `Strict` would land every link into the app (shares, verification, reset)
  signed out.

## Consequences
- Opening the app at an address other than `PUBLIC_URL`/`APP_URL` (a LAN IP, a second domain) makes
  writes fail with 403; reads still work. Set `PUBLIC_URL` to the address people use.
- Tests: `authSecurity.test.ts` (checkRequestOrigin, [db] cross-site requests).
