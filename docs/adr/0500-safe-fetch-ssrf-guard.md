# 0500. safeFetch: one SSRF-guarded entry point for server-side fetches of user URLs

- Status: Accepted
- Date: 2026-11-07

## Context
Link previews, workspace webhooks and (planned) import-by-URL make the server request URLs chosen by users. Without a guard, a user can make the server talk to `127.0.0.1`, the cloud metadata service (`169.254.169.254`), the Postgres container on the Docker bridge, or anything else on the private network (SSRF). Naive checks are routinely bypassed with decimal/octal/hex IP notation (`2130706433`, `0x7f.1`), IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), DNS names that resolve to private addresses, DNS rebinding (first answer public, second private), and redirects to internal hosts.

## Decision
All such fetches go through `apps/server/src/safeFetch.ts`:
- Scheme allowlist: https only; http is opt-in per caller (`allowHttp`). No credentials in URLs. Port allowlist (default 80/443).
- Optional host allowlist (exact or `*.suffix`) and path-prefix allowlist, checked on every hop.
- URLs are parsed with WHATWG `URL`, which normalises every IPv4 spelling to dotted-quad before checks.
- The hostname is resolved once with `dns.lookup({ all: true })`; if ANY answer is non-public the request is refused. Blocked: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; `::/96` (incl. `::1`, v4-compatible), `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2001:db8::/32`, 6to4 `2002::/16`, ULA `fc00::/7`, link-local `fe80::/10`, `fec0::/10`, multicast `ff00::/8`. Embedded IPv4 (mapped, compatible, NAT64, 6to4) is also checked against the v4 list.
- The socket is pinned to the validated IP with a custom `lookup` passed to `http(s).request` (SNI and certificate verification still use the hostname). After connecting, the remote address is compared again.
- Redirects are followed manually (default max 3), each hop fully re-validated. Requests with a body never follow redirects.
- Connect timeout (3 s) + total deadline (8 s), streaming size cap (truncate or fail), `Accept-Encoding: identity` (no decompression bombs), optional content-type allowlist.
- A test-only flag (`unsafeAllowLoopbackForTests`) admits loopback only, and is ignored when `NODE_ENV=production`.

## Alternatives considered
- `fetch()` + pre-check of `dns.lookup`: TOCTOU — undici resolves again, so DNS rebinding wins.
- `ssrf-req-filter` / `request-filtering-agent` packages: same idea, but adding dependencies is not allowed in this change and they do not cover the redirect/size/content-type policy.
- An egress proxy (e.g. Smokescreen): strongest isolation but needs extra infrastructure for a self-hosted single-container app.

## Trade-offs
- Hosts with mixed public/private answers are refused even if the public one would work.
- `node:http(s)` instead of undici fetch: slightly more code, but full control over lookup and streaming.
- IPv4 is preferred when both families resolve.

## How others solve it
Stripe's Smokescreen (egress proxy with IP denylist), GitLab's `UrlBlocker` (resolve, validate, then connect to the validated IP), Mastodon's `Request` with a private-address check in its connection factory, and OWASP's SSRF cheat sheet all use "resolve → validate every address → connect to that address → re-validate redirects".

## Consequences
- New features that fetch user URLs must import `safeFetch` (link preview, webhooks, sheets sync, …).
- 77 unit tests: `apps/server/src/safeFetch.test.ts` (`npx tsx --test src/safeFetch.test.ts`).

## References
- apps/server/src/safeFetch.ts:115 (v4 list), :136 (v6 list), :186 (embedded IPv4), :243 (validateUrl), :300 (resolvePublic), :330 (pinned lookup), :472 (safeFetch)
- apps/server/src/safeFetch.test.ts
