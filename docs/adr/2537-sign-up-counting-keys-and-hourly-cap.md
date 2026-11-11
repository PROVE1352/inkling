# 2537. Sign-up counting keys, an hourly cap and limited taken-ID answers

- Status: Accepted
- Date: 2026-11-12

## Context
The security review filled `SIGNUP_MAX_USERS` cheaply: the per-IP sign-up count keyed IPv6 by its /64
(one /48 holds 65,536 of them), the global request limit keyed IPv6 by the full address, and the bot
check is a number the client sends. In ID mode an answer "this ID is taken" did not use the per-IP quota,
so IDs could be probed at the route's rate limit.

## Decision
- `ipPrefix.ts` (pure): IPv4 as is, IPv4-mapped IPv6 (dotted or hex) as IPv4, IPv6 as a prefix. The sign-up
  limits count a /56; the global request limit counts a /64 on every server (was the full address). The
  sign-in failure bans (`guard.ts ipKey`) are unchanged.
- `SIGNUP_PER_HOUR`: accounts the whole server makes in an hour, counted from `signup_events` under one
  advisory lock in the account's transaction (429 `SIGNUP_RATE_LIMIT`); the setup code is exempt. Its rows
  are recorded while it or `SIGNUP_PER_IP_PER_DAY` is set. It turns on the bot checks like the other caps.
- While `SIGNUP_PER_IP_PER_DAY` is set, a sign-up refused as taken (email or ID) is recorded as
  `taken:<key>` in `signup_events` (no new table): after 10 in 24 hours that address gets
  `SIGNUP_IP_LIMIT` before the account insert can answer. Ten leaves room for a person trying a few IDs;
  the taken records do not use the two sign-ups a day.

## Consequences
- Filling the account cap is slower, not prevented: one person with many /56s (or many networks) still
  takes places, at most `SIGNUP_PER_HOUR` an hour; the bot check remains a client-sent number.
- A network that shares one /56 (or one IPv4 address behind NAT) shares one sign-up count.
- Every server: IPv6 clients of one /64 now share the global request budget.
