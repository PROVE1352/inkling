# 2552. Awareness ids count against the connection that brought them in

- Status: Accepted (corrects ADR 2541)
- Date: 2026-11-12

## Context
ADR 2541 capped the distinct client ids that one document connection's awareness messages mentioned at four. The
measurement behind it ("a browser sends one id per document") was taken with one tab alone. The web app's provider,
@hocuspocus/provider 2.15.3, sends back every awareness change it applies (`awarenessUpdateHandler` sends added,
updated and removed alike, whatever their origin), so a tab mentions everyone else's id too. The third security
review measured it with the real provider: five tabs on one page were cut 46–50 times in 10 s, and with two people a
long-open tab was cut once the other had reopened theirs four times (each reopen is a new Y.Doc, a new id). The cut
is the tab's shared socket, so all its documents reconnect. This happened on every server.

## Decision
`collabAwareness.ts` reads each awareness entry as y-protocols will apply it, against the document's own awareness
(and against messages admitted this turn and not applied yet):
- An entry y-protocols would not apply (a clock not newer than the document's, which is every echo) counts for
  nothing.
- An id counts against the connection whose message adds it while the document has no state for it ("brought in").
  It stops counting when the document no longer holds its state, however it went (its own removal, the connection
  closing, the 30-second timeout). A connection may hold **4** such ids. Measured with the real provider: a
  connection brings in exactly one (its Y.Doc's), also after a reconnect and after coming back from offline, when
  the id is the same and the document still knows it; 5, 8 and 12 tabs on one page, a neighbour reopened 20 times,
  and one socket opening 20 pages in turn and 8 at once never brought in more than one per connection.
- A socket may add new clock records (ids the document never saw) **64** at once and then **1 a second**: removing
  an id and bringing in a new one would otherwise grow y-protocols' clock records without end. A page reload makes
  one new id; a fresh socket starts with the full 64.
- A document holds at most **1024** live ids; a connection bringing in one more is refused. So a document's
  awareness is at most 1024 × 16 KB whatever the number of connections.
- The states a socket's connections brought in count against its 256 KB (not the states it echoes). A message may be
  **1 MB** (was 64 KB): the provider's echo after it joins carries everyone's state (12 people: 2.8 KB measured).
- A socket may change **128 KB** of states at once and then **16 KB a second**, counting only entries that change
  something (echoes are free). Hocuspocus sends every change on to every connection of the document, so without a
  rate four ids of one's own re-sent fast multiplied into the other connections' send buffers: 30 sockets re-sending
  four 15 KB states every 100 ms took a server without limits from 217 MB to 3.4 GB of RSS in 15 s (possible since
  ADR 2541). Measured with the real provider: tabs moving their cursors change 0.4–0.6 KB a second each.
- Clock records without a state are no longer dropped when a connection closes (an echo of the removal still on
  its way would bring the id back): they are swept once a minute old, when a document holds more than 256 of them.

The ways the "not counted when already there" rule could be turned around were tested: a socket that keeps
updating ids another socket brought in adds nothing of its own (they stay the other's, and leave when it closes);
ids handed over (one removes, the other re-adds with a newer clock) count against the one that re-adds them; a socket
that brings in and removes ids without end runs out of its 64; one that re-sends its own four ids fast runs out of
its byte rate.

## Consequences
- Ordinary use is never cut: tested with the real provider (5, 8, 12 tabs; 20 reopens; one socket with 20 pages in
  turn and 8 at once; read-only member, guest, inbox-only tabs).
- The floods of ADR 2541 are still refused at the first frame (1.4 MB of new ids, a fifth own id, a 17 KB state).
- A document that already holds 1024 live ids refuses newcomers' awareness, which closes their socket: someone with
  access to the page and ~256 connections could keep others off it. Not seen in ordinary use by orders of magnitude.

## Past a rate the message is dropped, the socket stays (same release, after the first cut of this ADR)

The two rates (new ids: 64 at once then one a second; changed states: 128 KB at once then 16 KB a second) first
closed the socket like the other caps. That was measured with a bare provider (0.4 to 0.6 KB a second per tab). An
editor sends its cursor with every selection change, so a held arrow key or a drag is tens of states a second, the
same order as the rate, and closing the socket there would have repeated the fault this ADR fixes. Raising the rate
instead (1 MB at once, 256 KB a second) let the flood through again: 30 sockets re-sending their own four ids took
the server to 1.3 GB (demo preset) and 3.1 GB (no limits) of RSS.

So past one of the two rates the frame is emptied in place (its entry count set to zero; Hocuspocus hands the hook
the buffer it decodes afterwards), y-protocols applies an empty update, nobody is sent anything, and the socket
stays. The next state the client sends has a higher clock and replaces what was skipped. A person loses cursor
positions in between at most; a flood loses everything past the rate. The other caps (4 ids of its own, 16 KB a
state, 1 MB a message, 256 KB a socket, 1024 ids a document) still close the socket: a web client never reaches
them. `awarenessStats.dropped` counts the dropped messages; nothing is logged for them.
