# 0992. Force mode reloads only when nothing local is unsaved

- Status: Accepted
- Date: 2026-11-07

## Context
In `UPDATE_MODE=force` the tab reloads by itself. Document edits are Yjs updates sent over the
shared collaboration socket (ADR 0702); a reload while an update is not yet acknowledged by the
server, or while the socket is down, drops it. Other in-flight work (API mutations, a user typing)
must not be cut off either. A reload must also never loop.

## Decision
- `collabSocket.ts` keeps a set of every live `HocuspocusProvider` (shared and dedicated sockets).
  A document is pending while `provider.unsyncedChanges > 0`: Hocuspocus increments it per local
  update and on (re)sync start, and decrements it on the server's `SyncStatus` acknowledgement, so it
  covers both "sent but not acknowledged" and "offline with local edits".
- Reload when all hold: no pending document, no React Query mutation in flight
  (`queryClient.isMutating() === 0`), and no key/pointer/input/wheel event for 3 s.
- A tab with no user input in its first 15 s reloads at once (it is the old bundle served from a
  cache; nothing can be lost).
- Checked once a second; after 2 minutes without a safe moment, give up and show the banner.
- Loop guard: the time of an automatic reload is kept in `sessionStorage`
  (`inkling:update-reload`); another automatic reload within 5 minutes is refused and the banner is
  shown instead (e.g. a CDN still serving the old shell, a server advertising a build no bundle has).
  Separate from `reloadOnceForStaleChunk`'s key.
- The decision is a pure function (`lib/updatePolicy.ts`) with unit tests.

## Alternatives considered
- `beforeunload` prompt: blocks the reload with a browser dialog, which is what force mode exists to
  avoid, and does not know about Yjs state.
- Waiting for `provider.isSynced` only: it stays true while later local updates are unacknowledged.
- Flushing Yjs to IndexedDB before reload: no offline persistence exists in the app today.

## Trade-offs
- A user who keeps typing for more than 2 minutes gets the banner instead of an automatic reload.
- Form fields outside Yjs (e.g. an unsent comment draft) are protected only by the 3 s idle rule.

## How others solve it
- Collaborative editors commonly gate navigation on "all changes saved" (the same state their save
  indicator shows) and fall back to asking the user.
- y-websocket / Hocuspocus expose exactly this state (`unsyncedChanges`, the `synced` event) for
  save indicators; reusing it keeps one definition of "saved".

## Consequences
- Force mode cannot drop acknowledged-pending Yjs edits; verified end to end with a stalled socket.
- The provider registry adds one `Set` and two lines per open/release in `collabSocket.ts`.

## References
- `apps/web/src/lib/updatePolicy.ts`, `apps/web/src/lib/update.ts`, `apps/web/src/lib/collabSocket.ts`
- ADR 0702 (shared collab socket), 0991
