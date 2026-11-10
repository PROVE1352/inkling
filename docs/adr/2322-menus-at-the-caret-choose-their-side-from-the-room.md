# 2322. Menus at the caret choose their side from the room around the caret

- Status: Accepted
- Date: 2026-11-10

## Context
The slash menu, the `[[` / `![[` link menus and the `@` mention menu are BlockNote's
`SuggestionMenuController`, positioned by floating-ui with `autoPlacement` (bottom-start or top-start) and
`size` (max-height = available height). Reported on 0.17.1: on a line near the bottom of a short window the
slash menu opened below the caret with one item visible and the rest cut off. Reproduced in Chrome at
1280 × 700 on lines 60, 90 and 130 px above the bottom (menu 46 / 76 / 116 px tall, 0 / 0 / 1 items
visible); a line right at the bottom was fine. `autoPlacement` picks the side from the menu's size at that
moment. The items load asynchronously, so the menu is nearly empty when it opens: it fits into the sliver
below the caret, `size` caps it to that sliver, and as the floating element stays capped nothing measures it
again when the items arrive.

## Decision
- One middleware (`lib/caretMenu.ts`, passed as `floatingUIOptions` to the three controllers) replaces
  BlockNote's list: below when there are at least 300 px below the caret or at least as much room as
  above, otherwise above. The side never depends on the menu's current height. The menu's max-height is the
  room on that side (10 px gap, 10 px from the edge), it scrolls inside, and the selected item is kept in
  view by the menu items (`scrollIntoView`, unchanged). Horizontally it is shifted to stay inside.
- The room is measured in the visual viewport (`window.visualViewport`), so a phone's on-screen keyboard
  counts.
- The pure part (`placeCaretMenu`, `shiftIntoView`) has unit tests; a Chrome check covers the bottom, the
  reported 60–130 px case, the middle of a page (still below), the link and mention menus and a phone-sized
  window.

## Alternatives considered
- **Keep autoPlacement and add `flip` before `size`**: same problem, both measure the capped element.
- **Decide from the menu's full content height**: it is not known while the items load; a menu that has not
  loaded yet would still go below.
- **Importing floating-ui's `offset` / `flip` / `size`**: `@floating-ui/react` is BlockNote's dependency,
  not the web app's (ADR 0882); the middleware object needs no import.

## Consequences
- A short menu (two mentions) near the bottom opens above even if it would have fitted below.
- The open animation still scales from the top-left corner when the menu opens above.

## References
- apps/web/src/lib/caretMenu.ts, caretMenu.test.ts, components/SlashMenu.tsx, WikilinkMenu.tsx, MentionMenu.tsx
- Chrome check scratchpad w18-browser/int steps 1a–1e, 2a (before: before-fix-slash.log)
