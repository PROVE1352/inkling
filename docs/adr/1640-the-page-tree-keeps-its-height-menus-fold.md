# 1640. The page tree keeps its height; menus that do not fit fold under "More"

- Status: Accepted
- Date: 2026-11-10

## Context
The sidebar is a column of fixed rows (workspace switcher, the customizable menus of ADR 1020, "New
page", then the footer: trash, shortcuts, settings, the account box) around one flexible part, the page
tree. 0.11 added Later and Threads, so a person with every menu on has ten menu rows. On a Galaxy Tab S10
in landscape (1280×800 CSS px) Chrome's bars leave about 700 px, and a reporter opening the app in KakaoTalk's
in-app browser had about 480 px. With ten menus and a coarse pointer the tree got 171 px at 800, 71 px at
700 and 8 px at 480: the Shared/Private sections were not visible at all (measured with the check below on
0.12). Changing the default list (ADR 1641) does not help anyone who already saved one.

## Decision
- The tree always keeps `sidebarTreeMinHeight(h)` = 40 % of the sidebar height, at least 200 px and at most
  280 px (`lib/sidebarMenu.ts`). 200 px holds the section header and four rows at the 40 px touch row
  height; above 700 px the cap keeps a desktop with every menu from folding when the tree has room anyway.
- The menus show in full when they fit in what is left (sidebar height − the other rows − the tree
  minimum). Otherwise the first N show and one row "More (k)" folds the rest (`menusThatFit`). The row
  shows a red dot when a folded menu has a badge (Later reminders due, unread threads, due today), and
  is in the active style when the current screen is one of the folded menus. Opening it lists every menu
  in a scroll area of the same height, with "Show less" below it; the open/closed state is per device
  (localStorage `inkling:sidebarMenusExpanded`, like `inkling:favCollapsed`).
- Heights are measured on the sidebar element (ResizeObserver), not the window, so the phone drawer and
  the desktop column use one rule, and the browser's own bars are already excluded. The measurement
  leaves the menus and the tree out of the sum, so it does not depend on how many menus show and settles
  in one layout pass.
- Below 720 px of sidebar height the footer becomes one row of icon buttons (trash, admin with a dot for
  pending reset requests, shortcuts, settings, copy invite link, account, log out) with titles and
  `aria-label`s; it wraps at the 200 px minimum width rather than cut the last button off. That gives the
  tree about 140 px back at 480 px.
- The "New page ▾" menu opens below the button when it fits, else above it when there is more room
  there, else as tall as fits with a scroll. The workspace switcher's menu, the menu's right-click menu
  and the tree row's context menu get a `max-height` of the window with a scroll.

## Alternatives considered
- One scroll for the whole sidebar (Notion). Simple and nothing is ever cut, but where the tree starts
  then depends on how many menus are on, which is the complaint itself: on a short screen the tree is
  below the fold until you scroll past the menus, and "New page" scrolls away with them. Notion keeps its
  fixed menu list short (search, home, inbox) for that reason. Kept as the fallback idea if the footer or
  favorites grow further.
- Scroll the menu list on its own (a nested scroll with a max height) without "More". Every menu is
  "there", but a list cut at an arbitrary pixel with no label looks like a layout bug, and on touch the
  inner and outer scroll fight.
- A fixed N (for example five menus, then "More"). The right N is different at 480 px and at 1280 px.
- Only change the defaults. Leaves every person who already arranged the sidebar with the same problem.

## Consequences
- On a short screen some menus are one tap further away; the keyboard shortcuts and the command palette
  reach all of them as before (search ⌘K, graph ⌘G, …).
- The compact footer shows no name and email (the account icon carries them in its title); Settings
  shows both.
- The sidebar re-measures on every render (one `getBoundingClientRect` per fixed row); a state update
  happens only when the result changes.

Tests: `apps/web/src/lib/sidebarMenu.test.ts` (tree minimum, `menusThatFit`, compact footer threshold).
Browser check (Playwright, Chromium, light and dark, touch emulation for the tablet and phone sizes) at 1280×800, 1280×700, 1280×480, 800×1280, 800×1100, 1440×900, 1366×768 and the
375×667 drawer, with every menu on and with the new default: "New page", the first three tree rows and the
whole "New page ▾" menu inside the visible area, nothing in the footer cut off, and with "More" open the
tree rows still visible.
