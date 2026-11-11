# 2543. Unsaved growth is what the document took in, not the frame length

- Status: Accepted
- Date: 2026-11-12

## Context
ADR 2530 counted each admitted update's frame length as unsaved growth until the next store. The 0.22.0
re-review (N4) re-sent an update the page already held: nothing changed in the document, but each copy
counted, and a workspace storing 2 MB was counted at 20.78 MB, refusing its owner's paste and uploads.

## Decision
With a storage limit set, an admitted update still reserves its frame length (an upper bound) at once, so
a burst cannot take the same room twice. On the next turn of the event loop (Hocuspocus applies an
admitted frame in the same turn: its hook chain is promises only) the reservation is replaced by:
- the length of the document's own `update` events for updates from socket connections (Yjs encodes only
  the new structs and deletions, and emits nothing for an update the document already held;
  Hocuspocus listens to the same event, so the encoding is shared and nothing is re-encoded), plus
- the change in the bytes the document holds back for missing structs or deletions (`pendingStructs`,
  `pendingDs`), which are stored with it and would otherwise be free.

Measuring the size difference by encoding the document before and after was rejected: a full encode of a
multi-MB page per keystroke.

## Consequences
- The review's run: 17.4 MB of copies count 0 bytes; the owner's 1 MB paste is applied.
- A store that runs between an update's application and its settling covers the reservation; the settle
  never takes the count below zero.
