# 0807. Postgres timeouts per pooled connection, not per role

- Status: Accepted
- Date: 2026-11-07
- Audit: B-M4, C-H2

## Decision
The app pool sends `statement_timeout=15s`, `idle_in_transaction_session_timeout=60s`, `lock_timeout=10s` as startup parameters (postgres-js `connection`), `connect_timeout=10s`. Not `ALTER ROLE`: the backup sidecar's `pg_dump` uses the same role and must stay unlimited. The migration client sets `statement_timeout=0, lock_timeout=0`; long maintenance (housekeeping purge) uses `SET LOCAL statement_timeout = 0` (`relaxStatementTimeout`). The backup scripts export `PGOPTIONS='-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0'` in `deploy/backup/lib.sh`, so even a role-level setting cannot cut a dump — verified with `ALTER ROLE … SET statement_timeout='1ms'` on a 10k-row database: dump, verify and restore test succeed (and fail without PGOPTIONS).
