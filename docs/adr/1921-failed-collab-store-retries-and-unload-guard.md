# 1921. A failed collab store retries, and an unsaved document is not unloaded

- Status: Accepted
- Date: 2026-11-10

## Context
The collab store retries its write three times (~1.75 s) and then gave up, counting on "the next
change" to store again. Hocuspocus deletes its debounce timer when a store starts. When the last
client then leaves, `onClose` sees no queued store and unloads the document at once: the edits that
failed to store were gone. The same happened when the last client left while a store was still
retrying. The test reproduces both with a real WebSocket client and an injected database fault.

## Decision
- A store that fails after its retries arms a retry timer for that document (5 s, doubling up to
  60 s) and logs. The error still reaches DirectConnection callers (REST/MCP writes).
- `beforeUnloadDocument` checks whether the document changed since its last successful store (the
  O(1) update counter of ADR 1041, then the stored digest). If it did, it stores now. If that store
  fails, the document is pinned (one direct-connection count), which makes Hocuspocus's own re-check
  after the hook keep it in memory, and the retry timer stores it. The successful store unpins it and
  unloads it.
- A document whose load never finished is never stored (it would write an empty document).
- Shutdown gives pinned documents one more store; what still fails is named in the log, and the
  guard stops pinning so the shutdown can finish.

## Alternatives considered
- **Throwing from `beforeUnloadDocument`**: aborts the unload, but Hocuspocus calls `unloadDocument`
  without awaiting it, so every attempt would be an unhandled rejection.
- **Keeping the failed store's debounce timer alive**: the timer belongs to Hocuspocus; its debounce
  interval cannot back off.

## References
- apps/server/src/collab.ts, apps/server/src/liveConnections.ts
- apps/server/src/collabStoreFailure.db.test.ts
