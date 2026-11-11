# 2541. Awareness: four client ids per connection, 16 KB per state, 64 KB per message, 256 KB per socket

- Status: Accepted
- Date: 2026-11-12

## Context
Hocuspocus 2.15 applies every awareness message (`MessageReceiver`: `applyAwarenessUpdate(document.awareness, …)`,
y-protocols 1.0.7), read-only connections included, and keeps one state per client id until the id is
removed or quiet for 30 s; y-protocols also keeps a clock record per id until the document unloads. The
0.22.0 re-review (N1(c)) announced 14,000 new ids of 16 KB each from read-only connections and ran a 320 MB
heap out of memory in 25 s. This has been possible since 0.21.1, on every server, for any member.

## Decision
On every server, `collab.ts beforeHandleMessage` reads each awareness frame's lengths
(`collabAwareness.ts`, no JSON parsed) before Hocuspocus applies it and refuses it when:
- the frame is over 64 KB;
- one state is over 16 KB;
- the document connection would have announced more than 4 distinct client ids;
- the states its socket keeps across all its documents would pass 256 KB.

A refused frame is never applied: the socket is terminated (close code 1006 to the client; the frames it
already sent are not handled) and the hook throws so Hocuspocus drops the message.
When a document connection closes, the clock records of the ids it announced that no longer have a state
are dropped, so connecting and closing over and over leaves nothing behind.

Measured in Chrome (BlockNote editor, user name, colour, account id and cursor): the largest awareness
frame was 378 bytes; the in-process test's editor state was 266 bytes. A tab announces one id per document.

## Consequences
- One connection keeps at most 4 × 16 KB; one socket at most 256 KB; one address at most
  40 sockets × 256 KB = 10 MB. One document: (connections to it) × 64 KB, and connections per address
  are capped at 40, so 2.5 MB per address per document.
- Not added: a rate limit on awareness messages. What is kept is bounded by the caps; a fast sender only
  costs CPU (with a storage limit or the fuse, the per-address byte bucket bounds that too).
- A client that sends what no client of ours sends loses its socket; the provider reconnects.
