# 2527. Restricted sign-up waits for the setup-code administrator (SETUP_REQUIRED)

- Status: Accepted
- Date: 2026-11-12

## Context
On a server without an administrator, the first account to sign up becomes one (`promoteIfNoAdmin`, kept
for installs that open sign-up to their own team). A demo opens sign-up to strangers with no key, so until
the operator signed up, the first stranger would administer the server; the demo guide worked around it by
keeping `PUBLIC_URL` on localhost until the operator account existed.

## Decision
- "Restricted sign-up" = `SIGNUP_MAX_USERS`, `SIGNUP_PER_IP_PER_DAY` or `ACCOUNT_LIFETIME_DAYS` set, or
  `LOGIN_ID_MODE=username` (`restrictedSignup()`). With it and no administrator, `POST /auth/register`
  without the setup code answers 403 `SETUP_REQUIRED`.
- In the route, not in a sign-up hook: it sits beside the setup-code check, before the hooks, so nothing is
  spent (key, hash, IP record) and no other error (consent, bot check, cap) hides it. Checked again inside the
  account's transaction where the promotion would happen: restricted sign-up never promotes.
- The setup-code sign-up is unchanged: it is exempt from the caps and bot checks (ADR 2516) and still meets
  the consent check (ADR 2519). Once an administrator exists the condition is off. Without restricted sign-up
  the 0.21.1 rule stands (the first account becomes administrator).
- The web sign-up screen of a restricted server with `setupPending` shows only where the setup link is
  (derived from fields `/auth/mode` already sends: `loginId`, `signupChecks`, `accountLifetimeDays`).
- The demo guide's order no longer needs localhost: `PUBLIC_URL` is the public address from the start, the
  terms folder comes before the operator's sign-up, and the setup link opens at the public address.

## Consequences
- A restricted server whose accounts exist but none is an administrator (not reachable through the app)
  refuses every sign-up until an administrator is made by hand; the setup code closes once any account exists.
- Delegated sign-in and OIDC first logins still call `promoteIfNoAdmin`; restricted sign-up with OIDC on is a
  path to a first administrator outside this rule (ID mode refuses OIDC and delegated sign-in at boot).
