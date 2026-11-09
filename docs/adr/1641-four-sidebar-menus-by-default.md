# 1641. Four sidebar menus by default; saved choices keep their meaning

- Status: Accepted
- Date: 2026-11-10

## Context
Every top-of-sidebar menu (ADR 1020) was on by default: search, Later, Threads, graph, tags, web shares,
due, calendar, activity, today. Ten rows above the page tree is the main reason the tree had no room on a
tablet (ADR 1640). Most of them are also reachable another way: graph and search have keys, today's note
has a key and a calendar day, tags and web shares are occasional screens, activity and threads have the
notification bell.

The stored value is `{ order, hidden }` per user. The server stores NULL for `{ order: [], hidden: [] }`
(`routes/sidebarPrefs.ts`), so "never customized" and "customized back to the default" are the same value,
and the API shape and the table are not to change in this release.

## Decision
- New default: search, Later, due, calendar. `SIDEBAR_MENU_DEFAULT_HIDDEN` (`packages/shared/src/sidebar.ts`)
  lists the other six. Search and Later are what a person comes back for every day; due and calendar are
  the only views of dates, which have no other entry point than the sidebar.
- The default applies only to the empty value. A stored value keeps its 0.12 meaning: every menu not in
  its `hidden` list shows. Someone who hid one menu in 0.12 still sees the other nine.
- Saving (`toSidebarPrefs`) collapses to the empty value only when the list equals the new default
  (default order and exactly the default-hidden set). A list with every menu on in the default order, which
  used to collapse to the empty value too, now stores its `order` explicitly, so it is not read back as the
  four-menu default. No new id or field: `order` with every known id is a value 0.12 already wrote.
- "Reset to default" in Settings › Sidebar keeps sending the empty value, so it now means the four menus.

## Alternatives considered
- A version marker in the stored value (a sentinel id such as `v2` in `order`). Would also tell "chose all
  ten" apart from "never chose", but it puts a fake menu id into data that other builds merge and keep
  (ADR 1020 keeps unknown ids on purpose), and it still could not tell old empty values apart.
- Apply the new default to everyone, including stored values. Changes a sidebar someone arranged on
  purpose.
- Keep all ten on. The layout fix (ADR 1640) makes it work, but a new person would start with "More (6)"
  on a laptop.

## Consequences
- People who never touched the sidebar, or reset it, see four menus after the update. The settings list
  shows the others switched off, one tap to bring each back. This is the one visible change for existing
  users and goes into the release notes.
- A 0.12 client still running elsewhere reads the empty value as "all ten" and, when it saves "all ten in
  the default order", writes the empty value, which a 0.13 client reads as four menus. It needs an old and a
  new client open at the same time, and the person can switch the menus back.

Tests: `apps/web/src/lib/sidebarMenu.test.ts` (new default, saved values unchanged, explicit "all on",
hiding one more from the default).
