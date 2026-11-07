# 1242. The two-step verification deadline is set from the database clock

- Status: Accepted
- Date: 2026-11-08

## Context
`PUT /workspaces/:id/settings/two-factor` stored `two_factor_required_at = new Date()` (the app's
clock), while every check compares the deadline with `now()` in SQL (`twoFactorBlockedSql`,
docs/adr/1112-*). With a grace of 0 days a member must be blocked from the next request on, and
the route itself closes the sockets of members who are past the deadline right after the update.

When the app's clock is ahead of the database's, the stored moment is in the database's future:
the member stays unblocked for that skew, and the socket sweep right after the update finds
nobody to disconnect. On the test machine (Docker Desktop, database in a VM) the database clock was
46 ms behind the host, and `secretsAtRest.db.test.ts` "grace 0 blocks at once" failed whenever the
next request came within that window (2 of 24 loaded runs). Production with app and database on
one Linux host shares one clock; a managed database or another host does not.

## Decision
- The moment the requirement is turned on comes from the database: ``sql`now()` `` in the
  update (the transaction's start, before its commit). Changing only the number of days keeps the
  stored moment, as before.

## Alternatives considered
- **Compare in JavaScript instead of SQL:** the check lives in SQL so that every
  workspace-scoped query applies it without a second round trip.
- **Subtract a safety margin:** hides the skew without removing it.
- **Loosen the test (retry until 403):** would keep the production window.

## Consequences
- The deadline and its checks use one clock. `twoFactorStatus` in the DTO still compares with
  the app's clock for the "grace / blocked" label; a skew there only shifts a label.
- Other timestamps written from the app and compared with `now()` in SQL may have the same skew;
  they were not audited here (KNOWN-ISSUES).
