# 2540. A live page holds at most 300k Yjs structs (servers with a storage limit or the fuse)

- Status: Accepted
- Date: 2026-11-12

## Context
The 0.22.0 re-review (N1(a)) filled pages with tiny `Y.Map` entries: 480k entries fit in 4 MB of updates,
inside the 5 MB page cap of a 20 MB workspace, and hold ~210 MB of heap. Memory follows Yjs structs (one
Item or GC each), not bytes. Measured with `node --expose-gc` (heap after applying the stored state):

| document | structs | stored (V2) | heap |
|---|---|---|---|
| API.md + CHANGELOG.md + OPERATIONS.md as one page (560 KB of Markdown) | 69k | 1.4 MB | 28 MB |
| the same three times (1.7 MB of Markdown) | 207k | 4.1 MB | 87 MB |
| 400 sections, each a paragraph, a 6-row table and a list | 94k | 2.1 MB | 46 MB |
| one table, 1000 rows × 10 columns | 91k | 1.4 MB | 44 MB |
| 20 people × 5000 single-character edits at random places | 91k | 1.3 MB | 23 MB |
| canvas, 3000 nodes + 3000 edges, every node moved 5 times | 21k | 0.4 MB | 7 MB |
| 100k tiny map entries | 100k | 0.8 MB | 43 MB |

Handwriting is not in the document (`page_ink`). Ordinary pages cost 250–520 bytes of heap per struct and
~15–20 stored bytes per struct; tiny map entries ~8. So the amplification of the attack over ordinary
content is about 2×, and an ordinary page at the 5 MB cap holds ~100 MB of heap by itself.

## Decision
- With `LIMIT_WORKSPACE_STORAGE_MB` or `LIMIT_INSTANCE_STORAGE_MB` set, an update is refused before it is
  applied when the page's live structs (plus the bytes it holds back for missing structs) plus the
  update's struct bound plus the bounds of admitted-but-unsettled updates pass `DOC_STRUCTS_CAP` = 300,000:
  above every ordinary page measured (207k for 4.1 MB of Markdown, near the demo's 5 MB page cap).
- The bound is read from the update's bytes without decoding it (`collabUpdateShape.ts`: one pass over
  the V1 format skipping every value by its length; no string decoded, no object made; an unreadable
  update counts its byte length, which is still an upper bound because every struct takes its info byte):
  structs + one split per Item placed next to an existing one + two per delete range. The live count is
  `Σ store.clients[i].length` (O(clients)), re-read on the next event-loop turn after each admitted update.
- The refusal uses the existing path (ADR 2530): not applied, connection read-only, `{t:'storage'}`, close
  4000, the page authorises read-only for 10 minutes. Unlike a byte refusal, a recount of the workspace
  does not clear it (bytes say nothing about structs; the provider would resend the refused update and loop).
- No setting: nothing is scanned or counted.

## Consequences
- Production build, `--max-old-space-size=320`: the review's script (one socket, four pages) is refused
  on the first page and the server stays up (RSS 166 → 441 MB). A variant with one socket and one
  keep-alive socket per page fills three pages to 240k structs each and runs the heap out of memory
  (RSS peak 470 MB): a per-page cap cannot bound what many pages hold, and three ordinary pages near the
  page cap would do the same. Only the container limits contain that; the demo's heap is sized for far
  less than a workspace's worth of large open pages.
- Not added: a per-workspace or per-process struct budget. Per workspace, one account owns two
  workspaces; per process, any member could make every page on the server read-only.
