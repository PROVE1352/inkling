# 2548. Live editing is admitted with its index rows, and a store's estimate stays until a recount sees it

- Status: Accepted
- Date: 2026-11-12

## Context
0.22.1 was built in two parts that each measured without the other: the collab socket's checks (ADR 2540–2544,
at a 20 MB limit with indexes not counted) and the storage count with the search indexes (ADR 2545, at 10 MB,
measured with REST appends). Measured together on the merged tree with the demo preset (production build,
10 MB, w22-reports/merged):

- A burst over the collab socket was admitted against `cached use + unsaved growth`, the body alone. Its index
  rows came 8–30 s later: one socket ended at 214 % of the limit with prose and 274 % with random words after
  the recount (database +38 MB and +96 MB).
- A store that found the cache stale (a new workspace, or one idle for 10 minutes) recounted beside its own
  upsert (`setImmediate`), counted the page without its new body and wrote that over the store's delta and
  estimate. Every new workspace's first store was counted as 0 for 40 s; with that, one socket reached 317 %.
  The same path serves REST and MCP body writes (a DirectConnection store); ADR 2545's runs never met a stale
  workspace.
- Any recount before the index pass (a refused update's, the settings screen's, the stale one) wrote the count
  without the rows to come, so the estimate was gone until the next recount, while live editing went on.
- The estimate itself: over the collab socket the index rows came to 1.98 × the body for prose (the repository's
  own docs pasted, `page_chunks` 1.93, `page_texts` 0.09) and 2.73 × for random words, and the change log kept no
  copy of pasted text. ADR 2545's "2.2–2.3 + 1 change-log copy = 3" are numbers of the REST path.
- With 3 the store's estimate pushed ordinary editing into read-only: a 1 MB paste and typing after it went
  read-only for 2 s from a real use of 4.5 MB, and for 42 s (the editor never came back, ADR 2549) from 5.5 MB,
  while the workspace ended at 9.1 MB.

## Decision
With a storage limit (nothing of this runs without one):

1. **One estimate for both places.** `INDEX_BYTES_PER_BODY_BYTE` is 2 and lives in `quota/collabGrowth.ts`
   (re-exported by `quota/storage.ts`). The store reserves it per byte the body grew, as before. The collab
   admission counts unsaved growth with it: `cached use + (unsaved + this update) × STORE_BYTES_PER_UNSAVED_BYTE
   (= 3) + version copy ≤ limit`; `collabUnsavedBytes` (what the REST checks add) and `collabFullInMemory` use
   the same factor. The per-page cap still counts the body alone.
2. **The stale recount runs after the upsert.** `noteBodyStore` only marks the page; `collab.ts storeDocument`
   calls `noteBodyStoreWritten` once the upsert is in (synchronously before it schedules the index pass), which
   starts the recount. A failed upsert drops its estimate (the cache keeps its delta as an upper bound until the
   next recount).
3. **Estimates a recount has not seen stay in the cache.** Each body store adds an entry per page: the body's
   change and its index estimate. The body part is seen by a recount that starts after the store's upsert; the
   index part by one that starts after an index pass numbered after that upsert has written its rows
   (`docIndexer.ts` numbers passes when their state is chosen and reports finished ones to `noteIndexPassDone`). A
   recount writes `count + entries it did not see` and forgets the rest. Body stores and recounts of one
   workspace take turns in the process, so a recount sees a store's delta and entry together or neither. A pass
   that lands schedules a recount 0.5 s later (the 40 s one stays as the fallback, re-armed while entries
   remain); entries older than 10 minutes are dropped. `usage` and the recount's return value are this cache.

Considered: keeping 3 and refusing earlier (the admission at 4 ×) — ordinary editing then goes read-only from a
real use of about 5 MB; recounting only from the index pass (no 40 s timer) — a pass that fails would leave the
estimate forever.

## Measured (production build, demo preset 10 MB, heap 448; before = 1e1d0cb, w22-reports/merged and fix4)
| | before | after |
|---|---|---|
| one socket, 8 pages, prose (after the recount) | 214 %, DB +38 MB | 71 %, DB +18.7 MB |
| same, random words | 274 %, DB +96 MB | 91 %, DB +24.9 MB |
| same, a workspace never recounted | 317 %, DB +36 MB | 95 %, DB +10.9 MB |
| non-indexed text (a Y.Text outside the body) | 76 % | 29 % (counted × 3 until a recount, see Consequences) |
| 1 MB pastes over the socket, page after page (3b's appends), prose / random | 106 % / 137 % | 71 % / 91 % |
| REST appends of 1 MB (3b's n3), prose / random | (2545: 134 % / 137 %) | 121 % / 137 % (DB +16.4 / +18.7 MB) |
| a 1 MB paste, then typing: lowest real use with any read-only moment | 4.5 MB (2 s), 5.5 MB (42 s, editor lost) | 5.5 MB |
| the same: lowest real use where the paste itself is refused | above 8.7 MB | 6.4 MB (it would end at 10.0 MB) |
| cache right after a store / after the 40 s recount (1 MB of prose, a new workspace) | 0.00 / 3.60 MB | 3.58 / 3.60 MB |

From 5.5 MB the refusals are the version copy the next store takes (the page holds 1.19 MB, the room left after the
paste is less): typing in that page is refused, a refusal's recount reopens it within 2–31 s, and it is refused
again; the workspace ended at 9.10 MB (5.5) and 9.60 MB (6.0). Other pages edit normally.

The REST path checks a body write against "full", not against its size (ADR 2545), so it still ends one write past
the limit; with 2 instead of 3 the prose run took one more append (5) and ended lower (12.1 MB, 2545: 13.4 MB),
random words the same (4 appends, 13.7 MB).

Database growth per workspace filled once, all of the runs above: 9–19 MB with prose, 19–25 MB with random words,
so 100 workspaces come to at most about 2.5 GB, under the 3,000 MB fuse. ADR 2545's "100 workspaces of prose come
to about 1.5 GB" was measured through REST only; through the socket before this change it was 36–38 MB (prose)
and 96 MB (random) per workspace, which 100 workspaces would not fit.

## Consequences
- A burst over the socket stops at about a third of the room left in body bytes; what it stores then grows by
  its index rows to about the limit, not past it. Prose ends below the limit; random words come closest.
- Non-indexed growth (a Y.Text or map outside the body) is counted × 3 until a recount after its (empty) index
  pass drops the estimate: such content can be refused at a third of the room for up to 40 s. Known limit.
- The count after a restart: the entries are in memory only. The cache in the database keeps every store's
  delta and estimate as written, and the first recount after boot (the hourly housekeeping, the settings
  screen after a minute, a refusal) replaces them with what is stored.
- One more read per body store with a limit (the page's workspace, to take its turn).
- Without a limit: `noteBodyStore` returns at once as before; per index pass one counter increment and one call
  that returns at once (no entries) run on every server.
