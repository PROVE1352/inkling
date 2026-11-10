# 2202. Offline start from the last app data the server sent

- Status: Accepted
- Date: 2026-11-10

## Context
Opening the app needs `/api/auth/me` (RequireAuth), `/api/workspaces` and the workspace's page tree
(`/api/workspaces/:id/pages`, which PageView also reads the page's metadata from). Offline each
fails, RequireAuth sent the user to /login, and no page could open even with its document stored.

## Decision
- On every successful answer the app keeps `me`, the workspace list and each workspace's tree in the
  offline store's `snapshots` (keyed by user, ADR 2200), in the query functions of `useMe`,
  `fetchWorkspaces` and `usePages` (`api.ts`). The service worker still caches no API response.
- When one of them fails **without an HTTP answer** (a `TypeError` from `fetch`: offline, server
  unreachable), the query returns the kept value instead (for `me`: the store owner's). An HTTP
  error stays an error: a 401 still goes to /login and also deletes the copies (ADR 2203).
- While the app runs on kept data, or the browser reports no network, a banner says so; the tree is
  what the device kept and acts as a read-only list: creating, moving and deleting pages offline are
  not supported (their requests fail as before). Opening a page that has no device copy shows "never
  opened on this device" instead of an editor: typing into an empty document there would start a
  second history the server does not know.
- When the tree or workspace list comes back from the server, device copies of pages it no longer
  lists are checked with `/sync-check` (`sweepWorkspace`): trashed → unsent edits become a recovery
  item and the copy goes; 403/404 → the copy goes; other answers → kept until the next check. Copies
  of workspaces no longer listed are deleted.

## Alternatives considered
- **Persisting the whole React Query cache** (a persister): stores far more personal data than needed
  (search results, members, comments) and has no per-user wipe; and it would be a new dependency.
- **Starting offline only from the installed app**: the setting already decides whether anything is
  kept (ADR 2203); the start path does not need a second rule.

## Consequences
- Other screens (calendar, search, activity, comments, ink) show their usual errors or empty states
  offline.

## References
- apps/web/src/api.ts (useMe, fetchWorkspaces, usePages), apps/web/src/lib/offline/runtime.ts,
  OfflineBanner.tsx, apps/web/src/components/CollabEditor.tsx
