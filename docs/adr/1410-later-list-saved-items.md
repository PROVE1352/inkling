# 1410. Later list: saved pages, threads and notifications, titles joined at read time

- Status: Accepted
- Date: 2026-11-09

## Context
People keep things to come back to in the bell (unread as a to-do list), in bookmarks (made for
navigation, not for "done") or outside Inkling. Slack's "Later" shows the shape that works: save a
message, a thread or an activity item; mark it done; get reminded. Inkling's targets are pages,
comment threads and notifications. Visibility changes over time: a page goes private, a member
leaves, a workspace starts requiring two-step verification (docs/adr/1112-*, 1300-*), an outsider
must get "not found" (1301). A saved item must not become a way to keep reading what the person
lost access to.

There is no inbox screen in the web app: "inbox" is the MCP tool over the person's notifications
(1003); people see the bell. A Later list therefore needs its own screen.

## Decision
- One table `later_items` (`apps/server/src/db/schema-later.ts`): owner, workspace, `kind`
  (`page` | `thread` | `notification`), the target's ids (`page_id`, `thread_id`,
  `notification_id`), an anchor, `done_at`, the reminder (`remind_at`, `remind_tz`, `reminded_at`;
  ADR 1411). Nothing about the target is copied: no title, no excerpt.
- `target_key` (`page:<id>`, `thread:<id>`, `notification:<id>`) is unique per person; saving again
  is an upsert that reopens a done item.
- A saved notification keeps the page and thread it points to (copied ids) and a link to the
  notification (`ON DELETE SET NULL`); the label ("Bob replied…") comes from the notification while
  it exists. Workspace-level notifications (no page) cannot be saved: nothing to come back to.
- Saving checks the target the same way the page routes do: `findVisiblePage` (outsiders get 404,
  1301), then `requireMembership(…, { guests: true })`; a thread must be a root of a page the caller
  can see; a notification must be the caller's own.
- Listing joins the live rows and computes `accessible` with the same terms as the agent inbox and
  the mailer (`targetVisibleSql` in `apps/server/src/later.ts`): live shared page or own private
  page, member or guest (`memberOrGuestSql`), live workspace, not blocked by 2FA, inside the token's
  range. When false, every field from the target is null (title, preview, actor, anchor,
  notification type); the row stays so it can be deleted. Items of workspaces outside a token's
  range or blocked for an agent are not listed at all.
- Open items are capped at 500 per person (409 `LATER_FULL`); reminders pass the hourly caps (1411),
  so the cap bounds them instead.
- Screen: sidebar menu "Later" (`/w/:wsId/later`, default position after Search, hideable like the
  others, ADR 1020) with Open / Done tabs and a red badge for reminders that came due. Save actions:
  page ⋯ menu, the comment thread card, each page notification in the bell.
- Commands (docs/adr/1400-*): `app.later`, `app.threads` and `page.saveForLater` are in the palette
  without a default key, like the other sidebar menus (Calendar, Activity, Due…; ADR 1020);
  `thread.toggleFollow` follows the focused thread card and has no key and no palette entry (the
  palette takes the focus). A key is left to the user (Settings, ADR 1404): the registry has no key
  sequences (`g l`), and the chords that came up were taken elsewhere (⌘⌥L: Show Downloads in Safari;
  Ctrl+Alt+L / Ctrl+Alt+T: lock screen and terminal on some Linux desktops; ⌘S: the browser's Save
  page; ⌘⌥S: favorites).

## Alternatives considered
- **Bookmarks with a "done" flag:** bookmarks are per-page navigation shortcuts in the sidebar;
  threads and notifications do not fit, and "done" would remove a shortcut people want to keep.
- **Copy title and excerpt at save time:** cheaper list query, but the copy outlives the access it
  was read under; every visibility change would need a cleanup job.
- **A tab inside the bell:** the bell is a 50-item popover; a list with reminders, done items and
  bulk use needs a screen. The bell keeps a one-click "save for later".
- **Hide inaccessible items entirely:** simpler, but the person would see an item vanish without
  knowing why and could not clear it.

## Trade-offs
- The list joins pages, comments, notifications and users per row (≤ 200 rows).
- A guest's reminder fires into the notification engine, which only reaches members (1000): a
  guest gets no bell item or mail for it (listed in KNOWN-ISSUES).

## Consequences
- New routes `GET/POST /later`, `GET /later/target`, `PATCH/DELETE /later/:id`.
- Tests: `apps/server/src/later.db.test.ts` (save, permissions, redaction on private page / left
  workspace / 2FA block), `guests.db.test.ts` (inside the shared trees only).

## References
- apps/server/src/later.ts, apps/server/src/routes/later.ts, packages/shared/src/later.ts
- apps/web/src/pages/LaterView.tsx, apps/web/src/components/LaterPanel.tsx
- apps/web/src/lib/shortcuts/registry.ts (`app.later`, `app.threads`, `page.saveForLater`, `thread.toggleFollow`)
