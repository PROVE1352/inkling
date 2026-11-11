# 2515. Account lifetime: a date set at sign-up, an hourly job, a dry run

- Status: Accepted
- Date: 2026-11-12

## Context
A demo server deletes accounts some days after sign-up (ACCOUNT_LIFETIME_DAYS). The production server
runs the same code with real accounts, so deleting must need two independent conditions.

## Decision
- Double lock: the job deletes only while the setting is on and only accounts whose `expires_at` has
  passed. `expires_at` is written only by the sign-up hook, inside the account's transaction, after
  the first-admin promotion, and never for admins; accounts made before the setting have none.
  `deleteAccount(…, { by: 'expiry' })` re-reads all of it under the admin lock.
- The hourly job (`account/housekeeping.ts`) takes up to 50 accounts, oldest date first, each in its
  own transaction; a failure is one log line (the error code only) and the next account runs. Log
  lines carry user ids and counts, never a name or ID. ACCOUNT_LIFETIME_DRY_RUN=1 logs the plans only.
- Admins read, lift or move a date with `GET`/`PATCH /api/admin/users/:id/expiry`; Admin › Users shows
  the date with "Lift expiry". `/admin/users` carries `expiresAt` only on accounts that have one.
- The app shows "This account will be deleted on YYYY-MM-DD" with an export link under the workspace
  switcher, and as a banner on phones and, in the last three days, on every screen.

## Consequences
- The six named tests of the contract's principle 2 live in `account/accountLifetime.db.test.ts`.
