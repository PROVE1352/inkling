# 1231. Restart count from a boot log, error count from the logger

- Status: Accepted
- Date: 2026-11-08

## Context
The status summary (docs/adr/1230-*) should say whether the app restarted recently, whether it died
rather than shut down, and whether it has been logging errors. The process cannot ask Docker (no
socket, docs/adr/0605-*), and Docker's restart count is not visible inside the container.

## Decision
- **Boot log**: `DATA_DIR/status/boots.json` keeps the last 50 boots. At boot (`index.ts`, right
  after DATA_DIR is prepared) a record `{ at, prev }` is appended, where `prev` is how the previous
  process ended: `clean` (the graceful shutdown wrote an exit record with code 0), `error` (exit
  record with a non-zero code, e.g. after an uncaughtException), `unknown` (no exit record newer
  than the last boot: SIGKILL, OOM kill, power loss, watchdog), or `first`. The graceful shutdown
  writes `{ exit: { at, code } }` synchronously right before `process.exit`. Writes go through a
  temporary file and a rename. Any failure only turns the item `off`.
- Restarts in 24 h = boots in the window that are not `first`; unclean = `error` + `unknown`.
- **Errors**: pino's `hooks.logMethod` (the Fastify logger options in `index.ts`) calls
  `noteLoggedError()` for every record at level ≥ 50. Child loggers (`req.log`) inherit the hook.
  Only timestamps are kept (at most 2,000), never the message; counts for 24 h and 1 h are computed
  on request.

## Alternatives considered
- **A database table**: needs a migration, and the most interesting boots (database down, crash
  loop before migrations) cannot write to it.
- **The backup control volume** (`app-info.json` lives there): it exists only with the sidecar.
- **Docker's `RestartCount`**: needs the Docker socket in the app (root on the host).
- **Wrapping `app.log`**: misses child loggers; the pino hook sees every record.
- **Counting 500 responses instead of log records**: misses background failures (outbox, reminders,
  unhandled rejections), which are logged at level 50.

## Trade-offs
- Deploys count as restarts (a clean one); three deploys in a day give a warning that says so.
- The file is part of the data volume and therefore of backups; it holds only timestamps and exit
  codes. A restored copy may show old boots for at most a day.
- `console.error` before the logger exists (boot failures) is not counted; those boots show up as
  unclean restarts instead.

## References
- apps/server/src/status/runtime.ts, apps/server/src/index.ts (`recordBoot`, `recordExit`, `hooks.logMethod`)
- Tests: apps/server/src/status/evaluate.test.ts ("boot log and error counter")
