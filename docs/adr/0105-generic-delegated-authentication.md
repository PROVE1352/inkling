# 0105. Generalize delegated login (external auth server) for the public codebase

- Status: Accepted
- Date: 2026-11-07

## Context
Delegated login was hard-wired to one private service (env name, UI labels, stored `origin` value, mirror email domain, and a migration with a personal email). The code is being published; the running instance must keep working.

## Decision
- Env: `DELEGATED_AUTH_URL` (no fallback to the old name), `DELEGATED_AUTH_NAME` (UI label, default "External account", exposed via `/auth/mode`), `DELEGATED_EMAIL_DOMAIN` (mirror domain, default `delegated.local`). Login matching uses the env domain, so an existing instance keeps its mirror accounts by setting the old domain.
- `users.origin` enum value renamed to `delegated`; migration 0022 rewrites any non-`local`/`delegated` value to `delegated`.
- Already-applied migrations 0016/0017 had their data-only UPDATE lines removed (drizzle decides by journal timestamp, so existing DBs do not re-run them; fresh installs have no rows to update).
- The external contract (`POST /api/auth/login {username,password}` → 200 `access_token` / 200 `totp_required` / 401 / 429 / other) is documented in DEPLOY.md; the access token is discarded.
- Delegated accounts are excluded from password reset/change/temp-password (400 `DELEGATED_ACCOUNT` on authenticated routes; the public reset route returns the generic failure).

## Alternatives considered
- Keep the old env name as fallback: smoother deploy, but leaves the private name in public code.
- Full OIDC: the standard answer, but the existing upstream does not speak OIDC.

## Trade-offs
Changing `DELEGATED_EMAIL_DOMAIN` after launch splits identities. Deploying without updating env silently disables delegated login and, since `SIGNUP_REQUIRE_KEY` was derived from the old URL, can make signup key-less — operators must set the new env (and ideally `SIGNUP_REQUIRE_KEY=1`) in the same deploy.

## References
- apps/server/src/env.ts:29, :37
- apps/server/src/routes/auth.ts:92 (`delegatedLogin`), :291 (login)
- apps/server/src/accounts.ts:25 (`DELEGATED_EMAIL_SUFFIX`)
- apps/server/drizzle/0022_accounts_security.sql (last statement), 0016/0017
- deploy/DEPLOY.md §3-D
