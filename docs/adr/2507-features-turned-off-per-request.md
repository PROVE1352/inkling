# 2507. Features turned off: decided per request, what exists stops too

- Status: Accepted
- Date: 2026-11-12

## Context
`DISABLED_FEATURES` turns features off for a whole server (a public demo turns off everything that sends
requests out on a member's behalf or opens data without sign-in). Turning a feature off must also stop
what was set up before (a public link, a webhook, an iCal token), without deleting it.

## Decision
- **Routes stay registered and answer 404 `FEATURE_DISABLED`.** `quota/features.ts` lists each feature's
  `/api` routes by method and Fastify pattern; one `onRequest` hook on the `/api` scope (added by
  `registerQuota`) refuses them before authentication. Fastify applies a scope's hooks to all its
  routes, including those declared before the hook (the auth routes), so `index.ts` and the test harness
  need no change and the decision follows `setLimitsForTests` at once.
- **Clean-up stays open**: unpublishing, deleting a webhook, removing a Slack link or an iCal token,
  unsubscribing a device.
- **What exists stops where it acts**: `/s/:token` serves the plain app shell, `/ical/:file` answers 404,
  webhook and Slack senders and web push queue and send nothing (queued rows wait), an automation's
  webhook action is skipped (never counted against the rule), `cimdConfig()` is off, the app's CSP keeps
  only `frame-src 'self'`, a Notion import asked for is refused and a detected one is read as plain
  Markdown, page invitations are not mailed (the link is handed back).
- **The app hides** the menus of features that are off (`useAuthMode().disabledFeatures`).

## Consequences
- The feature list in the gate is pinned by `quota/features.db.test.ts`: every listed route exists and
  answers 404 when its feature is off, and something else when nothing is off.
