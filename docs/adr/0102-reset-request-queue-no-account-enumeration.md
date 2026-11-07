# 0102. Password reset request queue without account enumeration

- Status: Accepted
- Date: 2026-11-07

## Context
Without mail, a user who forgot their password has no in-app way to ask for help. A "forgot password" form must not reveal whether an email is registered, and must not let anyone flood the admin queue or a user's inbox.

## Decision
- `POST /auth/forgot-password {email, note?}` always returns `{ok:true}`.
- Unknown email: nothing stored.
- Local account with verified email and SMTP enabled: a reset code is mailed automatically in the background (no queue), at most once per 5 minutes. Background send keeps response time independent of account existence. Sessions are not revoked (a stranger must not be able to log someone out).
- Otherwise (unverified, mail off, delegated account): upsert one pending row in `password_reset_requests`. A partial unique index `(user_id) WHERE status='pending'` keeps one pending row per user; re-requests refresh it at most once a minute.
- Admin issues a code / temp password from the request row → request becomes `resolved`; a successful self-reset also resolves pending requests. Delegated accounts are shown as such and can only be dismissed.
- Pending count is piggybacked on `/auth/me` for admins (no extra polling).

## Alternatives considered
- Return "no such account": simple UX, leaks existence.
- Store requests for unknown emails too: lets attackers fill the queue with junk.
- Count only unknown-email submissions toward the IP ban: the ban itself becomes an existence oracle. Instead every submission counts (see 0103).

## Trade-offs
Response-time equality is best-effort (the existing-account path does one more DB write). Notes are free text from unauthenticated users; they are rendered as plain text and length-limited (300).

## How others solve it
OWASP Forgot Password Cheat Sheet: identical responses and similar timing for existing/non-existing accounts.

## References
- apps/server/src/routes/auth.ts:486 (`/auth/forgot-password`), :490 (counted toward guard), :533 (upsert)
- apps/server/src/db/schema.ts:97, :117 (table, partial unique index)
- apps/server/src/routes/auth.ts (`/auth/me` `pendingResetRequests`)
