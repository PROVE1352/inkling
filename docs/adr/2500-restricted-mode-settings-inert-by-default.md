# 2500. Restricted mode: one settings module, every setting off unless set

- Status: Accepted
- Date: 2026-11-12

## Context
0.22 lets an operator limit what people can do on a server (accounts, workspaces, members, pages, file
size, storage, version history), turn features off, take sign-in IDs instead of emails, ask for consent
at sign-up, and delete accounts after a lifetime. Two kinds of servers use the same code: installs whose
operators set none of it (the release server among them, with real accounts), and a public demo server
that sets nearly all of it. The settings are read by many places (the routes that create things, the
sign-up route, housekeeping, the admin status page, the web app) and are built by several people at once.

## Decision
- **One module** `apps/server/src/limits.ts` reads every variable once at import, in the shape of
  `agentUploads.ts`: a pure `parseLimitsEnv(env)` (tests), the process's `limits` object, and
  `setLimitsForTests(partial)` that returns the function putting the old values back. Readers take the
  value at call time (`limits.x`, `isFeatureDisabled(name)`, `workspaceRestoreDays()`), never a copy made
  at import, so tests can change them.
- **Inert by default.** Unset or empty means "no limit" / off, and with nothing set the server answers as
  0.21.1. `GET /api/auth/mode` adds a field only for a setting that is on (not even a key with
  `undefined`); a test pins the 0.21.1 answer byte for byte. `GET /api/auth/me` adds `expiresAt` only for
  an account that has an expiry date. The admin status page adds an item only where it says something.
- **A value it cannot take as written refuses to boot**, with the variable and the reason: not a whole
  number, below 1, `LIMIT_FILE_MB` above 25 (it can only lower the browser cap), `LIMIT_VERSIONS_PER_PAGE`
  above 50 (it can only lower the version budget), an unknown name in `DISABLED_FEATURES`, an
  `INSTANCE_LABEL` over 20 characters or with a control character. Unlike `AGENT_UPLOADS` (ADR 2065), which
  falls back with a warning, these settings guard data and disk: a typo that silently lifted a limit, or
  silently kept a feature on, would be found by the people it was meant to stop.
- **Settings that contradict each other refuse to boot** too (`assertLimitsCompatible`, run first thing
  in `main`): `LOGIN_ID_MODE=username` needs delegated sign-in, OIDC and mail off and `password-reset` in
  `DISABLED_FEATURES` (an ID is no address, and "input without @ is a delegated ID" would read it as one).
- **Boot log**: one line for the limits that are on, one for the features that are off (values only),
  and with `ACCOUNT_LIFETIME_DAYS` one line saying how many existing accounts it leaves alone (those with
  no expiry date, counted after migrations).
- **Feature names** live in `packages/shared` (`DISABLED_FEATURE_NAMES`) so the server's check and the web
  app's menus use one list; the new error codes and their statuses too (`RESTRICTED_MODE_ERRORS`).
- **`WORKSPACE_RESTORE_DAYS`** replaces the fixed 30 days of workspace restore (ADR 0910). `/auth/mode`
  sends `workspaceRestoreDays` only when it is set, and the three sentences that said "30 days" take the
  number (30 when the server says nothing).
- **Schema** (migration 0062, additive only): `users.expires_at`, `user_consents`, `signup_events`, and the
  workspace storage cache `workspaces.storage_bytes` / `storage_checked_at` / `over_storage`.

## Consequences
- A server whose environment has none of these variables behaves and answers as 0.21.1; the inert tests
  (`authMode.db.test.ts`, `limits.test.ts`) fail if a field leaks.
- A misconfigured demo server does not start, and the log says which variable to fix.
- Enforcement is not in this module: each creating path checks the value it needs in its own transaction.
