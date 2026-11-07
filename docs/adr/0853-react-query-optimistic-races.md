# 0853. Optimistic cache writes: cancel first, roll back per field, refetch when the last one settles

- Status: Accepted
- Date: 2026-11-07

## Context
The concurrency audit (A-Low, web cache) found the following:
- `CollectionView.onReorderRow` and `dateItems.patchCaches` called `setQueryData` without
  `cancelQueries` (confirmed). A collection poll or calendar refetch that started before the
  write landed after it, and the card or event snapped back until the next poll.
- `useUpdatePage`, `useMovePages` and `useUpdateProps` rolled back by restoring the whole-list
  snapshot taken in `onMutate` (plausible). Two quick edits A then B, where A fails after B was
  applied, also erased B from the UI. Each mutation's `onSettled` invalidated immediately, so a
  refetch could run while another mutation was still in flight and show the server's older
  state over its optimistic value.

## Decision
- `lib/optimistic.ts` records, per item and field, the value a mutation replaced and the value
  it wrote (`patchItems`, `patchRowProps` with null-deletes like the server).
  `revertItems` / `revertRowProps` restore a field only while it still holds the value this
  mutation wrote. A later mutation or a refetch owns the field otherwise. Rollback is applied
  to the *current* cache.
- `useUpdatePage` and `useMovePages` share `mutationKey: ['pages-write', wsId, …]`, and
  `useUpdateProps` uses `['props-write', …collectionKey]`. `onSettled` invalidates only when
  `isMutating({ mutationKey: prefix }) <= 1`, which counts the settling mutation itself. The last
  mutation of a burst refetches.
- `onReorderRow` and `patchCaches` await `cancelQueries` before writing. `patchCaches` rollback
  restores only the touched item in each calendar and due cache (re-inserting a due item at its
  old index), looked up by its post-patch key.

Tests: `apps/web/src/lib/optimistic.test.ts` covers a failure after a later edit on another item,
a newer write to the same field, a refetched value, absent fields, and per-key props rollback.

## Alternatives considered
- Serialise all page mutations through one queue. It is simpler to reason about but makes rapid
  drag-and-drop feel sluggish.
- Version numbers or ETags in the cache. Bigger change; the server does not version page
  metadata.

## Trade-offs
A partially failed batch move (`BatchError`) reverts every move of the batch optimistically; the
refetch that follows shows the moves the server did apply.
