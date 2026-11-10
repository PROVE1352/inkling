# 2281. Metadata documents: fetched through safeFetch without redirects, 5 KiB, public clients only, cached 1 min–24 h

- Status: Accepted
- Date: 2026-11-10

## Context
draft-ietf-oauth-client-id-metadata-document-03 §3–§6 and §10 set the rules for the URL and the
document; several are SHOULDs with no numbers. The fetch is reachable by any signed-in member (the
consent info route needs a browser session), not by anonymous callers.

## Decision
- URL (`checkClientIdUrl`, on the raw string because `URL()` normalises): `https://` only, a host, no
  userinfo, a path other than `/`, no `.`/`..` segments (also `%2e`), no fragment (also an empty `#`),
  no spaces, ≤ 2,000 characters; a query is accepted (SHOULD NOT, not MUST NOT). Refused when its origin
  is this server's own (§10.1, and so that a public file on this server cannot pose as an app whose host
  is the server itself) or outside `OAUTH_CIMD_ALLOWED_HOSTS`.
- Fetch: `safeFetch` (ADR 0500: public addresses only, pinned DNS) with `maxRedirects: 0` — a 3xx is a
  refusal (§6 MUST NOT follow); `Accept: application/json`; 5 s deadline; 5 KiB cap (§10.11's
  recommendation; Claude's documents are ~350 bytes); 200 only; `application/json` or
  `application/<x>+json`.
- Document: `client_id` must equal the URL by simple string comparison; no `client_secret`,
  `client_secret_expires_at` or shared-secret method; not both `jwks` and `jwks_uri`;
  token endpoint authentication from `token_endpoint_auth_methods_supported`, else the singular
  property, else `none` (§5) — and it must include `none`. `private_key_jwt`-only documents are
  refused (`invalid_client`): v1 takes public clients with PKCE S256, which is what Claude's documents
  use and what the metadata already advertises. `grant_types`, when present, must include
  `authorization_code` and `response_types` `code`; `refresh_token` is not required (the MCP
  specification's own example lists only `authorization_code`; DCR clients get refresh tokens the same
  way). `redirect_uris` (1–20) keep only the entries `/oauth/register` would accept (https, or loopback
  http); none left is a refusal. `client_name` falls back to the host; `logo_uri` is ignored.
- `redirect_uri` matching is `redirectUriMatches`, the DCR rule: exact, except that a loopback http URI
  may use any port (§4.2, RFC 8252 §7.3; Claude Code registers port-less loopback URIs).
- Cache (`resolveCimdClient`, one process): fresh for Cache-Control `max-age` minus `Age`, clamped to
  [60 s, 24 h]; `no-store`/`no-cache` → 60 s; nothing → 5 min; `Expires` ignored (§6.2 allows it). LRU of
  500 URLs; one fetch per URL at a time. A valid document is kept up to 7 days past freshness and used
  when a re-fetch fails transiently (network, timeout, 429, 5xx) (§6.1). An invalid document or an
  error answer is never cached, and a terminal failure drops the cached copy at once.
- Rate limits instead of a negative cache: after a failed fetch the same URL is not fetched again for
  30 s, and all URLs together get 60 fetches a minute; over either, the stale copy is used if there is
  one, else a transient error. (§6.2 forbids caching error responses but allows rate limiting.)
- Errors: at the consent screen a terminal failure is 400 `INVALID_CLIENT` with the reason, a transient
  one 503 `CLIENT_METADATA_UNAVAILABLE` (Retry-After 60); neither redirects to the client (§6.1).
  At refresh: transient without a cached copy → 503 `temporarily_unavailable` (grant kept); a document
  that now names another `client_id` → the grant is deleted and `invalid_client` (§6.1 SHOULD); other
  terminal failures → `invalid_client`, grant kept (the person can disconnect it).
- The code exchange never fetches: the code was issued after a fetch, a transient failure must not burn
  a single-use code, and an anonymous caller must not be able to make the server fetch. It checks only
  that the switch is on and the URL still passes the allowlist. Refresh fetches only after the refresh
  token was found.
- Test mode: `OAUTH_CIMD_TEST_ALLOW_LOOPBACK=1` lets `http://127.0.0.1|localhost|[::1]` URLs through
  (safeFetch's `unsafeAllowLoopbackForTests`); ignored when `NODE_ENV=production` (§10.7).

## Alternatives considered
- Cache failures for a short time (the original plan): §6.2 "MUST NOT cache error responses"; the 30 s
  per-URL gap gives the same protection as a rate limit.
- Follow redirects and re-check each hop: §6 says MUST NOT follow.
- Accept `private_key_jwt` (Claude can present `…/confidential_client` with a signed assertion when
  the metadata lists it): needs JWT verification, `jwks_uri` fetching and key caching; later, if needed.
- A larger cap (tens of KB): §10.11 recommends 5 KB; inline `jwks` would be the only reason, and v1
  takes public clients only.

## Trade-offs
- A changed document takes effect after the cached copy expires (≤ 24 h; Claude's: 5 min).
- 60 fetches a minute is shared by everyone on the instance; a member opening many consent links with
  different URLs can delay others' first connection by up to a minute.

## Consequences
- `apps/server/src/oauthCimd.ts`; unit tests `oauthCimd.test.ts` (with Claude's published documents as
  fixtures), database tests `oauthCimd.db.test.ts`.
