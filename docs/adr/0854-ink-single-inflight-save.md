# 0854. Ink layer keeps one save in flight and coalesces to the latest strokes

- Status: Accepted (client part of A-M14)
- Date: 2026-11-07

## Context
`PUT /api/pages/:id/ink` replaces the whole stroke list. The ink layer saved on a debounce
timer, on `pagehide` and on unmount, and nothing stopped a second PUT from starting while the
first was still in flight. Requests can complete out of order, so an older stroke list could be
written last and erase recent strokes, even with a single user.

## Decision
`InkLayer` allows at most one save request at a time:
- While a request is in flight, new strokes only mark the layer dirty.
- When it settles successfully and the layer is dirty, one follow-up request sends the latest
  strokes (everything drawn in the meantime is coalesced).
- On failure the layer stays dirty and shows a toast. There is no automatic retry loop; the next
  stroke, `pagehide` or unmount sends the latest state.
- `mutateAsync` promise handlers are used instead of per-call `mutate` callbacks: React Query
  drops `mutate` callbacks after the component unmounts, which would lose the follow-up save
  when pen mode closes during a request.

## Not covered (server, fix-server)
Two editors on different devices still overwrite each other. That needs the server-side
`WHERE updated_at = $expected` → 412 check from A-M14. The client then has to merge or reload on
412 (tracked in docs/KNOWN-ISSUES.md).

## Trade-offs
A save can wait for one network round trip before it starts. Strokes are never lost locally;
they are in React state until sent.
