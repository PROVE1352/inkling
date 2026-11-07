# 0702. One collaboration WebSocket per tab

- Status: Accepted
- Date: 2026-11-07

## Context
Every `HocuspocusProvider` (main editor, each page embed, canvas, the `inbox:<user>` channel)
created its own socket. A page with 5 embeds held 7 sockets; the server caps sockets per IP at 40
(collab.ts `MAX_CONN_PER_IP`) and upgrades at 30 per 10 s, so a few tabs behind one NAT could be
refused. Providers were also constructed during render (`useState` initializer): harmless while
each owned an idle socket, but a live shared socket would make a discarded render (Suspense) leak a
connected provider. `useCanvasDoc` listed `me.name` as an effect dependency: renaming yourself ran
the cleanup (provider destroyed) and then `connect()` on the destroyed provider — a zombie socket.

Measured (production build, headless Chromium/WebKit, page with 5 page embeds, then 6 SPA
navigations): before 7 sockets open on the page, 13 created over the run; after 1 open, 3 created
(2 short-lived fallbacks, see below), 1 open at the end.

## Decision
`lib/collabSocket.ts` owns a tab-wide `HocuspocusProviderWebsocket`. `openCollab()` is called from
effects only and returns `{ provider, release }`; the editor/embeds/canvas create the Y.Doc in state,
the provider in the effect, subscribe in the same tick and read status/synced defensively.
Hocuspocus multiplexes documents by name; the rules that keep that correct:
- **Duplicate name** already attached (self-embed, same embed twice) → dedicated socket (old path):
  client provider map and server connection are keyed by name.
- **Just closed** on the shared socket (< 3 s) → dedicated socket. The server processes a Close
  asynchronously, so an Auth for the same name sent right after is routed to the dying connection
  and dropped ("Received an authentication message on a connection that is already fully
  authenticated") — the new provider would never sync. Hit by clicking an embed of X (embed of X
  released, editor of X opened in the same commit).
- **Denied** on the shared socket → never retried on it: the server keeps the name in
  `documentConnectionsEstablished` after a permission-denied and would queue a new Auth forever.
- Identity: the upgrade request's cookie is the socket's identity, so the socket is keyed by user id;
  another user never reuses it and it closes when its last provider is released (logout unmounts all).
- Status: providers attached to an already-open socket get no `status` event, so status is read from
  the socket; `authenticationFailed` forces "disconnected" for that document.
- `preserveConnection: true`: a provider's destroy/permission-denied detaches only its document.
- Watchdog: a document still unsynced on a connected shared socket after two 10 s checks re-sends
  its Auth + SyncStep1 (before 0702 a stuck document's own socket was recycled by the 30 s
  no-message check; on a shared socket other documents keep it alive).
The inbox channel loads yjs/Hocuspocus lazily (entry chunk, 0704). `useCanvasDoc` effect deps are
`[doc, pageId, me.id]`; the awareness `user` field is updated in a separate effect.

Validation: navigating from the embeds page to an embedded page 1.5 s after load (3 runs each),
with the grace fallback (2 sockets, synced in ~60 ms, typed text on the server and after reload) and
with the grace disabled (1 socket, same result). The race was not reproduced locally; the fallback
is kept because when it happens the client can believe it is synced (the dying connection answers
SyncStep1) while later updates are dropped — a case the watchdog cannot see.

## Alternatives considered
- Keep one socket per provider and raise the server cap: more server memory/FDs, same NAT problem.
- Lazy-create providers in render with a parked socket: provider constructors register socket
  listeners, so a discarded render would still auth/sync on the next socket `open`.
- Patch the server to handle Close→Auth for one name: upstream code, out of scope here.

## Trade-offs
The fallbacks re-introduce a second socket briefly in the edge cases above. One socket means one
head-of-line: a huge initial sync of one document delays messages of the others on that tab.
Revocation (0754, server closes a document connection without closing a socket that still carries
other documents) is not signalled to the client: that document stops syncing while the socket stays
connected. See "Consequences".

## How others solve it
Hocuspocus documents `HocuspocusProviderWebsocket` for multiplexing; Liveblocks and Y-Sweet keep one
connection per room client but share a transport per tab.

## Consequences
- Follow-up for the server (P-server): when `liveConnections.closeWhere` closes a document on a
  socket that stays open, also send that document a permission-denied message
  (`OutgoingMessage(name).writePermissionDenied('permission-changed')`) so the client marks it
  disconnected; the client already handles `authenticationFailed`.
- Follow-up for the server: answer missing `/assets/*` with 404 instead of the SPA shell (see 0706).

## References
- apps/web/src/lib/collabSocket.ts:103 (`openCollab`), :167 (`readStatus`)
- apps/web/src/components/CollabEditor.tsx, canvas/useCanvasDoc.ts, blocks/PageEmbed.tsx, AppLayout.tsx (`InboxRealtime`)
- @hocuspocus/server ClientConnection.ts (setUpNewConnection onClose, handleQueueingMessage), MessageReceiver.ts (Auth on established connection)
- apps/server/src/collab.ts:165 (`MAX_CONN_PER_IP`)
