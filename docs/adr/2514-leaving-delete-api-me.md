# 2514. Leaving: DELETE /api/me with a password or a recent sign-in

- Status: Accepted
- Date: 2026-11-12

## Context
0.22 lets everyone delete their own account on every server. The deletion is immediate (ADR 2517), so
the request must come from the person, not from a stolen token or an unattended browser.

## Decision
- Browser sessions only (bearer tokens 403). `confirm` must equal the sign-in email or ID (case
  ignored, 400 `CONFIRM_MISMATCH`).
- Local accounts send the current password, and the 2FA code when it is on; a wrong password or code
  counts against the sign-in guard (IP ban and account backoff, the login's account key).
- Delegated and OIDC accounts have no password here: the session must be younger than ten minutes
  (`sessions.created_at`, never moved by use), else 401 `REAUTH_REQUIRED`.
- The only admin cannot leave (409 `LAST_ADMIN`, re-checked under the admin lock).
- `GET /api/me/delete-preview` lists what goes (workspaces with page and file counts, private pages
  elsewhere), what stays (who takes over each sole-owned shared workspace) and what the request needs.
- Both are on the request gates' exception list, so a person who has not consented can still leave.

## Consequences
- Success clears the cookie; the web app wipes this device's offline copies and opens the sign-in
  screen with "Your account was deleted".
