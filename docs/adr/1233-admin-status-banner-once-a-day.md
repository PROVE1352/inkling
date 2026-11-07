# 1233. Admin status banner: one line, the same problem once a day

- Status: Accepted
- Date: 2026-11-08

## Context
The status summary (docs/adr/1230-*) should reach the admin when they open the app, without turning
into noise that is dismissed by reflex.

## Decision
- The banner is a one-line strip at the top of the app shell (`AppLayout`, above the email
  verification banner), for admins only. All clear → nothing is rendered. Otherwise: amber for
  warnings, red when any item is an error, the first problem as "Label: value", "+N more", a
  "Details" link to Admin and a close button.
- A problem is `<item key>:<level>`. When the banner shows, every problem in it is stamped with the
  time in `localStorage` (`inkling-admin-status-seen:<user id>`, at most 100 entries, entries older
  than 24 h dropped). The banner shows only when at least one current problem has no stamp from the
  last 24 hours, so the same problem appears at most once a day, a new problem appears at once, and
  a warning that becomes an error appears again. Opening the admin page counts as seeing them all.
- Closing hides the banner for the rest of the session; it does not need a separate "snooze".
- Not shown on the admin page itself, which shows the cards.
- The client caches the status for 5 minutes and refetches every 5 minutes, matching the server.

## Alternatives considered
- **Show on every load until dismissed**: "when I open the app" taken literally becomes a banner
  people learn to ignore.
- **Server-side "seen" state**: a table and writes for a per-browser convenience; losing the
  stamps only means one more banner.
- **A toast**: disappears before it is read and cannot carry a link and a close button calmly.
- **A small dot when all is ok**: adds chrome to every screen for no action; the admin page shows
  "All good" instead.

## References
- apps/web/src/status/AdminStatusBanner.tsx, seen.ts (+ seen.test.ts), apps/web/src/components/AppLayout.tsx
