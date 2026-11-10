# 2223. What a push shows on a lock screen, and what the service worker does with it

- Status: Accepted
- Date: 2026-11-10

## Context
A push payload is end-to-end encrypted to the browser, but the notification it becomes is read on a
lock screen, often by someone else. The service worker is Workbox's generated `sw.js`; push handlers
must live in `public/push-sw.js`, a plain script it imports.

## Decision
- Payload (JSON, at most 2048 bytes before encryption, `push/payload.ts`): `title` = the sentence of
  the instant mail subject ("Ann mentioned you in a comment on "Plan"", the person's language, at most
  120 characters), `body` = the notification's own excerpt (a comment or mention line the engine
  already cut to 200 characters) shortened to 100 characters, or empty; `url` = the page path built
  from ids only; `tag` = `p:<page id>` (one notification per page), `id`, `ts`. No page body text is
  ever added beyond what the bell shows.
- "Hide content on the lock screen" (per person, `push_settings.hide_content`): title "Inkling", body
  "New notification", nothing about who, where or what; the url still opens the page.
- Per-person settings (`push_settings`): on/off for all devices, kinds by group (mention, assigned,
  reply, comment, approval, reminder, updates; default all but updates — page edits and AI summaries),
  hide content. Existing notification settings had no per-kind switch; subscription levels still apply
  first (push follows the bell).
- `push-sw.js`: `push` shows the notification (tag, `renotify`), skipping it only when a focused,
  visible window is on that very path, and only on Chromium and Firefox user agents (WebKit — Safari,
  every iOS browser, Home Screen apps whose user agent lacks "Safari/" — revokes subscriptions whose
  pushes show nothing); `notificationclick` focuses an Inkling window and asks the app to route there over a
  MessageChannel (`PushSync`), falling back to `client.navigate` and then `openWindow`; only same-origin
  paths starting with one `/` are opened. `pushsubscriptionchange` subscribes again with the server key
  and registers it. Permission is asked only from the "Turn on" click in Settings → Notifications.
- `push-sw.js` is served with `Cache-Control: no-cache` like `sw.js` (`httpCache.ts` SHELL_FILES): the
  browser fetches imported scripts through its HTTP cache when it updates a worker
  (`updateViaCache: 'imports'`), so the former one-day max-age kept old handlers after a deploy.

## Alternatives considered
- No preview at all by default: mentions without the line that mentions you are much less useful;
  "hide content" covers people who want nothing on the lock screen.
- Longer previews (the full 200-character excerpt): most lock screens cut at two lines (~100
  characters) anyway.
- Page text in the push: would put content the bell does not show onto lock screens.

## Trade-offs
- The foreground check skips a push for the page in view; another page still notifies while the app
  is open (the bell would show it too).
- Quiet hours are not part of this (candidate for later).

## Files
- apps/server/src/push/payload.ts, apps/server/src/httpCache.ts, apps/web/public/push-sw.js, apps/web/src/components/PushSettings.tsx,
  apps/web/src/components/PushSync.tsx
