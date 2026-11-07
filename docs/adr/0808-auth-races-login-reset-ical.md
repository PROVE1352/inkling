# 0808. Login vs password reset, reset-code issue, iCal token

- Status: Accepted
- Date: 2026-11-07
- Audit: A-M3

## Decision
- Password login inserts its session with `INSERT … SELECT … FROM users WHERE id = $1 AND password_hash = $verified_hash`; a reset that committed during argon2 verification makes it insert nothing → 401.
- `issueResetCode` takes `pg_advisory_xact_lock(hashtext('reset-code:' || user))` around delete+insert: concurrent issues leave one valid code (test: 6 concurrent → 1 row).
- `setPassword` also deletes the user's iCal feed token (with sessions and OAuth grants).
