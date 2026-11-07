# 1112. A workspace can require two-step verification

- Status: Accepted
- Date: 2026-11-07

## Context
docs/adr/1061-* added TOTP per account and left a workspace policy out of scope. A team that
invites outsiders wants every member's account to need more than a password, and has no way to
see or enforce that.

## Decision
- **Setting**: `workspaces.two_factor_required_at` (null = off; set to now when turned on) and
  `two_factor_grace_days` (0–30, default 7). Switched by owners **and admins** (it only tightens
  access; same group that manages members and links) with `PUT /workspaces/:id/settings/two-factor
  { required, graceDays? }`, browser sessions only. `GET /workspaces/:id/settings` returns
  `twoFactor` (managers also get the members without 2FA, first 50).
- **Preconditions to turn it on**: `APP_SECRET_KEY` set (members must be able to comply; else 501
  `TWO_FACTOR_UNAVAILABLE`) and the caller satisfies it (else 403 `TWO_FACTOR_SELF_REQUIRED`), so
  nobody locks out a workspace they cannot get back into.
- **Grace**: runs workspace-wide from `two_factor_required_at`; changing only the days keeps that
  start (shortening can end it at once). Members who join later get no fresh grace period: they
  see the setup screen at once. During grace the workspace list says `state: 'grace'` and the web
  shows a banner; nothing is refused.
- **Enforcement**: one SQL predicate (`twoFactorBlockedSql`) folded into the existing statements of
  the two choke points: `requireMembership` / `requireMembershipAcl` (every `/workspaces/:id/*`,
  page, file and MCP-reached route) and `findVisiblePage`, plus the collaboration upgrade
  (`onAuthenticate`). Blocked → 403 `TWO_FACTOR_REQUIRED` with `workspaceId` (the socket closes).
  When the requirement is off the predicate reads one workspace row by key. `findVisiblePage` now
  throws instead of returning null for a blocked page; its callers are single-workspace requests. Turning it on with no
  grace closes the blocked members' live sockets at once.
- **Satisfies it**: TOTP on (`user_totp.enabled_at`), or a **delegated sign-in account** (it cannot
  turn on Inkling 2FA; its second factor is the upstream service's, as 1061 says). Blocking them
  would lock them out with no way back.
- **Agents (OAuth MCP)** follow the token owner's state: MCP requests reach REST as that user, so the
  same choke points apply with no extra code. A grant made before the owner turned 2FA on keeps
  working once the owner turns it on (the grant was consented in a signed-in browser session); a
  token whose owner lacks 2FA is refused like the owner. This keeps one rule ("whose access is
  it?") and stops a 2FA-less account from keeping full access through an agent.
- **Not workspace-scoped, never blocked**: the workspace list (shows the blocked workspace with
  `state: 'blocked'`), `/auth/*` including the 2FA setup routes, account settings. The web replaces
  the workspace with a setup screen that embeds the regular 2FA setup and reopens the workspace
  after it.
- **Cross-workspace feeds**: the notification list and the iCal feed leave out a workspace that
  blocks the user. Mail digests, the agent inbox without `workspaceId`, and outgoing webhooks are
  not filtered (KNOWN-ISSUES).
- **Audit**: `settings.updated` with `{twoFactorRequired}` / `{twoFactorGraceDays}` before/after.
- **Lockout**: an owner whose 2FA is turned off (by themselves, or by an instance admin after a
  lost phone, 1061) is blocked like anyone else and recovers by turning 2FA on again in account
  settings. No owner exemption: it would be exactly the stolen-password hole the policy closes.

## Consequences
- One extra correlated `EXISTS` per membership check and page lookup (primary-key reads).
- An open socket is not cut when the grace period runs out by itself, only at its next reconnect
  (KNOWN-ISSUES).
- Tests: `secretsAtRest.db.test.ts` (require two-step verification).
