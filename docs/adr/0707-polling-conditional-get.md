# 0707. Conditional GET for polled queries, keyed by the cached object

- Status: Accepted
- Date: 2026-11-07

## Context
Pages (20 s), collection (15 s), comments (15 s) and notifications (30 s) are polled. The server now
sends ETags (0752; collections validate before doing the work). With plain `fetch` the browser cache
turns a 304 into a 200 with the cached body, so the client still parsed the full JSON and React
Query walked it for structural sharing on every poll. Synthetic 10 000-row collection (3.5 MB):
JSON.parse 18 ms + structural sharing 22 ms per unchanged poll on an M-series Mac (Node/V8), plus
~15 MB of short-lived garbage each time.

## Decision
`pollingQuery()` in `api.ts` builds the query options: `cache: 'no-store'` + `If-None-Match` with the
ETag remembered for the object React Query currently holds; on 304 it returns that same object
(React Query sees no change: no parse, no walk, no re-render). The ETag lives in a `WeakMap` keyed by
the data object, and a custom `structuralSharing` moves it to the object React Query keeps, so data
replaced by `setQueryData`/optimistic updates has no ETag and gets a full fetch. No copy of the data
is retained.

Verified: the pages poll shows 200 then 304 on every later poll (JS-observed in Chromium and WebKit;
Playwright's WebKit network events report 200 for these 304s).

## Alternatives considered
- URL-keyed ETag cache holding the parsed body: doubles memory for large collections.
- `since` cursor/delta API: needs server change tracking; the ETag already removes the unchanged case.
- WebSocket push instead of polling: larger change; the inbox/comments stateless channels exist already.

## Trade-offs
Only unchanged polls get cheaper; a change still transfers the whole collection (incl. refs).

## How others solve it
SWR/React Query users commonly add ETag middleware; GitHub's API recommends conditional requests for polling.

## Consequences
A delta API for very large collections remains a possible follow-up with P-server.

## References
- apps/web/src/api.ts:155 (`pollingQuery`), `usePages`, `useCollection`, `useComments`, `useNotifications`
- apps/server/src/httpCache.ts (`precheckEtag`, `registerApiCachePolicy`)
