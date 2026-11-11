# 2503. Restricted mode: each piece registers itself from its own register.ts

- Status: Accepted
- Date: 2026-11-12

## Context
Restricted mode is built in three pieces at once (limits and features turned off, accounts, terms and
consent). Each needs routes, sign-up hooks, request gates, fields in `GET /api/auth/mode` and
`GET /api/auth/me`, and hourly jobs. Done directly, all three would edit `index.ts`, `routes/auth.ts`,
`housekeeping.ts` and the test harnesses in the same places.

## Decision
- One file per piece: `quota/register.ts` (`registerQuota`), `account/register.ts` (`registerAccount`),
  `legal/register.ts` (`registerLegal`), each `(api: FastifyInstance) => Promise<void>`.
- `restricted.ts` `registerRestrictedMode(api)` calls them in that order. `index.ts` calls it inside the
  `/api` scope right after the auth routes; the test app builders (`mcpTools/testHarness.ts`
  `buildTestApp`, `routes/vaultSyncTestKit.ts` `buildSyncApp`) call it in their `/api` scope too.
- `restrictedExtras.ts` holds the shared registries: `registerAuthModeExtra(name, fn)` and
  `registerMeExtra(name, fn)` merge fields into `/auth/mode` and `/auth/me` (registration order, later
  wins on a key); `registerHousekeepingTask(name, fn)` runs after the existing hourly work, each failure
  one log line, the next job still runs (`runRegisteredHousekeepingTasks` for tests).
- As with sign-up hooks and request gates (ADR 2501, 2502): unique names (a duplicate throws instead of
  silently replacing), each registration returns its unregister function, and nothing registered means
  the routes and housekeeping behave as before.
- A piece's register function runs every time an app is built (a test process builds several), so it
  adds its routes to the `api` it gets each time but registers process-wide things (hooks, gates,
  extras, jobs) once, behind a module flag.

## Consequences
- The three pieces each edit their own directory; the shared files were edited once, by the foundation.
- The login, sign-up and second-step responses keep their short `user`; the web app refetches
  `/auth/me` after each, which carries the registered fields.
- Test files that build their own Fastify app (about forty) do not call `registerRestrictedMode`; a
  piece's own tests build apps that do.
