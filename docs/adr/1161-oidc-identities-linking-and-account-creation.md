# 1161. OIDC identities: keyed by (issuer, subject); email linking only when verified and allowed; no signup key

- Status: Accepted
- Date: 2026-11-07

## Context
docs/adr/1160-* gets a verified id_token to Inkling. Which Inkling account it opens is the part
that decides whether someone can take over an account. Existing accounts are found by email, and an
email from a provider is not always proof of anything: some providers let users type any address
(Keycloak with self-registration, Entra ID's mutable `email` claim, the "nOAuth" pattern), others
say whether they checked it (`email_verified`), Entra ID does not send that claim at all.

## Decision
- **Identity = (`iss`, `sub`)** in `user_identities` (primary key), never the email. One identity
  belongs to one account; an account has at most one identity per issuer (unique index). The email
  in the row is what the provider said at the last sign-in, for display; it never changes
  `users.email` (that could collide with another account or move a person's address under them).
- **Order on sign-in** (`routes/oidc.ts resolveAccount`):
  1. identity known → its account;
  2. an account with the id_token's email exists → linked **only if** `OIDC_LINK_EXISTING=1` (the
     operator allows it), the id_token says `email_verified: true`, the account is a local one and
     not an instance admin. Otherwise refused with `OIDC_EMAIL_TAKEN` ("sign in with your password,
     then connect in Settings"). When linked this way, the account's email counts as verified;
  3. no such account → created only if `OIDC_AUTO_CREATE=1`, with origin `'oidc'`, a random password
     hash (no password sign-in, like delegated accounts), the provider's email, and its own
     workspace like a normal signup. Otherwise `OIDC_NO_ACCOUNT`.
- **Connect from Settings** (`POST /api/auth/oidc/link`): a signed-in local account links the
  provider by signing in there (`prompt=login`). The pending row records the account; the callback
  links only when the same account is still signed in in that browser (`OIDC_LINK_SESSION`
  otherwise). This needs no email match: the person proved both sides. This is the safe default
  path for existing accounts; email linking is the convenience the operator opts into.
- **Admins are never linked by email**: one wrong or compromised provider account would otherwise
  become an instance admin. An admin connects from Settings.
- **`OIDC_ALLOWED_DOMAINS`**: when set, every sign-in and link needs an email in one of the domains
  and `email_verified: true` (an unverified address says nothing about the domain). Unset = any
  account the provider issues; for a single-tenant provider the tenant is already the boundary.
- **`OIDC_TRUST_EMAIL=1`** treats the email as verified when the provider does not send
  `email_verified` (Entra ID single-tenant, where administrators set addresses). It applies to
  account creation and to the domain check, **not** to email linking: linking keeps requiring the
  claim, because a wrong link hands over an existing account with its pages.
- **Signup keys**: an OIDC sign-in never asks for one, and `SIGNUP_REQUIRE_KEY` does not apply to it.
  The gate for new accounts is `OIDC_AUTO_CREATE` together with the provider and
  `OIDC_ALLOWED_DOMAINS`. With auto-create off, new people come in by an invitation to a local
  account (signup key) and connect it, or an operator turns auto-create on for a while.
  Boot warns when auto-create is on without allowed domains.
- **Password and account paths for origin `'oidc'`**: password sign-in fails like a wrong password
  and the typed password is not passed on to delegated sign-in; reset, change and email verification
  are refused like for delegated accounts; the web hides the password fields with the same rule.
  The first account on an empty instance becomes admin, as with any signup (`promoteIfNoAdmin`).
- **No disconnect** in this version: an account created by the provider would be left without any
  way in. A wrong link is removed by an administrator in the database
  (`DELETE FROM user_identities WHERE user_id = …`).

## Alternatives considered
- Matching by email always (common in small apps): account takeover whenever a provider lets
  someone claim an address they do not own.
- Never linking existing accounts: forces every existing user to start over or to have an admin
  move their pages.
- Requiring a signup key on the first OIDC sign-in (key typed before the redirect, stored with the
  pending sign-in): keeps one gate for every new account, but defeats the point for a team whose
  provider already decides who belongs. Left out; `OIDC_AUTO_CREATE=0` covers the strict case.
- Taking the email from UserInfo when the id_token has none: one more request and the same trust
  question. Google, Keycloak and Authentik put `email` in the id_token for the `email` scope; Entra
  ID needs the optional `email` claim turned on in the app registration. This change was tested
  against a local test provider only, not against those services.

## Consequences
- Moving to another provider (new issuer) does not move identities: people connect again from
  Settings, or with email linking on, the next sign-in links by verified email. Rows of the old
  issuer stay and are shown with the issuer's host.
- Tests: `oidc.test.ts` ([db] creation and second sign-in by subject, email linking refused without
  the setting, without `email_verified`, under `OIDC_TRUST_EMAIL` and for admins, domain refusal,
  connect from Settings incl. a different session and an identity already linked elsewhere).
