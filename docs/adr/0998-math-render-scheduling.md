# 0998. Math render scheduling: paced insertion, a resident cap, deferral only on math-heavy pages

- Status: Accepted
- Date: 2026-11-07

## Context
The first version (ADR 0997) rendered every formula synchronously in React render as soon as KaTeX
loaded. On a page with 1,000 formulas that is one 516 ms long task, a first display of 1.4 s, and
typing p50 30 ms / p95 64 ms. The candidates were compared on the same documents, measured, and
kept or rejected by the numbers (docs/PERFORMANCE.md, "Editor & web", "Rejected", "Regressions").

## Decision (`apps/web/src/lib/katex.ts`, `lib/mathScheduler.ts`, `components/blocks/Math.tsx`)
1. **Memory LRU** of rendered results per `(displayMode, latex)`, bounded by 2,000 entries and
   8 M characters. A formula is rendered once per tab; scrolling back, eviction and remote edits of
   other blocks insert cached HTML. `MathOutput` is memoized, so typing never re-renders other
   formulas.
2. **Time-sliced rendering** on the main thread: queued renders run in 8 ms slices, yielding with
   `scheduler.yield()` where supported, else a macrotask.
3. **Paced insertion**: finished formulas are handed to React at most 16 per animation frame
   (`INSERTS_PER_FRAME`), in document order. Inserting KaTeX's HTML (commit, style, layout) costs
   more than rendering it; without pacing the worker variant still produced 423–683 ms long tasks
   at 1,000 formulas, with it 169–176 ms (the remainder also occurs in the baseline, from mounting
   1,000 atom node views).
4. **Resident cap**: at most 100 rendered *display* formulas stay in the DOM
   (`MATH_DOM_CAP`). Beyond it, those farthest from the viewport (ties: least recently seen) go back
   to a placeholder that keeps the LaTeX source as text and exactly the last measured box
   (`height` + `overflow: hidden`; `.nd-math-display` is a flow root so the box includes KaTeX's
   margins), so eviction and re-insertion move nothing (scroll CLS 0). Never evicted: visible
   formulas (within the 200 % root margin), formulas in or next to the caret's block, inside the
   selection, or being edited. Inline formulas are not evicted: a placeholder cannot keep their
   baseline. Re-insertion is paced like first renders.
5. **Deferral only from 300 formulas** (`LAZY_THRESHOLD`): on such pages formulas render when they
   come within two screens of the viewport (IntersectionObserver, root margin 200 %); a 5 s
   safety timer renders the rest in the background if no observer fires. Formulas added after the
   page's first batch (typed, pasted, a collaborator's edit) are never deferred. Placeholders hold
   the source as text (find in page, screen readers via `aria-label`) and reserve an estimated
   size (rows from `\\` and `\begin`, more height for `\frac`/`\sum`/…; the measured size once
   known). Nothing touches the editor's contenteditable structure: math nodes are atoms with a
   `contenteditable=false` node view and only their inner content changes (unlike ADR 0850, where
   `content-visibility` on editor blocks lost keystrokes); typing next to deferred math is tested.
6. **Print / PDF**: `beforeprint` renders every pending or evicted formula synchronously inside one
   `flushSync` (editor and share page), so the snapshot is complete. On deferring pages main-thread
   KaTeX is already loaded (it is the renderer).
7. **Block jumps** (`?block=`): the jump is instant and the target is held at its position for 4 s
   while content above still changes size (`lib/pinAnchor.ts`; any user scroll or input releases it).
   Without it a jump into a 800-formula page landed 7,000–17,000 px off target in every variant,
   the synchronous first version included.
8. **Live preview** while editing LaTeX follows the draft after 150 ms without typing and renders
   synchronously (always immediate where the user is working).
9. The server never renders (ADR 0999).

Measurement switches (localStorage, for repeating the runs below; not a user setting):
`inkling:math-mode` = `a` (first version) | `b` (no deferral) | `e` (always defer);
`inkling:math-evict` = `off` | `lru` | `distance`; `inkling:math-cap`; `inkling:math-output` =
`mathml`; `inkling:math-stats` exposes insert/evict counters and a visibility trace.

## Measurements
Headless Chromium (Playwright's build) on an Apple-silicon MacBook Air, production build served by
the app server, viewport 1280×900, a fresh browser profile per run (cold HTTP cache) unless "warm",
1–2 runs per cell (ranges are across runs). Documents: N formulas, half display
(`\sum…\frac…\int…\prod…\left(…\right)`, ≈110 characters, every one distinct), half inline (two per
paragraph), a heading every 10 display blocks; the control document has the same blocks as plain
text. First display: navigation start until no placeholder intersects the viewport. Long tasks:
PerformanceObserver from navigation until 1.5 s after the last render (or 8 s). Typing: click into
the first paragraph, ⌘→, 43 characters at 60 ms; latency = keydown → the next frame
(`requestAnimationFrame` + `setTimeout 0`). CLS: sum of `layout-shift` entries without recent input.
Scroll: "scan" 160 wheel steps of 400 px at 60 ms; "ping-pong" 3 × (40 steps up, 40 down). OPT is
Belady's algorithm on the recorded visibility trace with the same capacity (compulsory misses not
counted). Script: out of tree (Playwright, as for ADR 0700/0708), described here.

| N | Variant | First display | Long tasks on load (count / max) | Typing p50 / p95 | DOM nodes | CLS on load |
|---|---|---|---|---|---|---|
| 100 | first version | 570 ms | 1 / 81 ms | 12.0 / 18.6 ms | 12,836 | 0.07 |
| 100 | shipped | 585–587 ms | 0 | 9.2–9.4 / 13.5–14.2 ms | 12,802 | 0.06–0.065 |
| 500 | first version | 912 ms | 3 / 268 ms | 19.6 / 26.6 ms | 62,020 | 0.069 |
| 500 | shipped | 556–598 ms | 1 / 71–77 ms | 17.2–20.0 / 23.4–26.5 ms | 44,365 | 0.065–0.076 |
| 1,000 | first version | 1,427 ms | 3 / 516 ms | 29.9 / 64.4 ms | 123,656 | 0.07 |
| 1,000 | shipped | 670–685 ms | 1 / 169–171 ms | 21.9–22.3 / 30.1–38.2 ms | 62,080 | 0.071 |
| 1,000 | plain-text control | 411 ms | 0 | 5.0 / 15.3 ms | 3,511 | 0.004 |

"Shipped" rows: 2 runs of the build that still had the IndexedDB layer (cold: every lookup
missed). The final build, which only drops that layer, re-run once: 100 formulas 584 ms / no long
task / 10.3 / 16.2 ms; 500: 543 ms / 1 × 71 ms / 17.1 / 27.4 ms; 1,000: 683 ms / 1 × 169 ms /
18.9 / 30.2 ms, DOM 62,063.

Choices and the numbers behind them:
- **Deferral threshold 300.** With deferral forced vs. off (cache and pacing, worker variant): 100 formulas 510 vs
  589–592 ms first display, 300: 507 vs 760–836 ms, 500: 564 vs 1,224–1,272 ms, 1,000: 698 vs
  2,584–2,616 ms. The gain bends between 100 (1.16×) and 300 (1.5×); below 300 it is not worth the
  cost (all formulas rendered only after ≈5.6 s instead of ≈0.6 s; a scroll-in render).
- **Cap 100 display formulas, distance policy.** At 1,000 formulas (500 display): typing p50
  29.9–30.5 ms without cap, 22.9 ms at cap 100 (distance), 19.9 ms at 50, 23.6 ms at 200.
  Ping-pong re-insertions: cap 50 → 426 (OPT 321), cap 100 → 126 (LRU 129, simulated LRU 106,
  OPT 71), cap 200 → 0. Scan re-insertions at cap 100: distance 237, LRU 301 (500 formulas: 68 vs
  105). Cap 50 thrashes; 200 gives no typing gain over 100.
- **Exact placeholder boxes.** The first cap version reserved `min-height`/`min-width` for evicted
  formulas: scroll CLS 1.2–4.0 (scan) and 6.7–11.4 (ping-pong) at caps 100–200 (500 and 1,000
  formulas). Exact display boxes and no inline eviction: 0 and 0.

## Rejected (measured)
- **Web Worker rendering** (one worker, request queue, cancellation, main-thread fallback): equal to
  main-thread slices once insertion was paced — 1,000 formulas first display 2,584–2,616 ms vs
  2,776 ms, long tasks 169–176 vs 176 ms, typing p50 29.9–30.5 vs 31.1 ms; 500: 1,224–1,272 vs
  1,249 ms. KaTeX takes 0.6 ms for the benchmark formula and ≤ 5.2 ms for 4,000-character worst
  cases (300 nested `\frac`, a 30×10 matrix); the cost is inserting HTML, which a worker cannot
  move. It also cost a second 77 KB (gzip) download. Removed. (A worker's first version yielded
  with `setTimeout`, clamped to 4 ms per formula: 3 s first display at 500 formulas.)
- **Persistent IndexedDB cache** (key: KaTeX version + options + latex + display mode, bounded,
  failures ignored): a second visit (warm) vs a first (cold) — 100 formulas 532 vs 585–587 ms,
  500: 540 vs 556–598 ms, 1,000: 733 vs 670–685 ms (long tasks 218 vs 169–171 ms). Within the
  run-to-run spread or worse: rendering is cheap and the lookups cost about as much. Removed; the
  memory LRU stays.
- **`output: 'mathml'`**: DOM 16,459 vs 62,020 nodes at 500 formulas and typing p50 12.5 vs
  21.5–21.8 ms (1,000: 14.4 vs 29.9–30.5 ms), but Chromium's MathML draws large operators,
  limits and stretchy delimiters visibly wrong (unstretched `∑`, misplaced limits, small
  parentheses) and without KaTeX's fonts. `htmlAndMathml` stays (the MathML part keeps screen
  readers working; the HTML part is `aria-hidden`).
- **Deferral on every page** and **cap 50**, **cap 200**, **LRU policy**: see above.

## Regressions accepted
- CLS on load ≈ 0.06–0.08 on math pages (plain control 0.004): a placeholder holding source text is
  rarely the size of the rendered formula. Reserved sizes are estimates until a formula was seen.
- On pages with ≥ 300 formulas the last off-screen formulas render up to ≈ 6–8 s after opening.
- Typing p50 on a 1,000-formula page is still 4× the plain control (22 vs 5 ms): KaTeX's DOM, even
  capped, makes every relayout dearer.

## Consequences
- Tests: `apps/web/src/lib/mathScheduler.test.ts` (LRU bounds, threshold, placeholder estimates),
  Playwright checks (out of tree): placeholders and evicted formulas keep their source as text and
  `aria-label` and are found by `window.find`; typing next to deferred math is kept; evicted
  placeholders keep their box; a `?block=` jump stays in view; `beforeprint` renders all 800
  formulas in the editor (deferred and evicted) and on the share page.
- Revisit the cap and threshold if KaTeX's output or BlockNote's node views change.
