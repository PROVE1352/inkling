# 0103. Brute-force guard: escalating IP bans, account backoff (no lockout), trusted-proxy IPs, IPv6 /64

- Status: Accepted
- Date: 2026-11-07

## Context
The site is public. `@fastify/rate-limit` only caps request rate; it does not distinguish failures and resets every minute, so slow guessing (password, reset code, signup key, verification token, OAuth codes, public share tokens) is unbounded. Account lockout lets anyone lock out a victim. Client IPs come through a reverse proxy, so `X-Forwarded-For` handling decides whether bans are spoofable.

## Decision
- Count **failures** per IP key in a sliding 15-minute window; at 10, ban the IP. Ban length escalates 15m → 1h → 6h → 24h (cap); escalation level decays 7 days after the last ban. All values are env-tunable (`AUTH_GUARD_*`).
- Per-account failures are counted too, but accounts are never locked: above 5 failures, the next attempt on that account must wait 1s, 2s, 4s … (max 5 min). Success clears IP and account counters.
- Banned IPs are rejected in an `onRequest` hook on auth/token surfaces only (login, register, reset, forgot, verify, OAuth token/register/authorize, public share), before any argon2 work. Normal logged-in API traffic from the same IP is not blocked.
- 429 + `Retry-After`, same code/message as the rate-limit plugin.
- IP key: IPv4 as-is, IPv4-mapped IPv6 → IPv4, IPv6 → /64 prefix.
- Fastify `trustProxy` = `TRUST_PROXY` (default `loopback,uniquelocal`), replacing the previous "trust 1 hop from anyone".
- State: in-memory maps (20k entry cap, LRU-style eviction, 5-min sweeper); bans persisted to `ip_bans` and reloaded at boot. `ALLOWLIST_IPS` (env) is never banned. Admin UI lists/lifts/adds bans and refuses to ban the admin's current IP.

## Alternatives considered
- Account lockout: trivial DoS against any known email.
- Rate-limit plugin only: no failure semantics, no escalation, no persistence.
- Redis/DB counters: survives restarts and scales horizontally, but this is a single-container app; only bans need persistence.
- `TRUST_PROXY=loopback` only (as originally requested): when the app runs in Docker behind a host Caddy, the container sees the bridge gateway (172.x), not 127.0.0.1; XFF would be ignored and every client would share one IP, so one attacker could ban everyone. `uniquelocal` covers the bridge; direct internet connections keep their real public source IP (DNAT) and are not trusted. Host-network deployments can set `TRUST_PROXY=loopback`.

## Trade-offs
- Counters reset on restart (bans do not).
- A successful login resets the IP counter, so an attacker with one valid account can interleave logins; the per-account backoff still applies to the targeted account.
- Users behind one NAT share a ban. `forgot-password` counts every submission, so >10 requests in 15 min from one IP bans it.
- Trusting private ranges means a host on the same private network could spoof XFF; acceptable for the documented topology, configurable otherwise.

## How others solve it
NIST SP 800-63B §5.2.2 recommends rate limiting failed attempts rather than permanent lockout; fail2ban-style escalating IP bans are the common self-hosting pattern.

## References
- apps/server/src/guard.ts:28 (ladder), :64 (`ipKey`), :143 (`initGuard`), :187 (`assertAccount`), :199 (`recordFailure`), :224 (`banIp`), :281/:288 (guarded paths, hook)
- apps/server/src/index.ts:71 (`trustProxy`), :123 (hook)
- apps/server/src/env.ts:81 (`TRUST_PROXY` default)
- apps/server/src/db/schema.ts:146 (`ipBans`)
- apps/server/src/routes/admin.ts:435, :447 (admin ban endpoints)
