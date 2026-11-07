# 0754. Close live collaboration connections when permissions change

- Status: Accepted
- Date: 2026-11-07

## Context
The server keeps no permission cache: sessions, memberships and visibility are read from the DB per request. The one long-lived authorisation is a Hocuspocus connection, checked once in `onAuthenticate`. After a member was removed, a page made private, an account force-deleted or a password changed, already-open sockets kept receiving and sending document updates, and those updates were persisted.

## Decision
`liveConnections.ts` (registered by `collab.ts`, importable without cycles) closes matching connections after the change commits:
- member removal / leave → that user's connections to documents of that workspace;
- page subtree made private → connections of everyone except each page's creator;
- force delete → all of the user's connections including `inbox:<id>`;
- `setPassword` / `revokeSessions` → all connections of the user except those opened with the kept session (connection context now carries the session token).
`Connection.close()` removes the connection from the document; further messages from that socket are not applied and the socket is closed when it has no other documents. Allowed users reconnect and re-authenticate transparently.
`liveDocState()` lets "before restore" / "before AI edit" snapshots read the in-memory document (it leads `page_docs` by up to the store debounce).

Tests: `src/perf.test.ts` — one per event (force delete incl. inbox, kept session, member removal limited to the workspace, private subtree sparing the creator, trashed pages).

Also fixed with this change (same events, found by the cache audit):
- force delete: the user's private pages become ownerless and `visibleTo` shows ownerless private pages to everyone; they are now moved to the acting admin's trash (still private, restorable or purgeable by that admin).
- `setPassword` (reset, temp password, own change) deletes the user's OAuth/MCP grants.

## Trade-offs
Trashing a page does not close its sockets (viewers are redirected by the web app; restore is possible). iCal tokens are not revoked on password change (read-only feed; revocable in settings).
