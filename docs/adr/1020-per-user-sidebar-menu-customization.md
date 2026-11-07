# 1020. Sidebar menus: per-user order and visibility, stored on the account

- Status: Accepted
- Date: 2026-11-07

## Context
The top of the sidebar has grown to eight menus (Search, Graph, Tags, Web shares, Due, Calendar,
Activity, Today). Not everyone uses all of them, and people work on several devices (desktop, phone,
tablet), so a choice made on one should hold on the others. Menus will keep being added, and older
and newer app versions can be open at the same time on different devices.

## Decision
- **Storage**: one nullable `users.sidebar_prefs jsonb` column (migration 0033). NULL = default
  (every menu, built-in order). Like `users.locale`, it is a small per-account UI choice; a separate
  table would add a join and a row lifecycle for one value. No production query selects whole `users`
  rows, so the column costs nothing on other paths.
- **Shape**: `{ order: string[], hidden: string[] }` — the order the person last arranged and the ids
  they hid. Menus a later release adds are in neither list, so they appear, visible, right after the
  menu that precedes them in the default order. Ids a client does not know are ignored when it draws
  the sidebar and kept when it saves (in place in `order`, as-is in `hidden`), so two app versions do
  not erase each other's choices.
- **Validation** (`sidebarPrefsSchema`, packages/shared): ids match `^[a-z][a-z0-9-]{0,31}$`, at most
  32 per list, duplicates dropped. The server checks the shape, not the vocabulary: it does not need
  to know the menu list, and a newer client's ids survive an older server.
- **API**: `GET` / `PUT /api/me/sidebar` with the whole value; both lists empty resets to NULL. Browser
  sessions only (403 for agent tokens): this is how the web app looks, nothing an agent should
  change. The value also rides on `GET /auth/me` (`user.sidebar`), which the app awaits before it
  renders, so the first paint is already in the saved order (no default-then-custom flash); that
  route also answers bearer tokens, so an agent can read the value there, which is harmless.
- **Client**: a `['sidebarPrefs', userId]` query (keyed by user, since signing in does not clear the
  cache) seeded from `/auth/me`, refetched whenever the window regains
  focus (another device may have changed it). Saves are optimistic, run one at a time (mutation scope)
  and send the full value, so the last edit wins; a failed save is undone only while the cache still
  holds what it wrote, and a toast says so.
- **Reachability**: hiding only affects the sidebar. Every menu has a command in the ⌘P palette
  (Calendar and Activity were added for this) and Search/Graph keep ⌘K/⌘G. Settings, Trash and
  Shortcuts sit below the page tree and cannot be hidden, so hiding everything still leaves the way
  back. Quick hide: right-click, the context-menu key, or a long press on touch (iOS Safari fires no
  `contextmenu`, so a 500 ms timer does it there).
- **Settings → Sidebar**: a toggle per menu, reordering by drag handle (dnd-kit, already a dependency;
  mouse, long-press on touch, Space + arrows on the keyboard) and ↑/↓ buttons, and "Reset to default".

## Alternatives considered
- localStorage (like the other device-only settings): does not follow the person across devices,
  which is the point of the feature.
- A full ordered list with a `visible` flag per entry and an enum of known ids: a menu added later
  has no entry, so it would need a migration or special casing; an enum makes the server reject a
  newer client's ids.
- Storing only `hidden` and a fixed order: reordering is part of the request.
- A `user_ui_settings` table: more moving parts for one small value; can still be split out later.

## Trade-offs
- Order changes from two devices at the same moment: last write wins for the whole value.
- The focus refetch is one small GET per window focus while the app is open.

## References
- packages/shared/src/sidebar.ts, apps/server/src/routes/sidebarPrefs.ts, apps/web/src/lib/sidebarMenu.ts,
  apps/web/src/sidebarApi.ts, apps/web/src/components/SidebarSettings.tsx, SidebarMenuContext.tsx
