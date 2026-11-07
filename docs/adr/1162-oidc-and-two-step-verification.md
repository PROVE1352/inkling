# 1162. OIDC accounts and two-step verification: the provider's second factor, optionally proven by amr/acr

- Status: Accepted
- Date: 2026-11-07

## Context
docs/adr/1112-* lets a workspace require two-step verification and counts delegated sign-in
accounts as satisfying it, because their second factor belongs to the upstream service and they
cannot turn on Inkling's TOTP. Accounts created by an OpenID Connect sign-in (docs/adr/1161-*) are
in the same position: they have no Inkling password, and turning on TOTP needs one
(docs/adr/1061-*). A linked local account still has its password and may have TOTP on.

Providers can say how the person signed in: `amr` (RFC 8176 method values such as `pwd`, `otp`,
`hwk`, `mfa`) and `acr` (a level the provider defines). Support differs between providers and
their settings (Keycloak sends `acr` and needs a mapper for `amr`; Google's id_token has neither),
so Inkling cannot count on them by default.

## Decision
- **Accounts created by OIDC satisfy a workspace 2FA requirement**, like delegated accounts:
  `userSatisfiesSql` accepts `origin IN ('delegated', 'oidc')`, and the "members without 2FA" list
  leaves them out. Blocking them would lock them out with no way back (same reasoning as 1112).
  The provider's sign-in policy decides how strong that second factor is, so the requirement is
  only as strong as the provider's. The workspace setting's description says this for delegated and
  single sign-on accounts.
- **`OIDC_REQUIRE_MFA=1` makes the provider prove it.** Every OIDC sign-in (and every link from
  Settings) is refused with `OIDC_MFA_REQUIRED` unless the id_token shows a second factor: an
  `amr` entry among `mfa`, `mca`, `otp`, `hwk`, `swk`, `sms`, `tel`, `sc`, `fpt`, `face`, `iris`,
  `retina`, `vbm` (`pwd`, `kba` and `pin` alone are not enough), or an `acr` listed in
  `OIDC_ACR_VALUES`. `OIDC_ACR_VALUES` is also sent as `acr_values`, so the provider can step up
  instead of failing. The check is per sign-in, so it holds for the whole session that sign-in
  creates. Off by default: with Google it would refuse everyone.
- **A linked local account keeps Inkling's second step.** After the provider, an account with TOTP
  on gets the usual challenge (`createLoginChallenge`, 5 minutes, five tries) instead of a session.
  The challenge travels in the URL fragment of `/login#totp=…` (not sent to any server, not in a
  `Referer`); the login page reads it and removes it from the address bar. Without this, connecting
  a provider would turn a password + TOTP account into a provider-only one.
- **Local accounts are not counted as satisfied by an OIDC sign-in.** The requirement is a property
  of the account, checked by one SQL predicate everywhere (1112); the way a particular session was
  created is not visible there. A local account satisfies it with Inkling TOTP as before.
- **Settings**: the two-step section shows "uses the second step of <OIDC_NAME>" for OIDC-created
  accounts and no buttons, the same as for delegated accounts.

## Alternatives considered
- OIDC accounts never satisfy the requirement, and get a way to turn on Inkling TOTP without a
  password (confirming with a sign-in at the provider less than ten minutes ago). Stricter, but a
  second password-less confirmation path through every 2FA route and screen, and people would type
  two codes when the provider already asks for one. Can be added later behind a setting.
- Recording `amr`/`acr` per session and checking it in the workspace predicate: the predicate only
  sees the user id, and changing every membership check to look at the session is a large change
  for little gain over refusing the sign-in.
- Trusting `amr` without a setting: providers that send nothing would be treated as password-only
  and locked out of every 2FA workspace.

## Consequences
- With `OIDC_REQUIRE_MFA=0`, a workspace 2FA requirement trusts the provider's own policy for
  OIDC-created accounts. Operators of Google Workspace should enforce 2-Step Verification there.
- Tests: `oidc.test.ts` ([db] `OIDC_REQUIRE_MFA` refusal and acceptance, TOTP step after the
  provider for a linked account, `userSatisfiesTwoFactor` for an OIDC account; amr/acr helper).
