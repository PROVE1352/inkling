# 0990. Build id in the bundle and an X-Inkling-Build header on every API response

- Status: Accepted
- Date: 2026-11-07

## Context
After a deploy, a browser tab kept running the previous bundle (`index-B7mWVBsR.js`). Its service
worker had the new version installed and waiting, yet no "new version" notice was on screen, and a
route added in the new build (`/w/:id/workspace-settings`) was redirected to `/` by the old router.
The client had no way to tell that the server it talks to runs a different build: the only signal was
the service worker update path (ADR 0706), which only exists in production with a working SW and
which turned out to be fragile (ADR 0993).

## Decision
- The web build gets an id: `INKLING_BUILD` when set (e.g. a commit hash passed as a Docker
  build-arg), otherwise a 12-hex hash of the build time and random bytes. No git is needed.
- `vite.config.ts` compiles it into the bundle (`__INKLING_BUILD__`) and emits `dist/build.json`
  (`{ build, builtAt }`). JSON is outside the workbox precache globs, so the SW never caches it.
- The server reads `WEB_DIST/build.json` once at boot (`apps/server/src/version.ts`), falling back to
  the `INKLING_BUILD` env var (for setups that serve the web bundle elsewhere), else no id.
- Every `/api` response carries `X-Inkling-Build: <id>` (an `onRequest` hook registered first inside
  the `/api` plugin, so 304s, errors and 429s carry it too). No header when the id is unknown.
- `GET /api/version` returns `{ build, version, updateMode }` (`version` = `APP_VERSION` or the server
  package version).
- The client compares the header with its own id in `api()` and `pollingQuery()` (before the 304
  early return: idle tabs mostly poll) and in the boot-time `/api/version` fetch. A dev bundle or a
  server without an id never counts as a mismatch.

## Alternatives considered
- Commit hash only: needs git in the build context; the Docker build copies the tree without `.git`.
- Server-side id from env alone: two independent sources (web build vs runtime env) drift apart and
  produce a permanent mismatch. Reading the id from the bundle the server serves makes them agree by
  construction.
- Polling `index.html` and comparing script names: an extra request per interval, and it breaks
  under a SW that answers navigations from the precache.
- A version field in each JSON body: changes every DTO; headers also cover 204/304 and errors.

## Trade-offs
- A time-based id changes on every rebuild even when the output is identical, so a rebuild without
  changes still triggers one "new version" notice. Passing `INKLING_BUILD` avoids that.
- One extra response header (~35 bytes) on every API call.

## How others solve it
- Discourse pushes an asset version to open tabs and shows "this site was just updated, refresh".
- Next.js stamps each build with a `buildId`; on version skew between a client and the deployment
  the router falls back to a full page load.
- Many SPAs poll a `version.json` written at build time; a header piggybacks on traffic the app
  already makes instead.

## Consequences
- Version skew is detected with or without a service worker, on every route, within one API call.
- Operators can tag builds (`--build-arg INKLING_BUILD=$(git rev-parse --short HEAD)`).
- The build id is public (it is in the bundle anyway); no other information is exposed.

## References
- `apps/web/vite.config.ts`, `apps/server/src/version.ts`, `apps/web/src/lib/update.ts`
- ADR 0706 (service worker update), 0991 (update modes), 0993 (notice fix)
