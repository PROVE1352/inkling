# 2501. Sign-up hooks: checks before, records inside the account's transaction

- Status: Accepted
- Date: 2026-11-12

## Context
Restricted mode adds several things to `POST /api/auth/register`: an account cap, a per-IP cap, sign-in
IDs, consent checks and records, an expiry date, the sign-up IP, a hidden field against bots. Written
into the route, each would edit the same function body; some must refuse before anything is spent (the
signup key, the argon2 hash), some must write in the same transaction as the account (a consent record
without its account, or an account without its consent, must not exist). The expiry date must not be
set for admins, but the first account of a server became admin only after the transaction committed
(`promoteIfNoAdmin`, run on its own connection).

## Decision
- `apps/server/src/signupHooks.ts`: `registerSignupHook(name, { before?, on? })` returns its unregister
  function; names are unique. Hooks run in registration order.
- `before(ctx)` runs after the body is parsed and the setup code checked, before the signup key is
  consumed, the password hashed or anything written. Throwing an `AppError` refuses the sign-up.
- `on(tx, user, ctx)` runs inside the transaction that inserts the account, its personal workspace and
  its membership, after them. Throwing rolls everything back; the existing catch gives the signup key
  back. A unique violation thrown by a hook would read as `EMAIL_TAKEN`, so hooks must not rely on one.
- `ctx` = `{ rawBody, body, ip, locale, setupCode, req }`: the body as sent (fields the schema does not
  know included) and as parsed, `req.ip` (TRUST_PROXY decides whether X-Forwarded-For counts), the
  sign-up language, whether this is the first admin made with the setup code.
- `user` = `{ id, email, name, isAdmin, workspaceId }` with the final `isAdmin`: the first-admin promotion
  now happens inside the account's transaction (`promoteIfNoAdminInTx`: check for an admin, take the admin
  advisory lock only when there is none, conditional update), before the `on` hooks. Two first sign-ups
  racing serialize on the lock and the second sees the first one's admin. The old post-commit
  `promoteIfNoAdmin` call stays as a no-op safety net.
- The register schema names the extra fields as optional (`loginId`, `consents`, `legalVersion`, the
  hidden `website`) instead of passing unknown keys through.
- With no hook registered the route answers as 0.21.1 (same body keys, same admin rule, same cookie).

## Consequences
- Other account-creating paths (admin, delegated sign-in, OIDC, page guest invites, CLI, setup code is
  the route itself) do not run sign-up hooks; restricted mode handles those accounts after sign-in
  (request gates, ADR 2502).
- Two features registering hooks need one place that imports them at boot.
