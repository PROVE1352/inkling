# 2539. The deletion preview answers browser sessions only

- Status: Accepted
- Date: 2026-11-12

## Context
`GET /api/me/delete-preview` lists every workspace of the account and the members who would take over.
An API token limited to one workspace could read it (security review R2), past its range. Leaving itself
(`DELETE /api/me`) was already browser-only.

## Decision
- The route refuses bearer requests (403, the session-only message), on every server.
- The check is in the route, not in `tokenPolicy.ts` `SESSION_ONLY`: that table's test builds an app
  without the account routes and requires every entry to be a registered route.
- A test walks every route 0.22 added with a full-access API token: the account deletion routes, delete
  now, the admin expiry routes and leaving are refused; consent is refused (or 404 without terms); a
  workspace's usage stays readable within the token's range.

## Consequences
- An agent can no longer show what leaving would delete; the person sees it in Settings.
