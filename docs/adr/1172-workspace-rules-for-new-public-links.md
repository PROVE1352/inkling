# 1172. Workspace rules for new public links: default expiry, password required

- Status: Accepted
- Date: 2026-11-07

## Context
Expiry (docs/adr/1170-*) and passwords (docs/adr/1171-*) are per link and optional. A team that
publishes often wants links to expire unless someone decides otherwise, and some teams (client work,
HR, schools) want no page on the open web without a password. The only workspace switch so far was
"no public links at all" (docs/adr/0949-*).

## Decision
- Two owner settings in Workspace settings → Public links, through the existing
  `PATCH /workspaces/:id/settings` (strict schema, `settings.updated` audit with before/after):
  - `share_default_expiry_days integer` (1–365, null = none; the UI offers none, 1, 7, 30, 90):
    applied by the server when a new link is made without an explicit expiry. The share dialog
    pre-selects it; the publisher may still choose another expiry or none. A default, not a maximum.
  - `share_password_required boolean` (default false): `POST /pages/:id/share` without a password
    answers 403 `SHARE_PASSWORD_POLICY` for a page that has no link yet, and
    `PATCH … { password: null }` answers the same. Changing a password is allowed.
- Both are read in the publishing transaction from the workspace row taken `FOR SHARE`, the same
  lock "no public links" already uses, so a concurrent settings change waits or wins.
- `GET /pages/:id/share` returns `policy { defaultExpiryDays, passwordRequired }` so the dialog can
  show the rule before publishing.
- **Not retroactive**: existing links keep their expiry and work without a password. This matches
  docs/adr/0949-*: changing a setting should not silently break links that are already in people's
  hands. Owners see every link and its badges in "Web shares" and can add passwords or remove links.

## Alternatives considered
- **Maximum expiry** ("no link longer than N days"): stricter, but forces a choice on every
  re-publication and needs a rule for existing longer links; can be added later on the same column
  pair.
- **Apply "password required" to existing links** (close them until a password is set): would make
  every current link answer 401 with no password anyone knows; same reasoning as 0949.
- **Minimum password strength**: per-link throttling (1171) is the protection; a strength rule adds
  friction for short-lived links without changing the guessing budget much.

## Consequences
- Two columns on `workspaces`; `policyColumns` and `WorkspaceSettingsDTO` grow by two fields.
- Tests: `shareLinks.db.test.ts` (workspace rules).
