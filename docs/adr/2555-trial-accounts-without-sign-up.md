# 2555. Trial accounts without sign-up (TRIAL_ACCOUNTS)

- Status: Accepted
- Date: 2026-11-24

## Context
A public demo asks a visitor to make an ID and a password before they see anything. Many leave there. A
one-click account lowers that step, but it is also a new way for strangers to get an account: it must
not become an admin, a way to publish pages on the server's domain, a mail sender, or a way into other
people's workspaces, and it must go away on its own.

## Decision
- `TRIAL_ACCOUNTS=1` (off by default) with `TRIAL_LIFETIME_HOURS` (1–168, default 24),
  `TRIAL_MAX_ACCOUNTS` (default 30) and `TRIAL_PER_IP_PER_DAY` (default 3), read in `limits.ts`. The
  three numbers are checked even while the switch is off. The name is `TRIAL_*`, not `GUEST_*`: a guest
  is already someone a page is shared with (docs/adr/1250-*).
- `users.trial` (migration 0063, partial index on `expires_at` where `trial`). A trial account has the
  address `trial-<uuid>@trial.invalid` (RFC 2606 reserved domain) in every `LOGIN_ID_MODE`: a sign-in ID
  never contains `@`, so no chosen ID can equal it. Its password hash is of 32 random bytes nobody keeps.
  Sign-up refuses the domain (`EMAIL_RESERVED`), sign-in and reset refuse it, forgot-password does
  nothing for it, and `sendMail` sends nothing to it.
- `POST /api/auth/trial` (`account/trial.ts`): 404 while off; 409 `ALREADY_SIGNED_IN` when the browser has
  a valid session (a real session is never replaced); 403 `SETUP_REQUIRED` with no admin (checked again
  in the transaction; the first-admin promotion is never called); 403 `TRIAL_NEEDS_CONSENT` when
  `signup.json` has tick boxes; then the sign-up hooks with `ctx.trial`: the bot checks always, the
  per-address count apart from sign-up (`signup_events.ip = 'trial:<key>'`), `SIGNUP_PER_HOUR` shared,
  the server limits and the document version. SIGNUP_PER_HOUR counts trial rows apart from sign-ups,
  and trial workspaces are left out of LIMIT_WORKSPACES_TOTAL (bounded by TRIAL_MAX_ACCOUNTS, one each),
  so trials and real sign-ups never use up each other's room. A full server answers TRIAL_FULL before the
  password hash; the route's rate limit is keyed by the address only. One transaction holds an advisory lock, recounts trial
  accounts against `TRIAL_MAX_ACCOUNTS` (expired ones not yet deleted included) and makes the account,
  its workspace with the invite link off, and the membership. The sample page comes after the commit.
  Trial accounts do not count toward `SIGNUP_MAX_USERS`.
- A request gate refuses trial accounts the routes of `TRIAL_RESTRICTED_ROUTES` with 403
  `TRIAL_RESTRICTED`: joining (workspace code, page invitations), bringing people in (invite code,
  direct add, page access and guest invitations, ownership transfer, turning the invite link on),
  publishing (share links and charts on them, form links, the iCal feed), requests out (webhooks, Slack,
  Notion publishing), a second workspace, and the password, two-step setup and OIDC linking. The gate
  runs in `authenticate`, so cookie sessions, API tokens and the REST calls of MCP tools all pass it. It
  reads `users.trial` only on a listed route, so it costs nothing elsewhere and stays right after the
  switch is turned off. A test classifies every write route of the source as refused or allowed with a
  reason, so a new route fails until someone decides.
- Expiry: an hourly job deletes trial accounts whose `expires_at` passed, whatever `ACCOUNT_LIFETIME_DAYS`
  and its dry run say, also after the switch is off, through `deleteAccount(..., { by: 'self' })` (the
  `expiry` branch re-checks `ACCOUNT_LIFETIME_DAYS`). A click first deletes up to three expired ones.
  Two deletions of one account at once: the second finds no row and reports "not deleted". Past its
  `expires_at` the account's session, API tokens and MCP grants are refused at once (the three lookups
  check `trial` and `expires_at`). It can delete itself from its browser session with the confirmation
  alone.
- The web shows the button above the sign-in and sign-up forms, with the one-line agreement right under
  it when there is one (0.25.3; it was under the forms until then, where a visitor sent to the sign-up
  screen met the form first and on a phone had to scroll to it). "All trial seats are taken" stays under
  the forms. A click within 2 s of the screen appearing waits for the rest before sending. The sidebar shows "Trial account · deleted in N h".
  Refused actions show the server's error; buttons are not hidden in 0.23.

## Consequences
- A trial account cannot come back from another browser or after signing out, and cannot be turned into
  a normal account in 0.23; the person signs up anew.
- The bot check is a value the browser sends: a script passes it. The per-address count needs the real
  client address (`TRUST_PROXY`); behind a CDN or a proxy that does not pass `X-Forwarded-For` every
  visitor shares one count. A trial account can still make the server fetch an address it picks through
  the web clipper, Sheets sync and link previews (safeFetch, rate-limited per person or token).
- Deletion runs at most an hour late. An admin who lifts a trial account's expiry keeps it, with its
  restrictions, on a seat until it is deleted.
- Dynamic OAuth clients registered from a trial session are not removed with the account; the demo preset
  sets `OAUTH_UNUSED_CLIENT_*` for that.
- On a public server the per-address count needs `TRUST_PROXY`, as sign-up does.
