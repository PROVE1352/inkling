# 1643. Opening "More" shows every folded menu; the page tree gives way

- Status: Accepted
- Date: 2026-11-10
- Amends: ADR 1640 (what "More" shows when opened)

## Context
ADR 1640 folds the menus that do not fit above the page tree under one row, "More (k)". Opening it listed
every menu in a scroll box as tall as the folded budget less one row: `available − rowHeight`, where
`available` is what is left once the tree minimum (`sidebarTreeMinHeight`, 200–280 px) is kept. The folded
state already used that budget (N menus + the "More" row), so the open box was at most about one row taller
than the folded menus. A person on 0.17.1 with a browser window that was not full-screen saw "More (3)",
pressed it and got one more row plus "Show less"; the other two were in the box's own scroll with nothing
that said so ("it said 3 and shows 1"). The automated check of 1640 only asked that the tree rows stay
visible with "More" open, so it passed.

## Decision
- Opening "More" is an explicit request for the menus, so while it is open the tree gives way: its minimum
  drops from `sidebarTreeMinHeight(h)` to `expandedTreeMinHeight` = 120 px (the section header and two or
  three rows; never more than the folded minimum). The tree keeps its own scroll at that height.
- Every menu shows when they fit in the folded budget plus what the tree gave back, less one row for "Show
  less" (`expandedMenusLayout`, `lib/sidebarMenu.ts`). With the four default menus that is every sidebar
  height down to about 410 px; with all ten menus on, down to about 600 px (fine pointer, compact footer).
- Whether the menus fold at all is still decided by the folded budget (`menusThatFit` with the full tree
  minimum). Opening the list does not change it, so "Show less" stays where it was and the count in
  "More (k)" is exactly the number of menus that appear when it is opened.
- A sidebar too short even for that (all ten menus at 420 px): the open list scrolls in whole rows, and a
  24 px row under it says what is out of view, "k more below" / "k more above", with a red dot when one of
  those menus has a badge and the active style when one is the current screen. Pressing it scrolls the list
  by a page (or back to the top). "More (k)" then equals the menus that appeared plus the k below.
- Unchanged from 1640: the open/closed state per device (`inkling:sidebarMenusExpanded`), "Show less", the
  red dot and active style on the folded row, the same rule in the phone drawer and the desktop column,
  long-press/right-click on a menu.

## Alternatives considered
- Keep the tree minimum while open (1640 as written). This is the reported bug: the open list can only be
  about one row taller than the folded one.
- Let the whole sidebar scroll while the list is open. Every menu would be in the flow, but "New page", the
  tree and the footer move below the fold, and on touch the tree's scroll sits inside the sidebar's — the
  reasons 1640 gave against one sidebar scroll. The list's own scroll is a sibling of the tree's, as before.
- Let the tree go to zero while open. The open page's place in the tree and the "New page" target would
  disappear; 120 px keeps the section header and a few rows.

## Consequences
- With "More" open on a short window the tree shows fewer rows (at least 120 px) until "Show less".
- The only new strings are the two "k more below/above" labels.

Tests: `apps/web/src/lib/sidebarMenu.test.ts` (`expandedTreeMinHeight`, `expandedMenusLayout` at 620 and 420 px
and the budget over 420–900 px × 1–10 menus, `rowsOutOfView`). Browser check (Chrome, scratchpad
`w19-browser/uifix/check.mjs`): at the height where menus fold, "More (k)" equals the menus that newly appear
inside the window and are not covered (`elementFromPoint`), before and after the change; 1280×900 does not
fold; 1280×420 follows the scroll rule; "Show less" restores; the tree still scrolls; the 390 px drawer.
