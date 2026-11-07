# 0100. One-time password reset codes, hashed and consumed atomically

- Status: Accepted
- Date: 2026-11-07

## Context
Admins need to hand a user a way back into their account without knowing the new password, and verified users should get the same thing by mail. The code must be usable once, expire, be bound to one account, and must not be recoverable from a DB dump.

## Decision
- Code = 16 chars from the existing signup-key alphabet (`XXXX-XXXX-XXXX-XXXX`, ~79 bits), normalized to upper case.
- Store only `sha256(code)` in `password_reset_codes(code_hash PK, user_id, expires_at, created_by)`. TTL 24h.
- Issuing a code deletes that user's previous codes (only the latest is valid).
- Redeem with a single `DELETE … WHERE code_hash = $h AND user_id = $u AND expires_at > now() RETURNING` — check and consume in one statement, so two concurrent redeems cannot both succeed.
- On success: set password, delete all sessions, delete remaining codes, resolve pending reset requests (one transaction).
- Admin issuance also deletes the target's sessions immediately.

## Alternatives considered
- argon2/bcrypt hash of the code: slow hash is pointless for 79-bit random secrets and prevents indexed lookup.
- `SELECT` then `UPDATE used_at`: race window; needs row lock or serializable tx.
- Signed stateless token (HMAC/JWT): cannot be revoked individually, and "latest wins" needs state anyway.

## Trade-offs
- A fast hash means a DB leak + offline brute force is bounded only by code entropy (~79 bits — acceptable).
- Rows are deleted on use, so there is no audit trail of redeemed codes.

## How others solve it
OWASP Forgot Password Cheat Sheet recommends random single-use tokens, stored hashed, with short expiry and invalidation after use — this follows it.

## Consequences
- The plaintext exists only in the admin response / outgoing mail. Re-mailing a code (`send-credential`) requires the admin to send the plaintext back; the server re-verifies it against the hash before mailing.
- OAuth/MCP grants are not revoked on reset (sessions only).

## References
- apps/server/src/accounts.ts:117 (`issueResetCode`), :155 (`consumeResetCode`), :83 (`setPassword`)
- apps/server/src/db/schema.ts:76 (`passwordResetCodes`)
- apps/server/src/routes/auth.ts:444 (`/auth/reset-password`)
- apps/server/src/routes/admin.ts:319, :328 (`send-credential` re-verification)
- apps/server/drizzle/0022_accounts_security.sql
