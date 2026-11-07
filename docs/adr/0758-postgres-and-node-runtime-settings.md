# 0758. Postgres and Node runtime settings in compose

- Status: Accepted
- Date: 2026-11-07

## Context
The db service ran stock Postgres settings inside `mem_limit: 512m`; the app had `mem_limit: 768m` but no V8 heap cap, so a heap spike was ended by the cgroup OOM killer instead of the GC. The reference deployment is a 4-core / 24 GB ARM VM shared with other services.

## Decision
- db `command:` passes `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `random_page_cost` (1.1, SSD), `effective_io_concurrency`, `track_io_timing`, `shared_preload_libraries` (empty by default; set `pg_stat_statements` to opt in), each overridable from `.env` (`PG_*`). Defaults are small and safe for the existing 512 MB limit; `mem_limit` and `shm_size` are env-tunable too. The recommended A1 values are in `docs/OPERATIONS.md`.
- app: `NODE_OPTIONS` defaults to `--max-old-space-size=512` (~65% of the 768 MB limit; off-heap Buffers/Yjs and code make up the rest); `APP_MEM_LIMIT` env.
- Password hashing (`@node-rs/argon2` `hash`/`verify`) is already asynchronous on the libuv pool: 8 concurrent hashes → 50 ms wall, event-loop delay max 2 ms (the sync variant blocks the loop for the whole 126 ms). The pool (4 threads) is shared with fs and zlib; `UV_THREADPOOL_SIZE=8` is an option if logins coincide with heavy uploads.
- Large JSON responses measured: tree 5.7 MB, collection 4.6 MB, graph 2.5 MB, due 1.7 MB. `JSON.stringify` of the 4.6 MB collection takes 2.6 ms; the DB query 26 ms — serialisation is not the bottleneck, so no schema-based serializer was added (ADR 0752 covers avoiding the work via 304).
