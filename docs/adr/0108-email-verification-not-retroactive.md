# 0108. Email verification without retroactive lockout

- Status: Accepted
- Date: 2026-11-07

## Context
Verified emails enable self-service reset (0102). Existing accounts never verified anything; enforcing verification on them would lock people out on upgrade.

## Decision
- `users.email_verified_at` (null = unverified) plus `users.must_verify_email` (default false). Existing rows get false.
- Tokens: 32 random bytes, stored as SHA-256 in `email_verifications`, 24h, single use (`DELETE … RETURNING`), and only valid if the account email still equals the email the token was sent to.
- When mail is enabled, a verification mail is sent after signup; resend from settings, from the blocked login screen (email+password), or by an admin; admins can also mark verified manually.
- `REQUIRE_EMAIL_VERIFICATION=1` (effective only when mail is enabled) sets `must_verify_email=true` for accounts created **while it is on**; those cannot log in until verified (403 `EMAIL_NOT_VERIFIED`, only after the password matched). Default 0 = banner only. Delegated accounts are out of scope.

## Alternatives considered
- Compare `created_at` with a cutoff date: fragile and implicit.
- Flag every account created after the migration: turning the setting on later would retroactively block people who signed up while it was off.

## Trade-offs
Turning `REQUIRE_EMAIL_VERIFICATION` on later does not affect accounts created before; operators wanting that must use the admin tools. One extra boolean column.

## References
- apps/server/src/db/schema.ts:50, :125
- apps/server/src/accounts.ts:31 (`verificationEnforced`), :187 (`consumeVerifyToken`)
- apps/server/src/routes/auth.ts:233, :140, :592
