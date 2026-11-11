# 2542. The inbox document is read-only and refuses updates

- Status: Accepted
- Date: 2026-11-12

## Context
`inbox:<userId>` is an empty document the server uses only to push stateless notices
(`broadcastToUser`). The web app (`AppLayout.tsx InboxRealtime`) never writes to it: its Y.Doc stays
empty, so its sync step 2 is the empty update `[0, 0]`. Hocuspocus applied whatever a client sent to it,
and the document is never stored, so nothing ever dropped it. The 0.22.0 re-review (N1(b)) sent updates
into its own inbox at 3 MB/s and ran a 320 MB heap out of memory in 81 s (every server since 0.21.1).

## Decision
Every server: the inbox connection is authorised read-only, and `beforeHandleMessage` refuses any Sync
update or step 2 to an inbox that carries a struct or a deletion (read by the struct scan of ADR 2540),
before Hocuspocus decodes it (a read-only step 2 is decoded in full to compare), terminating the socket.
The empty step 2 the web app sends passes. Stateless notices from the server are unchanged.

## Consequences
- Tested: the review's push is refused at the first update and the inbox document holds 0 bytes; a
  notice reaches the bell in real Chrome in about 0.1 s and is marked read; the inbox connection is
  `readonly` and stays connected.
- A future client that wants to write into the inbox needs a new decision (a size cap).
