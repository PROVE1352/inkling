# 2584. The two-step code backoff has a map of its own, chosen by the code

- Status: Accepted
- Date: 2026-11-27

## Context
guard.ts keeps per-account failure counters in one in-memory map capped at 20,000 keys; past the cap
the oldest tenth is dropped. The two-step code counters (`totp:<email>`) lived in the same map as the
sign-in counters, and anyone can add sign-in keys by failing with made-up names. Someone who knows a
victim's password and holds enough addresses could push the victim's two-step backoff out and guess
codes at full speed again (0.25.3 review A-F5).

The fix proposed with the reproduction chose the map by the key's `totp:` prefix. A sign-in name is any
string of three or more characters (`loginSchema`), so a name typed as `totp:…` would still land in the
second-factor map: made-up `totp:` names could evict entries there, and typing someone's `totp:<email>`
at the sign-in form would hold back their second factor.

## Decision
- Second-factor counters live in `secondFactorFails`, swept and capped like the others.
- The map is chosen by the code, never by the key: `recordFailure` uses it for the reasons `totp`,
  `2fa-code` and `2fa-setup`; `assertAccount` and `recordSuccess` take `{ secondFactor: true }`. The
  callers in routes/auth.ts and routes/twoFactor.ts pass it; the key itself (`totpAccountKey`) is unchanged.

## Consequences
- Only an account whose password was right, or a signed-in person, adds keys to the second-factor map,
  so filling it takes that many accounts.
- A sign-in name that starts with `totp:` is an ordinary sign-in key.
- Counters are still in memory and reset on restart (KNOWN-ISSUES, TODO #5).
