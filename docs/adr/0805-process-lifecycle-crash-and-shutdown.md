# 0805. Process lifecycle: no crash on rejected promises, bounded graceful shutdown

- Status: Accepted
- Date: 2026-11-07
- Audit: B-H1, B-H2

## Decision
- Signal and error handlers are installed at module load, before `main()` runs. `unhandledRejection` is logged and the process continues; `uncaughtException` is logged and starts the graceful shutdown with exit code 1 (the restart policy brings it back).
- The collab store retries the `page_docs` write 3 times with exponential backoff (250/500/1000 ms) and then rethrows (it is not swallowed — the document stays dirty in memory and the next change stores again).
- The `/collab` upgrade handler is wrapped: failures (e.g. session lookup with the DB down) answer 503 and destroy the socket; upgrades during shutdown get 503.
- Shutdown: flag → `server.close()` (no new TCP) → Hocuspocus destroy + index flush (10 s cap) → `app.close()` (8 s cap) → `closeDb()`; a 25 s unref'd watchdog forces exit. compose `stop_grace_period: 30s`.

## Verification
Manual smoke script (kept outside the repo) against a real server: DB container stopped while a client edits → store retries logged, process alive, readiness 503, liveness 200, upgrade 503, API 500; DB restarted → readiness 200 and the edits typed during the outage are persisted; SIGTERM with a connected client exits in ~0.1 s with the last edit flushed.
