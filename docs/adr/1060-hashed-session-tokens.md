# 1060. Session tokens are stored as SHA-256, converted in place at boot

- Status: Accepted
- Date: 2026-11-07

## Context
`sessions.token` held the raw cookie value (C-L7). Anyone who read the database or a backup could
sign in as every user with a live session. OAuth codes and tokens, reset codes, email verification
tokens and iCal tokens were already stored as SHA-256; sessions were the exception.

## Decision
- **Stored form**: `sessions.token` keeps its name and type (text, primary key) and now holds
  `sha256(raw token)` as 64 lowercase hex characters. The raw token (32 random bytes, 43 base64url
  characters) exists only in the `inkling_sid` cookie. Keeping the column means no schema migration.
  The raw token is never 64 hex characters, so the two forms cannot be confused.
- **Lookup**: by the hash (`sessionTokens.ts`). An equality lookup on the SHA-256 of a 256-bit random
  value leaks nothing useful through timing, so no separate constant-time compare is needed.
- **Existing rows**: `hashLegacySessionTokens()` runs after the schema migrations and before the
  server listens: `UPDATE sessions SET token = encode(sha256(convert_to(token,'UTF8')),'hex') WHERE
  token !~ '^[0-9a-f]{64}$'`. It is idempotent. Nobody is signed out.
- **Late plaintext rows**: an older `deploy/cli-token.sh` inserts raw tokens directly. Such a row
  still matches once (the lookup also tries the raw value) and is rehashed in place on that first
  use. The raw-value lookup is skipped when the presented cookie itself looks like a hash, so a
  leaked hash cannot be replayed as a cookie.
- **Unchanged**: collaboration sockets and `liveConnections.keepSessionToken` compare raw tokens in
  memory; `setPassword(keepSessionToken)` hashes before comparing with the column.

## Consequences
- A database or backup leak no longer yields usable sessions.
- `deploy/cli-token.sh` must insert the hash and list/revoke by hash prefix (its own change).
- Tests: `authSecurity.test.ts` ([db] session tokens).
