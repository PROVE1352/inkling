# 2512. Sign-in IDs: stored in the email column, chosen by the server's mode

- Status: Accepted
- Date: 2026-11-12

## Context
A demo server lets strangers sign up without giving an email address (LOGIN_ID_MODE=username). The
sign-up schema required `email`; sign-in, uniqueness, admin screens and every place that shows a
person read `users.email`. A new column would touch all of them, and an ID can never collide with an
email because it has no '@'.

## Decision
- An ID is 3–30 characters of `[a-z0-9._-]`, starting with a letter or digit, stored lower-cased in
  `users.email`; reserved names (admin, root, system, support, inkling, owner, operator, moderator,
  staff, help, null, undefined, and names the app or mail use for themselves) are refused
  (`account/loginId.ts`). 400 `LOGIN_ID_INVALID`, 409 `LOGIN_ID_TAKEN` where email mode says `EMAIL_TAKEN`.
- The route picks the schema by mode: ID mode takes `loginId` and refuses `email` (alone or together,
  400); email mode keeps the 0.21.1 schema, where a stray `loginId` is ignored as unknown keys always
  were (the foundation's tests send one and expect a sign-up).
- Sign-in lower-cases the input and compares it with the column, as before. In ID mode an unknown ID
  spends one argon2 check against a throwaway hash, so it answers in the same time and with the same
  body as a wrong password. Email mode keeps its 0.21.1 timing.
- Screens: "ID" and "Nickname" labels, the note "do not put your real name, an email address or a
  phone number in your ID or nickname", and no "email" wording wherever an identifier is shown
  (sign-in, Settings › Account, Admin › Users, member and access search, inklingctl's prompt and its
  "Name (id)" line). Places that show the value without a label keep showing it.

## Consequences
- The boot check (ADR 2500) keeps delegated sign-in, OIDC, mail and password reset off in ID mode, so
  the "input without '@' is a delegated ID" rule of `/auth/forgot-password` never meets an ID account.
- Sign-up still answers `LOGIN_ID_TAKEN` for a taken ID: that disclosure is inherent in choosing IDs.
