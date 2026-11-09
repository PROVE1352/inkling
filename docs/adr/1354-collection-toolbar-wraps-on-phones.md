# 1354. Collection toolbar wraps under the view tabs on narrow screens

- Status: Accepted
- Date: 2026-11-09

## Context
At 375 px the collection toolbar (view tabs on the left; Sort & filter, Properties, New row and ⋯ on the
right) was one non-wrapping flex row. The tabs squeezed ("All items" broke into two lines, "Sort &
filter" into three) and Properties, New row, its template menu and ⋯ were drawn past the right edge of
the screen (measured: four buttons with `right > 375`), where they could not be reached.

## Decision
- The toolbar row wraps (`flex-wrap`); the action group is `ml-auto shrink-0 whitespace-nowrap`, so on a
  wide pane it stays on the tabs' line and on a narrow one it moves to its own line, right-aligned. The
  tabs wrap among themselves and do not break their labels.
- The Sort & filter panel (320 px, hung from the button's right edge) would then start at x = −117 on a
  375 px screen. Below the `sm` breakpoint it is `position: fixed` with a 16 px gutter on both sides and
  `top: auto`, so it opens right under the button across the screen.

## Alternatives considered
- An overflow menu (⋯) collecting the actions on phones. One more tap for New row, the most used action,
  and a second copy of each action to keep in sync. Wrapping costs one line of height.
- Horizontal scrolling for the tabs. `overflow-x: auto` also clips vertically, which cuts off the tab
  menus (rename, delete) that hang below the tabs.

## Consequences
- On phones the toolbar is two lines high; nothing in it is off screen (Playwright at 375 px, table and
  board, light and dark: no toolbar button past the right edge; the panel spans 16–359 px).
- On phones the Sort & filter panel does not move with the page while it is open (it is fixed); it
  still closes on an outside tap.
