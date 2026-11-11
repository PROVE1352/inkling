# 2530. Live edits counted against the storage limit when they arrive

- Status: Accepted
- Date: 2026-11-12

## Context
The 0.22 security review (F2) pushed text into open pages over one collab socket: with
`LIMIT_WORKSPACE_STORAGE_MB=20` it stored 33.5 MB, and 40 pages × 8 MB ran a server with a 320 MB heap out of
memory. The connection was judged read-only once, when it was authorised (ADR 2506); the store path noted the
growth only after it had been applied and written; nothing bounded how much one socket could send.

## Decision
With `LIMIT_WORKSPACE_STORAGE_MB` (or `LIMIT_INSTANCE_STORAGE_MB`) set, `quota/collabGrowth.ts`:
- **Counts every update when it arrives**, in Hocuspocus's `beforeHandleMessage` (2.15: it runs before the
  message is applied, and Hocuspocus drops an update of a read-only connection with `SyncStatus(false)`).
  The decision is synchronous, because Hocuspocus starts a separate hook chain per frame and an await would
  let a burst through. Only Sync update and SyncStep2 frames count (their byte length, an upper bound of
  what they add); awareness never reaches a store.
- **Refuses** an update when the page's stored body + unsaved growth + the update passes the page cap (¼ of
  the limit), or the workspace's cached use + unsaved growth of its live pages + the version copy the next
  store may take (`autoSnapshotMayBeDue`) + the update passes the limit, or the instance fuse is tripped.
  A refused update is never applied or stored: the connection becomes read-only at once, gets a stateless
  `{t:'storage'}` and its socket is closed with the ordinary code 4000, so the client reconnects and is
  authorised read-only. The page is remembered for 10 minutes, so the reconnect does not loop.
- **Re-bases** on every successful store (stored length, and the workspace's cached use returned by
  `noteBodyStore`, which now also adds the auto version copy's bytes), on every authorisation (the database's
  numbers) and in the background every 2 s while updates arrive (uploads move the cache too). The REST room
  checks add the unsaved growth, so an upload and a burst of typing cannot take the same room.
- **Bounds the bytes a client sends**: the sockets of one address share a bucket of 16 MB refilled at
  4 MB/s, and a socket may hold at most 8 MB of frames for documents it has not opened (Hocuspocus queues
  those without limit before authentication, while a document loads, and forever after a failed
  authentication). Past either, the socket is terminated. A browser sends far less (one paste is one
  update under the 2 MB frame cap).
- No limit set: `collabGuardsOn()` is false; no hook does anything new, no listener is added to sockets,
  nothing is read, refused or closed.

Not added: a cap on documents per socket. Memory is documents × size, and an address may hold 40 sockets,
so a per-socket count bounds nothing; the per-workspace limit bounds what live editing adds, and what is
loaded is bounded by what is stored.

## Consequences
- Measured with the review's script (`collab_overshoot.mjs`, `--max-old-space-size=320`, limit 20 MB):
  4 × 8 MB stored 16.0 MB; 40 × 8 MB stored 18.0 MB and the server stayed up (RSS 356 MB → peak 615 MB in
  tsx dev mode). The 0.22.0 code on the same run stored 320 MB with an RSS peak of 2.1 GB.
- What the arrival check cannot see: the change log's kept texts (≤ 16 KB per side per changed section) and
  versions written by other paths; they are in the next recount (store path every 10 minutes, hourly
  housekeeping), which then makes the workspace read-only. Two concurrent REST writes can each pass a check
  by at most one request.
- A paste that does not fit makes the page read-only for that tab (and for new connections to the page for
  10 minutes). The text stays in the editor and the device copy; it is not stored.
- Opening many large stored pages still loads them: one account in many workspaces can hold their stored
  bodies in memory at once (bounded by `LIMIT_WORKSPACES_TOTAL` × the workspace limit).
