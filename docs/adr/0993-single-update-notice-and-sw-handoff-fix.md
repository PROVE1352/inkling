# 0993. One update notice at the app root; the SW hand-off looks up the waiting worker on accept

- Status: Accepted
- Date: 2026-11-07

## Context
Production, 2026-11-07: a Chrome tab kept the old bundle after a deploy.
`navigator.serviceWorker.getRegistration('/')` showed `waiting.state === 'installed'` and a
controller, so `lib/pwa.ts`'s `if (reg.waiting && sw.controller) promptUpdate(reg.waiting)` held,
but the toast container was empty. Reproduced locally (production build, two SW versions swapped on
disk, Playwright):

1. **Stale worker on accept.** `promptUpdate(waiting)` captured the worker when the toast appeared.
   A second deploy before the click installed a newer worker and made the captured one
   `redundant`. "Reload" posted `SKIP_WAITING` to the dead worker: no `controllerchange`, no
   reload, the toast removed itself, and the newer worker stayed in `waiting`. Exactly the observed
   state.
2. **Latch.** `prompted` was set once per page and never reset, so after (1), or after closing the
   toast with X, no later update was ever announced in that tab.
3. **Mount point.** `ToastContainer` lives in `AppLayout` only. On `/`, `/login`,
   `/settings/connections`, `/oauth/authorize` and public pages the toast went into the store with
   nothing rendering it.

The production bundle itself could not be inspected (no access); the local reproduction used the
same `pwa.ts` source.

## Decision
- `lib/pwa.ts` no longer shows a toast. It reports "a worker is waiting" (and "another tab
  activated one") to the update store (ADR 0991), on every new worker, so the signal re-arms.
- It also watches `reg.installing` right after `register()`, covering an update the navigation
  started before the deferred registration ran.
- `reloadToLatest()` resolves the worker **when the user accepts**: it calls `reg.update()` first
  (a worker waiting since an earlier deploy may itself be outdated), waits up to 30 s while a newer
  worker installs, takes `reg.waiting`, then sends `SKIP_WAITING` and waits up to 8 s for
  `controllerchange`. If no worker takes over, unregister (the registration stays in use
  until this page unloads) so the reload fetches `index.html` from the server. It always ends in
  a reload. If another tab already activated the new worker, it reloads directly.
- Each new server build id (ADR 0990) also starts `reg.update()` in the background, so the new
  precache is usually ready when the user clicks.
- `UpdateBanner` at the root is the only update notice, so the SW path and the header path never
  show two.

## Alternatives considered
- Keep the toast and mount `ToastContainer` at the root: fixes (3) only, and would duplicate the
  container inside `AppLayout` (shared file under concurrent edits).
- `virtual:pwa-register` / workbox-window: handles some of this, but adds a dependency (lockfile
  change) and still needs the root-level notice.
- `registerType: 'autoUpdate'`: rejected in ADR 0706 (swaps the SW under a running tab).

## Trade-offs
- The unregister fallback costs the next load a full precache download.
- Waiting up to 30 s for an install on a slow link before reloading; the banner shows a spinner.

## How others solve it
- workbox-window fires a `waiting` event per new waiting worker and `messageSkipWaiting()` targets
  the registration's current waiting worker, not one captured earlier.

## Consequences
- Verified end to end: two deploys before the click now land on the newest build; the banner
  appears on routes outside `AppLayout`.
- Tabs already running a bundle from before this change keep the old behaviour until they reload
  once; the next deploy after that is handled by the new code.

## References
- `apps/web/src/lib/pwa.ts`, `apps/web/src/lib/update.ts`, `apps/web/src/components/UpdateBanner.tsx`
- ADR 0706, 0990, 0991
