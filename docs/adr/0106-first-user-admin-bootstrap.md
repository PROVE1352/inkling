# 0106. First-user admin bootstrap

- Status: Accepted
- Date: 2026-11-07

## Context
The first admin used to be set by a migration that hard-coded one person's email. A fresh public install needs an admin without editing SQL.

## Decision
After a successful register or login (local or delegated), if no user has `is_admin`, promote this user. A fast unlocked check skips the work once any admin exists; otherwise the update runs under the admin advisory lock with `NOT EXISTS (… is_admin)` so concurrent first logins promote exactly one.

## Alternatives considered
- Admin from env (`ADMIN_EMAIL`): explicit, but one more required setting and a race if that email is registered by someone else first.
- CLI-only bootstrap: safest, but adds a manual step to every install.

## Trade-offs
On an install where signup is open (no signup key required), whoever registers first becomes admin; the operator should register immediately after deploy (or require keys, in which case the first key is minted with `deploy/signup-key.sh`). Because the last admin cannot be deleted/demoted, the bootstrap only fires on empty installs.

## How others solve it
Gitea and Mattermost make the first registered user the administrator; this follows the same convention.

## References
- apps/server/src/accounts.ts:52 (`promoteIfNoAdmin`)
- apps/server/src/routes/auth.ts:268, :339, :392 (call sites)
- deploy/DEPLOY.md §3-C
