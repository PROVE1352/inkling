# 2502. Request gates: one check list for every authenticated request

- Status: Accepted
- Date: 2026-11-12

## Context
Consent to the current terms (LEGAL_DIR) has to stop a person from using the app until they agree, on
every way in: the browser session, personal API tokens, MCP connections, the collaboration socket. Each
of those turns a credential into a user in a different place, and later features may want the same kind
of check.

## Decision
- `apps/server/src/requestGates.ts`: `registerRequestGate(name, fn)` (returns its unregister function).
  A gate gets `{ user, req, via, channel }` and passes by returning or refuses by throwing an `AppError`.
- Where gates run:
  - `auth.ts authenticate()`: every REST route behind `requireUser`/`requireAdmin`, cookie and bearer
    alike, which includes the REST calls MCP tools make through `app.inject` and automation runs
    (`channel: 'http'`).
  - The `/mcp` handler, once the token is known (`channel: 'mcp'`): `initialize` and `tools/list` never
    reach REST.
  - Hocuspocus `onAuthenticate`, for every document and the inbox channel (`channel: 'collab'`, `req`
    null).
- Exempt REST routes are a constant of the module (`GATE_EXEMPT_ROUTES`, method + Fastify route pattern),
  not an argument of each gate: sign-out, `GET /api/auth/me`, everything under `/api/legal` (documents and
  the consent submission), `DELETE /api/me`, `GET /api/me/delete-preview`. A person a gate refuses can
  still see who they are, read the documents, consent, sign out and delete the account.
- No gate registered: one Map size test per request, nothing else.

## Consequences
- Routes with their own authentication do not run gates: public share links and forms, iCal feeds, the
  OAuth endpoints, sign-in/sign-up, password reset, `POST /auth/verify-email/send` (looks up the cookie
  itself), and the OIDC link flow (`routes/oidc.ts`, also reads the cookie itself).
- A collaboration socket that is already open is not re-checked; a gate that changes its mind for a
  person must also close their connections (`closeUserConnections`).
