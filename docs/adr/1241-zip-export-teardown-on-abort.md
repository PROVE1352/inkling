# 1241. A zip export closes its entry streams when the download is aborted

- Status: Accepted
- Date: 2026-11-08

## Context
KNOWN-ISSUES B-M1 said the zip export opened a read stream per attachment up front and leaked
them when the client aborted. The first half was already fixed by `lazyFileStream` (docs/adr/0751-*):
an entry's file is opened only when JSZip starts reading it, and one entry is read at a time. The
second half was not:

- Fastify destroys a stream payload when the response closes early (`reply.js` `sendStream`
  calls `payload.destroy()`).
- The payload is JSZip's `NodejsStreamOutputAdapter`, a readable-stream 2.x `Readable`. Its
  `destroy()` runs the default `_destroy` and emits no `'close'`; nothing reaches JSZip's worker
  chain or the entry streams. The entry being read stays paused with its file descriptor open,
  and the export's cleanup (temp dir of spilled pages) was bound to `'end' / 'error' / 'close'`,
  so it depended on whether `'end'` happened to follow.
- With the heavy-job cap (docs/adr/1240-*) the export's slot is released by the same teardown;
  a teardown that never runs would hold a slot forever.

## Decision
- `exportZip` keeps every entry stream it creates in a set (removed on its own `'close'`).
- One idempotent teardown runs on `'end'`, `'error'`, `'close'` and from an overridden `_destroy`
  of the output stream: pause JSZip's helper, destroy every remaining entry stream (closing the
  open fd), remove the temp dir, call `onFinish` (the slot release).
- `exportZip` calls `onFinish` as well when it throws before returning a stream (guards, render
  errors), so the route never has to.
- The routes also destroy the zip when the response closes before it finished
  (`destroyWithResponse`): fastify's own destroy runs only once it is sending the stream, and a
  client can leave while the pages are still being rendered. A client that leaves while still
  queued for a heavy-job slot leaves the queue (499, docs/adr/1240-*) and no export runs.

## Alternatives considered
- **Wrap the adapter in a PassThrough with `stream.pipeline`:** pipeline destroys the adapter on
  error but the adapter's destroy still does not reach the entries; the set is needed anyway.
- **Generate the zip into a temp file and send it with `createReadStream`:** a clean abort for
  free, but doubles disk use and delays the first byte until the whole archive exists.
- **Replace JSZip's streaming with our own zip writer:** larger change, a new code path for a
  format we only write here; not needed for the leak.

## Trade-offs
- `_destroy` and `_helper` are internals of readable-stream 2.x / JSZip 3.10. A JSZip upgrade must
  re-run `md/exportZip.db.test.ts`, which fails if the teardown stops running.

## Consequences
- Measured (scripts/heavy-jobs-bench.ts, docs/PERFORMANCE.md): 20 downloads dropped after 4 MiB
  (inside an attachment) left 18 more open fds without the hook (31 → 49, 3 of 3 runs) and none
  with it (31 → 29), with no temp dir and no running slot left. A full export's time is unchanged
  (median 523–526 ms for 24.9 MiB).
- Tests: `md/exportZip.db.test.ts` — five downloads aborted mid-stream over a real socket leave no
  extra fd, temp dir or running slot; a client that leaves while queued starts no export;
  destroying the stream mid-entry closes the open entry and calls `onFinish` once; a full download
  still produces every entry. Against the code without the hook the abort tests fail (3 fds left
  after five aborts; the open entry stays open after destroy).
