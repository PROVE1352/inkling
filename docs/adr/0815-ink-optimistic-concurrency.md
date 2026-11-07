# 0815. Ink layer: optimistic concurrency with 412

- Status: Accepted
- Date: 2026-11-07
- Audit: A-M14 (server part); builds on 0854 (single in-flight save)

## Decision
- `PUT /api/pages/:id/ink` accepts `expectedUpdatedAt` (ISO string, or `null` for "no ink yet")
  next to `strokes`. The field is parsed in `routes/ink.ts`, so `saveInkSchema` in
  packages/shared is unchanged (zod strips unknown keys).
- The read and the write run in one transaction under a per-page advisory lock. On a mismatch
  (compared as millisecond timestamps) the PUT answers `412 INK_CONFLICT` with
  `error.ink` = the current `InkDTO`. A new `updatedAt` is always at least the previous value + 1 ms,
  so two saves in the same millisecond are still different versions.
- Without the field the old last-write-wins behaviour stays (service-worker-cached clients).
- Client (`InkLayer.tsx`): it remembers the base version (`updatedAt` and stroke ids) from the
  load and from each successful save. On 412 it merges: server strokes, minus strokes that were
  in the base and erased locally, plus strokes added locally that the server does not have. Then
  it re-sends at once, up to 3 conflicts in a row before it falls back to the error toast.

## Consequences
- Erasing a stroke that another device added after our base is not possible until we see it, so
  that stroke survives (no lost strokes, at worst one extra).
- The undo history is not rebased onto merged strokes.
- Test: `fixphase.test.ts`, "ink PUT: expectedUpdatedAt mismatch → 412 …" (stale base, null base,
  legacy client, three concurrent saves on one base → one 200 and two 412s).
