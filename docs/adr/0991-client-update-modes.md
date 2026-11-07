# 0991. Client update modes: prompt (default) and force

- Status: Accepted
- Date: 2026-11-07

## Context
With version skew detectable (ADR 0990), the question is what an open tab does about it. Some
operators want users never to run old code (new routes, changed APIs, security fixes); others do not
want a tab to reload under a user who is in the middle of something.

## Decision
- Server env `UPDATE_MODE=prompt|force` (default `prompt`), delivered to the client in
  `GET /api/version` (`updateMode`). An older server without the endpoint means `prompt`.
- One store (`apps/web/src/lib/update.ts`) receives both signals: a build header mismatch and a
  service worker update (waiting worker, or another tab activated one).
- `prompt`: `UpdateBanner` ("A new version is available · Reload", ko "새 버전이 있습니다 · 새로고침")
  is mounted at the app root next to `<App>`, so it exists on every route (login, settings,
  connections, public pages), with or without a SW. "Later" hides it until the next signal or for
  30 minutes.
- `force`: reload by itself at a safe moment (ADR 0992); a tab opened on an old bundle (e.g. the
  SW's precached shell) reloads immediately. Falls back to the banner after 2 minutes or when the
  loop guard trips.
- Reloading always goes through `reloadToLatest()` (ADR 0993), so a SW-controlled tab really lands
  on the new build.
- The banner is hidden until the mode is known, so a force-mode tab never flashes it.

## Alternatives considered
- Always force: risks losing edits that have not reached the server, and surprises users.
- Always prompt: users can ignore it indefinitely; old routers break new links.
- Per-user setting: the mismatch is an operator concern (API compatibility), not a preference.

## Trade-offs
- In prompt mode a user can keep using an old build for a long time; new routes still redirect in
  that tab until they reload.
- The mode is read once per page load; changing `UPDATE_MODE` affects tabs after their next load.

## How others solve it
- Slack-style chat apps show a non-blocking "update available, reload" bar.
- Workbox's documented recipe is a prompt that calls `skipWaiting` and reloads on `controllerchange`;
  vite-plugin-pwa's `registerType: 'prompt'` wraps the same idea.

## Consequences
- The old SW toast is gone; there is a single update notice (ADR 0993).
- `docs/OPERATIONS.md` documents `UPDATE_MODE`.

## References
- `apps/web/src/lib/update.ts`, `apps/web/src/components/UpdateBanner.tsx`, `apps/web/src/main.tsx`
- ADR 0990, 0992, 0993
