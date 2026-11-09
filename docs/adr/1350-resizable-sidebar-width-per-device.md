# 1350. The sidebar is resized on its edge, and the width is kept per device

- Status: Accepted
- Date: 2026-11-09

## Context
The desktop sidebar was a fixed 260 px (`AppLayout.tsx`: an outer box that animates between 260 px and 0
for the collapse, and an inner box of 260 px so the content does not squash during the animation). Long
page titles in a deep tree were cut at 260 px, and on a 13-inch laptop 260 px is a lot of the screen.
Notion and Obsidian let the edge be dragged.

## Decision
- The width is a CSS variable, `--sidebar-w`, set on the outer box from the device preference
  `sidebarWidth` (`lib/prefs.ts`, localStorage `inkling:prefs`, like the line width of ADR 1090). Range
  200–480 px, default 260 px (the old width), normalized on load (`lib/sidebarWidth.ts`): an old save
  without the key, or a value that is not a finite number, reads as 260.
- A handle (`components/ResizeHandle.tsx`, `role="separator"`) sits on the sidebar's right edge in a
  zero-width flex item next to the sidebar, so its 6 px hit area straddles the border and is not clipped
  by the sidebar's `overflow: hidden`.
  - Drag: pointer capture, the new width written to `--sidebar-w` at most once per animation frame, the
    preference saved once on release. Nothing re-renders while the edge moves; React only sees the
    final value.
  - While a drag lasts `<html data-resizing>` is set: no text selection, the resize cursor everywhere,
    `pointer-events: none` on iframes (embeds would otherwise take the pointer if capture were lost), and
    no width transition on the sidebar (otherwise the edge lags 200 ms behind the pointer).
  - Double-click: back to 260 px. Keyboard on the focused handle: ←/→ 16 px, Shift 64 px, Home/End to the
    ends, Enter back to 260 px. `aria-valuenow/min/max` carry the width.
- Collapsed (⌘\) there is no handle; expanding returns to the stored width. The phone drawer keeps its own
  280 px (max 85 %) and ignores the preference.

## Alternatives considered
- Store the width on the server with the sidebar order (`/me/sidebar`). One width for every device, but a
  wide monitor and a laptop want different widths; the other per-device layout choices (line width,
  zoom, heading folds) are local for the same reason.
- Update React state on every pointer move. Re-renders the layout and the sidebar tree (hundreds of rows
  in a large workspace) per event; the CSS variable needs one style write per frame.
- Clamp to the window as well (e.g. keep 320 px for the page). At the `md` breakpoint (768 px) the widest
  sidebar still leaves 288 px; not worth a resize listener.

## Consequences
- The stored width follows the device, not the account. Another browser starts at 260 px.
- Other tabs pick the width up through the existing `storage` listener of `prefs.ts`.

Tests: `apps/web/src/lib/sidebarWidth.test.ts` (range, old saves, keys). Browser check (Playwright,
1440 px): drag 260 → 380 px saved in `inkling:prefs`; a drag past the end stops at 480; ←/→, Shift+←,
End and double-click; collapse and expand keep the width; reload keeps it; the 375 px drawer stays 280 px
with a stored 460.
