# 0101. A signup key works as a recovery code only if it was single-use

- Status: Accepted
- Date: 2026-11-07

## Context
Users who forget their password on a small self-hosted instance often still have the signup key they were given. Letting them reuse it avoids an admin round-trip. But keys can be shared (`max_uses > 1`), e.g. one key for a study group; anyone holding such a key must not be able to reset another member's password.

## Decision
`/auth/reset-password` accepts the signup key as the code only when all hold:
1. it equals `users.signup_key` of that account (constant-time compare),
2. the `signup_keys` row still exists and has `max_uses = 1`.
Revoked keys (row deleted) are rejected because `max_uses` cannot be proven. `users.signup_key` is now recorded only when the key was actually validated and consumed at registration.

## Alternatives considered
- Never accept signup keys: safest, but loses the zero-admin recovery path the operator wanted.
- Accept any key the user registered with: a shared key becomes a master key for every account created with it.
- Consume the key on use (one recovery only): stricter, but users would then need an admin anyway next time.

## Trade-offs
A single-use signup key becomes a permanent, non-expiring recovery secret for that account. Whoever holds the original invite message can reset the password. Operators who do not want this should revoke keys after signup (the account stays).

## Consequences
- Previously `signup_key` was stored even when key checking was off; now only consumed keys are stored, so the field is trustworthy as a recovery binding.
- Admin user list exposes `signupKeyRecovery` so the operator can see who has this path.

## References
- apps/server/src/routes/auth.ts:444-480 (reset route, `maxUses === 1` at :470)
- apps/server/src/routes/auth.ts:232 (`signupKey` stored only when consumed)
- apps/server/src/routes/admin.ts (`GET /admin/users`, `signupKeyRecovery`)
