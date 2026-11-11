# 2545. Small files and search indexes count toward storage; the fuse counts disk blocks

- Status: Accepted
- Date: 2026-11-12

## Context
The second security review of 0.22 (N2, N3) found two ways around the storage limits a demo relies on.

- N2: a workspace counted `files.size`, and the instance fuse summed apparent sizes. 2,000 one-byte uploads
  were 2,000 bytes to both, while the disk held 8 MB in 2,001 inodes. An empty upload is taken too. Within a
  3,000 MB fuse that is about 15 million files. The fuse also walked DATA_DIR on the request that found the
  last measurement stale, so with many files a write waited for the walk.
- N3: the search and section indexes (`page_texts`, `page_chunks` and the other tables rebuilt from the
  bodies) were not counted. 21 appends of 1 MB of random words, 22 MB counted, grew the database by 432 MB
  (`page_chunks` alone 341 MB). The 0.22.0 preset (100 workspaces of 20 MB, fuse 3,000 MB) did not fit
  even with ordinary use.

## Decision
These rules apply only on a server with `LIMIT_WORKSPACE_STORAGE_MB` (or, for the fuse, with
`LIMIT_INSTANCE_STORAGE_MB`). A server with neither counts exactly as in 0.22.0.

- **Files**: an upload counts `max(size, 4096) + 1024` bytes (`quota/room.ts fileStorageBytes`,
  `fileStorageSql`). The recount, the upload's reservation and the usage route all use it. The importers
  reserve 5 KB more per attachment as an upper bound, and the recount corrects that. Empty uploads stay
  allowed on every server; they are no longer free. On 4 KB blocks the disk a workspace's files take stays
  under about 1.6 × its limit: a file of 4,097 bytes counts 5,121 and takes 8,192. One-byte files take
  4,096 of every 5,120 counted. The files are bounded at limit / 5 KB, and so are their inodes.
- **Fuse**: every file and folder under DATA_DIR counts `max(size, st_blocks × 512)`. The walk runs 64
  `lstat` calls at a time. Once there is a first measurement, a stale one is answered at once and measured
  again in the background; only the first answer after boot (or after the limit changes) waits.
- **Indexes**: the recount adds the rows of `page_texts`, `page_chunks`, `page_chunk_vectors`, `page_tasks`,
  `page_links`, `page_tags` and `page_former_titles` (`pg_column_size` of each row). The index pass runs
  8–30 s after a body is stored. So the store (`noteBodyStore`, the one point every body store passes)
  reserves `INDEX_BYTES_PER_BODY_BYTE` (3) per byte the body grew. Measured with 1 MB appends, the index rows
  are 2.2 per body byte on prose-like text and 2.3 on random words, and the change log keeps a copy of the
  new text (about 1). A recount 40 s after a body grew (`recountAfterIndex`, one pending per workspace) puts
  the real number in. Paths that create pages with bodies (import, duplicate, templates, clipping) schedule
  the same recount.
- Not counted: Postgres index entries (GIN, trigram) and dead rows. The fuse and the demo's own filesystem
  bound those.

## Measured (production build, demo preset, local Docker, 2 GB APFS disk image as DEMO_VOLUME_ROOT)
- One-byte uploads into a 10 MB workspace: 2,047 taken plus one empty, then `LIMIT_STORAGE`. That is exactly
  10 MB / 5 KB = 2,048 files. On disk: 8,188 KB of 4 KB blocks and 2,048 inodes. The database grew 0.5 MB.
  At 20 MB: 4,096 files, 16 MB on disk.
- The review's appends (1 MB of random words; the review's own run: 21 into 20 MB, database +432 MB):
  - Into 10 MB: 4 taken, then `LIMIT_STORAGE`. Counted 13.7 MB after the recount; the database grew 36.5 MB.
  - With an estimate of 2 (tried first): 5 taken, counted 17.7 MB, database +72.8 MB.
  - At 20 MB with 3: 7 taken, counted 23.0 MB, database +142.7 MB. Of that, `page_chunks` was 121 MB:
    1.2 MB of heap, 59 MB of TOAST and 61 MB of GIN indexes, while its rows counted 15.5 MB.
- Prose-like text (a 2,000-word vocabulary drawn by rank) into 10 MB: 4 taken. Counted 13.4 MB; the database
  grew 12.6 MB (14.9 MB in the run with 2).
- A body write is checked against "full", not against its size, so one write still passes at the limit. The
  count can end above the limit by about one write's body, index and change-log copy (here about 3.5 MB).
- The walk of 100,000 one-byte files on APFS took 341–350 ms and saw 412.8 MB. The 0.22.0 walk took 882 ms
  and saw 100,000 B.

So one 10 MB workspace can grow the database by about 1.3–1.5 × its limit with prose and about 3.7–7.3 × with
random text written on purpose (dead rows and GIN entries, which the count leaves out). The demo preset is
now 10 MB per workspace, and 100 workspaces full of prose come to about 1.5 GB, under the 3,000 MB fuse. A few
accounts writing random text can still trip the fuse. That stops only the demo, and the demo's filesystem
bounds the disk (ADR 2546).

## Consequences
- A workspace near its limit on a server with a limit can become read-only when it upgrades, because the
  indexes now count. Without a limit nothing changes.
- The store-time estimate can overshoot for up to 40 s (on prose at 20 MB, 24.2 MB was estimated and 19.4 MB
  recounted), so for that time a workspace near its limit can refuse a write it has room for.
- Overshoot past the limit is bounded by the writes accepted before the recount lands, at most about 30 s
  of index passes.
