# 2516. Sign-up limits: an account cap, a per-address cap and two bot checks

- Status: Accepted
- Date: 2026-11-12

## Context
A public demo server needs a ceiling on accounts and on accounts per address, without an outside
service, and a server without these settings must sign up exactly as 0.21.1.

## Decision
- One sign-up hook (`account/signupGuards.ts`); each part is a no-op while its setting is unset.
- SIGNUP_MAX_USERS: a cheap refusal before anything is spent, then a recount inside the account's
  transaction under its own advisory lock (taken after the admin lock when both are held), so
  concurrent sign-ups never pass the cap. The setup-code first admin is exempt. 403 `SIGNUP_FULL`;
  `/auth/mode` says `signupFull` and the form shows a notice instead.
- SIGNUP_PER_IP_PER_DAY: `signup_events` rows (IPv4, or the IPv6 /64 as the sign-in guard keys it),
  counted over 24 hours under a per-address lock, written only while the setting is on. 429
  `SIGNUP_IP_LIMIT`. The address is `req.ip`: X-Forwarded-For counts only from TRUST_PROXY addresses
  (default loopback and private ranges, which covers Caddy on the same host and the Docker network).
  With TRUST_PROXY off the server warns at boot; a sign-up from a private address is logged once.
- Bot checks, only while one of the two caps is set (`/auth/mode` `signupChecks`): a hidden `website`
  field must be empty and the form must have been on screen for two seconds (`formMs`). A failure is
  400 `SIGNUP_CHECK_FAILED`, not a fake success: a person whose browser filled the field sees what to do.
- Retention: `signup_events` after 30 days; `ip_bans` rows whose ban ended more than 30 days ago (an
  active ban is never touched).

## Consequences
- `formMs` is the client's word. The checks stop scripts that fill every field or post at once; the
  caps are what bound the damage.
