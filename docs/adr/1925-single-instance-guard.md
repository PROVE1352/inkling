# 1925. Single-instance guard at boot

- Status: Accepted
- Date: 2026-11-10

## Context
Inkling runs as one process per database: live documents, debounced stores, queued index passes and
the outbox consumer live in its memory. A second process on the same database (a second container,
a stray `node dist/index.js`) stores whole document states over the first one's. Only the README
said so.

## Decision
- At boot, before migrations, the server takes a session-level advisory lock (two-int key space,
  `('INKL', 1)`) on a dedicated connection that never recycles, and holds it until exit; it releases
  it last at shutdown, after the documents are flushed.
- Busy: it logs who holds it (pid, application name, client address, since) and waits
  `SINGLE_INSTANCE_WAIT` seconds (default 60, longer than the 30 s stop grace period of a replaced
  container), polling once a second. Still busy: it refuses to boot with that message and exits 1.
- Every 30 s the connection checks it still holds the lock. After a database restart it takes it
  again; if another process got it first, this process shuts down.
- `SINGLE_INSTANCE=0` turns the guard off for a deliberate extra process; a warning is logged.
- `docker compose up -d` stops the old container before starting the new one, so a normal deploy
  takes the lock at once; an overlapping replacement waits.
- Tests never run `index.ts`, so parallel test processes on one database are unaffected.

## Alternatives considered
- **A lock row with a heartbeat**: needs expiry rules; the advisory lock ends with the session.
- **`pg_advisory_lock` (blocking)**: runs into the pool's statement and lock timeouts, and cannot log
  the holder while it waits.

## References
- apps/server/src/instanceLock.ts, apps/server/src/index.ts, compose.yaml, .env.example
- apps/server/src/instanceLock.db.test.ts
