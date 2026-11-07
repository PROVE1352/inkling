# 1160. Sign-in with an OpenID Connect provider: Authorization Code + PKCE, built-ins only

- Status: Accepted
- Date: 2026-11-07

## Context
Teams that already run an identity provider (Google Workspace, Microsoft Entra ID, Keycloak,
Authentik) want their people to sign in with it instead of a separate Inkling password. Delegated
sign-in (`DELEGATED_AUTH_URL`) does not fit: it posts the password to a custom endpoint, so Inkling
sees the password and the provider's own second factor and policies are bypassed. OpenID Connect
keeps the password at the provider and is what all four of them speak.

## Decision
- **Configuration** (`env.ts` `oidc`): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, plus
  `OIDC_NAME` (button label), `OIDC_SCOPES` (default `openid email profile`), `OIDC_ID_TOKEN_ALG`
  (default `RS256`; `PS256`, `ES256`). On only when all three of issuer, id and secret are set. Boot
  refuses a half-filled set, a non-https issuer (http only for loopback) and a missing `PUBLIC_URL`/
  `APP_URL`: the redirect URI is `<PUBLIC_URL>/api/auth/oidc/callback`, never built from `Host`
  (docs/adr/0806-*). The secret is sent only to the token endpoint; no route, DTO or log line
  contains it. `/auth/mode` exposes `oidc: { name }` and nothing else of the configuration.
- **Flow**: `GET /api/auth/oidc/start?returnTo=` (a plain link on the login screen; a fetch could
  not follow the redirect into the provider) stores a pending sign-in and redirects with
  `response_type=code`, `state`, `nonce`, `code_challenge` (S256). `GET /api/auth/oidc/callback`
  exchanges the code at the token endpoint (`client_secret_basic`, or `client_secret_post` when the
  provider lists only that; 10-second timeout like delegated sign-in), verifies the id_token and
  issues the usual session (hashed, docs/adr/1060-*). Access and refresh tokens are discarded unread;
  Inkling does not call the provider after sign-in and has no UserInfo request.
- **Pending sign-ins** (`oidc_login_states`): keyed by SHA-256 of `state`, 10 minutes, single use
  (`DELETE … RETURNING`). The row also holds the nonce, the PKCE verifier, the sanitized `returnTo`
  and the SHA-256 of a random value set as the `inkling_oidc` cookie (httpOnly, `SameSite=Lax`,
  `Path=/api/auth/oidc`). The callback refuses a state whose browser value does not match. Without
  this, an attacker could start a sign-in, finish it at the provider as themselves and send the
  victim the callback URL (login CSRF). `Lax`, not `Strict`: the provider returns the browser with a
  cross-site top-level GET, which `Strict` leaves without the cookie. Expired rows are deleted when
  the next sign-in starts. A second sign-in started in another tab replaces the cookie, so the first
  tab's callback fails with `OIDC_STATE_INVALID` and has to start again.
- **Origin check** (docs/adr/1062-*): the callback is a GET from the provider and is not covered by
  it; state + browser binding + nonce + PKCE stand in for it. Starting a link to an existing account
  (docs/adr/1161-*) is a JSON `POST /api/auth/oidc/link`, so the Origin check does apply there.
- **Discovery**: `<issuer>/.well-known/openid-configuration`, fetched lazily (an outage of the
  provider must not stop Inkling from booting) and cached for an hour. Its `issuer` must equal
  `OIDC_ISSUER` byte for byte; the three endpoints must be https (http only on loopback). Plain
  `fetch` with `redirect: 'error'`, not the SSRF-filtering client: the provider is set by the
  operator and is often on a private network (Keycloak, Authentik).
- **id_token checks** (`oidc.ts verifyIdToken`), with `crypto.subtle` only:
  - compact JWS; header `alg` equal to the configured one (so `none`, `HS256` with the public key as
    secret and any algorithm the operator did not choose are refused before a key is looked up);
    no `crit`;
  - key from the JWKS by `kid` (without `kid`, only when exactly one usable key exists); `kty`, `crv`,
    `use` and `alg` of the key must fit. The JWKS is cached for an hour; an unknown `kid` refetches
    it at most once a minute (key rotation without letting forged tokens hammer the provider);
  - `iss` = issuer, `aud` contains the client id, `azp` = client id when present or when `aud` has
    several values, `exp` in the future and `iat` not in the future (60 s skew), `nonce` = stored
    one, `sub` present (at most 255 characters).
- **Redirects**: `returnTo` is reduced to a same-origin path (`safeReturnTo`, same rules as the web's
  `safeNext`, docs/adr/0851-*, plus no `/api/` targets); anything else becomes `/`. Every redirect
  Inkling sends is a relative path. Failures go to `/login?oidc_error=<CODE>` (or back to Settings
  for a link) with a fixed code; the provider's `error_description` is never shown or logged, only
  its standard `error` value is logged. `code` and `state` in request URLs are already masked in
  the request log (C-L8).
- **Rate limit**: 30 requests a minute per IP on start, link and callback (an office behind one NAT
  signs in at once). An unknown, expired or foreign state counts as an auth failure for the IP ban.
- **No new dependency** (docs/adr/0882-*): Node 22 has `fetch`, WebCrypto (RSASSA-PKCS1-v1_5,
  RSA-PSS, ECDSA P-256) and `base64url`. A JOSE library would add more code than the verification
  itself.

## Alternatives considered
- `openid-client` / `jose`: well tested, but a new dependency for about 300 lines that Node already
  covers, and the policy decisions (linking, 2FA) live in Inkling either way.
- Implicit or hybrid flow (`id_token` in the fragment): no client authentication, token in browser
  history. Authorization Code + PKCE is the current recommendation for confidential clients too.
- Keeping state in a signed cookie instead of a table: works without a database round trip, but
  needs a key (`APP_SECRET_KEY` is optional) and cannot be made single use.
- Several providers at once: one is enough for the teams asking; the identity table already keys on
  the issuer, so a list can come later without a migration.

## Consequences
- New tables `user_identities`, `oidc_login_states`; `users.origin` gains `'oidc'` (text column, no
  constraint change).
- Entra ID multi-tenant (`/common`, `/organizations`) issuers do not work: their discovery `issuer`
  is a template. Use the tenant-specific issuer.
- Tests: `oidc.test.ts` (helpers, id_token checks against a provider started in the test, [db] flow).
