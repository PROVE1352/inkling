# 0703. Keep `content-visibility` off for WebKit (alternatives measured and rejected)

- Status: Superseded by 0850 (the rule was removed in every engine: it caused lost keystrokes in Chromium)
- Date: 2026-11-07

## Context
`index.css` gives top-level editor blocks `content-visibility: auto` with per-type
`contain-intrinsic-size`, except under `html[data-engine=webkit]` (main.tsx), because Safari did not
paint blocks created with Enter until the page was reopened (11/1). The memory audit asked whether
WebKit could get the benefit back.

## Measurements (Playwright WebKit 2215 / Chromium 1194, production build, 3 701-block document)
Bug reproduction (fresh page, 6 × Enter+type, pixels of each new block checked in a viewport
screenshot): CSS on → 1/6 blocks painted; off → 6/6. Variants `contain-intrinsic-size: none`,
fixed `32px`, and no `contain` → all 1/6. The bug is not caused by the size hints.

Cost in WebKit (median of 3–5 runs; open via SPA navigation until painted / width-change relayout /
keystroke near the top until next frame):
| WebKit | open | relayout | keystroke |
|---|---|---|---|
| off (current) | 1 065 ms | 40 ms | 33 ms |
| on (current CSS incl. `:has()` sizes) | 3 600 ms | 300 ms | — |
| on, plain `auto 60px` | 1 440 ms | 130–360 ms | 590 ms |
| `contain: layout style` only | 1 435 ms | 195 ms | 200 ms |
In Chromium the current CSS stays a win (open 320 ms on vs 455 ms off; keystroke 33 ms both).

## Decision
No change: WebKit keeps full layout of all blocks. Every alternative is slower in WebKit even before
counting the paint bug, so a JS emulation (IntersectionObserver toggling, or `nth-child` windows)
would add complexity on top of a regression.

## Alternatives considered
See the table; also IntersectionObserver-driven `content-visibility: hidden` (breaks find-in-page
for skipped blocks and still pays the WebKit containment cost).

## Trade-offs
Very large documents open ~1 s in WebKit (vs 0.3 s in Chromium).

## How others solve it
Notion virtualizes blocks in JS for huge pages; most editors (Google Docs aside) rely on plain layout.

## Consequences
Re-test when Safari ships a fix for dynamically inserted `content-visibility: auto` elements.

## References
- apps/web/src/main.tsx:29-33, apps/web/src/index.css (block content-visibility rules)
- wkbug.mjs, wkperf.mjs (out-of-tree measurement scripts, not shipped)
