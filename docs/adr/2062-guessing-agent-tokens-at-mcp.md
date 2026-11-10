# 2062. Guessing agent connection tokens at /mcp counts towards the IP ban

- Status: Accepted
- Date: 2026-11-10

## Context
Before 0.16 the `/mcp` 401 path had no failure counting: only the global request limit (300 per minute per IP,
`index.ts`) applied, and `/mcp` is not in the guard's `GUARDED` list. That was enough for OAuth access tokens
(256 random bits, one hour), and OAuth clients present an expired `ink_at_` token routinely before they refresh,
so counting those would ban people's own machines. Agent connection tokens (2060) live for up to a year and are
static, so a miss is worth counting, as for personal API tokens at REST (1201: banned IP refused before the
lookup, a miss counted).

## Decision
- A request at `/mcp` whose bearer starts with `ink_agt_` from a banned IP is answered **429 RATE_LIMITED**
  with `Retry-After` before any lookup (in `onRequest` for POST, in the handler for GET/DELETE).
- A 401 for an `ink_agt_` token calls `recordFailure(req, 'agent-token')` (10 in 15 minutes → ban, the guard's
  ladder), **unless the token exists and only expired**: a forgotten config is not an attack. Checking that is
  one indexed lookup on `access_hash`, done only on the failure path.
- Other bearer shapes at `/mcp` are not counted or refused (expired OAuth tokens, see Context). Brute force
  against them stays bounded by the global limit and 256-bit entropy.
- The global limiter keeps keying `/mcp` by IP (`rateLimitKey` gives only `ink_pat_` its own bucket): a
  per-token bucket would hand every guess a fresh budget.
- The 401 answer for an agent token says "Invalid, expired or revoked agent connection token"; the
  `WWW-Authenticate` header is unchanged.
- The token is never logged: Fastify's request log carries method, URL, host and address, never headers; the
  guard records the IP and the reason only.

## Alternatives considered
- **Count every bearer failure at `/mcp`**: bans clients doing a normal refresh.
- **Add `/mcp` to `GUARDED`**: refuses every MCP request from a banned IP, including OAuth connections of
  other people behind the same NAT, for failures they did not make.

## Consequences
- An app looping on a made-up or revoked agent token bans its IP for 15 minutes (and longer on repeat), which
  also refuses that IP's logins (guarded routes), as a looping script with a revoked API token does today.
