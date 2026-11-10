# 2200. Device copies of pages in IndexedDB, written without y-indexeddb

- Status: Accepted
- Date: 2026-11-10

## Context
The service worker precaches the app shell (ADR 0706), but no data: a page opened without a
connection showed "Connecting…" forever, and edits typed through an outage lived only in the tab's
Y.Doc (ADR 1926). 0.18 keeps the Yjs documents of pages the user opened on the device so they open
and can be edited offline, and uploads the edits through the normal Hocuspocus sync when the
connection is back.

## Decision
- **Store**: one IndexedDB database `inkling-offline` with stores `meta` (owner), `docs` (one record
  per user + page: workspace, title, generation, pending counters, local clientIDs, bytes, update
  count, opened/saved times), `updates` (append-only Yjs updates, index on user + page), `snapshots`
  (app JSON, ADR 2202) and `recovery` (ADR 2201). Keys always include the user id.
  `apps/web/src/lib/offline/store.ts` is the interface plus a memory implementation for node tests;
  `idbStore.ts` is the browser one.
- **Written directly on the platform API, not with `y-indexeddb`.** What y-indexeddb does (append
  updates, fold them) is ~40 lines here; what we need on top it does not have: per-user keys and an
  owner check inside every write transaction (a tab left open after a logout must not recreate a
  copy), pending counters, generations, recovery items and eviction. No new dependency (ADR 0882).
- **Writing**: `pageCopy.ts` loads the stored updates into the empty Y.Doc *before* the provider
  exists (origin `LOAD_ORIGIN`, so nothing counts as a local edit), then appends every doc update
  in 120 ms batches (`Y.mergeUpdates`). After 64 appends it folds the stored updates into one inside
  one readwrite transaction, so another tab's append is either folded in or lands after: two tabs
  never overwrite each other (case H).
- **Unsent edits** are counted per editing session (one tab's Y.Doc), not by Yjs clock: a
  delete-only edit does not advance a clock (the lesson of ADR 1920) but must still be uploaded. When
  the provider is back at 0 unsynced changes the session clears its own counter and the ones it
  adopted from the device at load, compare-and-delete, so a newer edit or another tab's stays marked.
- **Limits** (`limits.ts`): 200 pages and 100 MiB of stored updates per device; over either, the
  least recently opened copies go first, never one with unsent edits and never one open now (so the
  limit can be exceeded by copies that must stay).
- **Failures never stop editing**: a quota error or an IndexedDB that cannot be opened (some private
  modes) marks the storage as failed/unavailable; the editor keeps working exactly as before 0.18,
  the leave guard is armed again (ADR 2204) and the banner says so.
- **What is kept**: doc pages opened in the editor. Public share pages (`/s/…`) are never stored:
  they are server-rendered HTML outside the app, excluded from the service worker's navigation
  fallback, and have no collaboration socket. Guests' pages are stored like members' (a guest is a
  signed-in account); losing the grant deletes them (ADR 2203). Page embeds, the canvas, database
  rows, ink, comments and attachments are not stored in v1.
- The service worker still caches no API JSON (vite.config.ts): the app reads the device data itself.

## Alternatives considered
- **y-indexeddb 9.x**: one database per document name (no user in the key, so a second account on
  the device would read the first one's), no owner check, no place for pending marks or generations.
- **One full-state write per change**: simpler, but the last tab to write wins and a 1 MiB page would
  be re-encoded on every keystroke.
- **Service worker cache of `/api/*` JSON**: rejected by the precache policy; permission changes and
  personal data must come from the server.

## Consequences
- The memory store and the IndexedDB store share the record logic (`applyAppend`, `applyClear`), and
  node tests run the cases on the memory store; the IndexedDB store is checked in a real Chrome.

## References
- apps/web/src/lib/offline/store.ts, idbStore.ts, pageCopy.ts, limits.ts, runtime.ts
- apps/web/src/lib/offline/store.test.ts, offline.test.ts
