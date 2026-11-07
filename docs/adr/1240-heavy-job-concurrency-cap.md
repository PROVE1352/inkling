# 1240. Heavy jobs share a small concurrency cap with a fair queue

- Status: Accepted
- Date: 2026-11-08

## Context
KNOWN-ISSUES B-M9: folder imports, zip / Markdown / Notion imports, zip exports and subtree
duplicates each hold tens of MB in Node (an upload of up to `IMPORT_MAX_UPLOAD_MB` plus JSZip's
state, rendered pages, page rows of a copy). Nothing limited how many ran at once, so a few
people (or one agent loop) starting several together could push the 768 MB app container into the
OOM killer, which takes the editor and every socket with it. Rate limits (20/min per IP) bound
the rate, not the overlap.

## Decision
- `src/heavyJobs.ts`: one process-wide gate. `acquire(userId, kind, signal)` resolves with an
  idempotent release function; `run()` wraps a job. Limits from the environment:
  `HEAVY_JOBS_MAX` (running at once, default 2), `HEAVY_JOBS_QUEUE_MAX` (waiting, default 16),
  `HEAVY_JOBS_WAIT_MS` (longest wait, default 60 000), `HEAVY_JOBS_PER_USER` (running + waiting
  per person, default 2).
- Refusals are ordinary `AppError`s with `Retry-After` (already sent by the error handler):
  `503 HEAVY_JOBS_BUSY` when the queue is full or no slot came within the wait, `429
  HEAVY_JOBS_PER_USER` at once for a person over their share. MCP tools get a next-step hint for
  both (`mcpTools/core.ts`).
- Fairness: a free slot goes to the waiter whose person has the fewest running jobs, then whose
  person was granted a slot longest ago, then the oldest request. One person's batch of exports
  cannot starve another person's single import. A waiter whose client disconnects
  (`clientGoneSignal(reply.raw)`) leaves the queue without running; it is answered with 499
  `CLIENT_CLOSED_REQUEST` (nobody reads it) so that it is not logged as a server error.
- Where the slot is taken:
  - zip export (page subtree and whole workspace): before rendering, released by the zip
    stream's teardown (end, error or destroy; docs/adr/1241-*), so the slot covers rendering and
    deflating. The workspace export takes it before writing its audit event, so a refused export
    is not logged as downloaded.
  - `/workspaces/:id/import` (Markdown, zip, Notion zip): the upload is first spooled to a private
    temp file (`streamToFile`, same as folder import), then read into memory inside the slot. A
    slow or queued upload holds neither a slot nor a buffer.
  - `/workspaces/:id/import-folder`: parts are spooled as before; `importEntries` runs in a slot.
  - `/pages/:id/duplicate`: after the visibility and membership checks, around the copy.
- `heavyJobStatus()` (running / queued per kind, oldest ages, limits, refusal counters since
  start) is exported for the admin server status; this ADR adds no route.

## Alternatives considered
- **One slot (`max = 1`).** Lowest peak (8 imports: +74–80 MB against +104–142 MB with 2), but
  every job waits behind a 25 MB export and a burst takes about 1.6× as long as with 2 slots
  (6.2–6.5 s against 3.9–4.0 s). Two slots keep the peak at about two jobs' worth. Operators on
  smaller containers, or with raised `IMPORT_MAX_*` caps, set `HEAVY_JOBS_MAX=1`.
- **Memory-based admission** (refuse while `rss` is above a threshold): RSS lags allocation and
  GC timing makes it noisy; a count is predictable and testable.
- **A worker thread or child process per job:** isolates crashes but needs the database pool,
  BlockNote's server editor and the importers in each worker; out of scope for a cap.
- **Global FIFO without per-user fairness:** simpler, but one person can fill the queue.
- **Holding the export slot only while rendering:** the stream phase is small with streamed
  entries, but deflate buffers and the open entries scale with concurrent downloads; holding it
  to the end keeps the bound true. The cost is that a very slow download keeps a slot; the wait
  bound turns that into 503 + Retry-After for others instead of memory growth.

## Trade-offs
- Per process: two app instances would allow twice the jobs (one instance is the supported
  deployment, OPERATIONS.md §3).
- Under contention imports and exports take longer (they wait) instead of running side by side.
- Template import (`/workspaces/:id/templates/import`, up to 25 MB) and pages-from-template are
  not gated yet (KNOWN-ISSUES).
- A job that hangs keeps its slot until the request ends; the socket and database timeouts bound
  that.

## Consequences
- Measured (scripts/heavy-jobs-bench.ts, docs/PERFORMANCE.md, 3 runs each): 8 concurrent ≈ 20 MiB
  zip imports raised RSS by 198–206 MB uncapped, 104–142 MB with 2 slots and 74–80 MB with 1; the
  burst took 2.4–3.0 s, 3.9–4.0 s and 6.2–6.5 s. With 4 imports 2 slots made no measurable
  difference (82–94 vs 82–89 MB); exports stream and stay at +2–33 MB either way. The cap bounds
  the growth with the number of concurrent jobs rather than shaving a small burst.
- Tests: `heavyJobs.test.ts` (cap, fairness order, 429, 503 on full queue and on timeout,
  abandoned waiters, release on throw, status), `md/exportZip.db.test.ts` (503 + Retry-After and
  429 through the routes, an upload waits after spooling and then imports).
