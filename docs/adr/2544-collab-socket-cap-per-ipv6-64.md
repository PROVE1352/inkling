# 2544. The collab socket cap and byte bucket count an IPv6 /64 as one address

- Status: Accepted
- Date: 2026-11-12

## Context
`collab.ts` caps sockets per client address (`MAX_CONN_PER_IP` = 40, every server since before 0.21.1)
and, with a storage limit or the fuse, shares a byte bucket per address (ADR 2530). Both were keyed by
the full address, so an IPv6 client rotating through its /64 got 40 sockets and a fresh bucket per
address (0.22.0 re-review, N1). The global request limit already counts a /64 (ADR 2537).

## Decision
Both keys are `ipPrefixKey(ip, 64)`: an IPv6 /64 is one address, IPv4 (and IPv4-mapped IPv6) is the
address as before. The socket cap is on every server, so its key change is too. The upgrade-attempt
throttle (30 per 10 s) stays per full address: it only slows authentication floods.

## Consequences
- Everyone behind one IPv6 /64 shares 40 collab sockets, as everyone behind one IPv4 NAT always has. The
  web app opens one socket per tab (ADR 0702; a second one only briefly when the same page is reopened
  within 3 s), so a /64 holds about 40 tabs. A larger office on one /64 would see 429 on the upgrade past
  that: raise `MAX_CONN_PER_IP` if it happens.
