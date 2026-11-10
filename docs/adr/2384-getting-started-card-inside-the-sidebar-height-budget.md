# 2384. The Getting started card is part of the sidebar's height budget

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR 2380 (where the sidebar card goes), ADR 1643 (what the menu fold counts)

## Context
ADR 2380 put the Getting started card at the bottom of the sidebar, between the page tree and the footer.
The menu fold of ADR 1640/1643 measured the sidebar's other rows only when the sidebar itself re-rendered,
and the card's state lives in its own lazy component, so the fold did not see the card change. The card's
bottom margin was not counted either. In Chrome with onboarding on (0.19 before release): the open card
(429 px) pushed the footer (trash, shortcuts, settings, account) 306/226/126/26 px below a 1280 × 720/800/900/1000
sidebar, where it cannot be reached (the sidebar shell clips); with the card folded and "More" open at 800 px
the footer was 5 px under the edge; opening the card while "More" was open did not fold the menus again
until "More" was closed and reopened.

## Decision
- One pure function, `sidebarLayout` (`lib/sidebarMenu.ts`), places the menus, the tree minimum and the card
  from `free` = the sidebar height less every other row (header, "New page", footer). Without a card its
  results are those of `menusThatFit` and `expandedMenusLayout`, unchanged.
- Order, as in ADR 1643 with the card last: the tree keeps at least 120 px; "More" opened reaches every folded
  menu; the open card gets what is left. The card is drawn open in at most `free − 120 − menus`, where
  `menus` is one row while "More" is closed and every menu plus "Show less" while it is open. When its items
  need more, the card scrolls inside below its title row and progress bar, which stay put. When that room
  cannot hold the title, the progress bar and the first two items (138 px in Chrome at 1280 px wide), the
  card is drawn folded although the person left it open (`data-folded-by-room`, with a tooltip).
- The fold count ("More (k)") is decided with the card as it is drawn while "More" is closed. Opening "More"
  can shrink or fold the card but never changes the count (ADR 1643's rule). The open card may take the
  tree below its folded minimum (200–280 px), never below 120 px.
- The card measures itself (folded, open with every item, two items; margins included) with a
  ResizeObserver and reports it to the sidebar, which hands back `{ open, height }`. Folding or opening the
  card, a ticked item, a new line of text or a resize recompute the fold, also while "More" is open. The
  room it is given does not depend on its own measured height, so the two cannot chase each other.
- Unchanged: below 720 px (compact footer) the card is not drawn; the folded card (64 px with its margin) is
  not given up for the menus, so at 1280 × 900 the ten menus fold "More (3)" while the card is there (the
  tree keeps its 280 px minimum; without the card all ten show).

## Alternatives considered
- Let the card overlay the tree or the footer. It hides what the person came for, and the footer must stay
  reachable.
- Let the whole sidebar scroll when the card is open. ADR 1640 and 1643 rejected one sidebar scroll: "New
  page", the tree and the footer move out of view and the tree's scroll sits inside the sidebar's.
- Give the menus' room to the card first (unfold the menus only when the card is folded). The card is a
  temporary aid; the menus and the tree are the app. The menus keep their place and the card scrolls.
- Close "More" when the person presses a card that is drawn folded for lack of room. It would change the
  per-device "More" state that ADR 1643 keeps, and "More" opened outranks the card. The press sends the
  same request as before (the card stays open in storage) and the card opens when there is room.

## Consequences
- With "More" open on a short window (below about 900 px at 1280 wide with ten menus) the card is drawn
  folded; pressing it does not open it until "More" is closed or the window is taller (KNOWN-ISSUES).
  Above that it opens small and scrolls.
- With the card open, more menus fold under "More" than without it: with ten menus all of them fold,
  "More (10)", at 1280 × 720–1000 (the open card is 437 px and the tree keeps its folded minimum).
- One new string, `getStarted.noRoom` (en, ko).

Tests: `apps/web/src/lib/sidebarMenu.test.ts` (`sidebarLayout`: no card = the 1643 functions over 420–1000 px ×
0–10 menus; 720–1000 px × 1–10 menus × card folded/open × "More" closed/open: everything fits, the tree keeps
120 px, the count is the same open and closed; the 720/800/900/1000 figures). Browser check (Chrome, scratchpad
`onb-on/uifix/sidebar-matrix.mjs`, onboarding on and off): 1280 × 600–1000, card folded/open, "More"
closed/opened and the live flows; the footer's Settings pressed at its drawn point; scrolling inside the card
to its last item; the 390 × 844 phone drawer.
