# 1511. read_ink renders strokes to PNG on the server, with the web layer's geometry and no dependency

- Status: Accepted
- Date: 2026-11-09

## Context
An agent cannot use stroke JSON (thousands of `[x, y, pressure]` triples); models read pictures.
The server has no canvas or image library, and the dependency policy (0882) rules out adding one
(node-canvas, sharp, resvg) for this. The picture must match what people see: the web layer draws
each stroke as a filled outline built by `strokePath` (smoothing, pressure width, tapered ends,
quadratic Béziers through midpoints) in an SVG whose viewBox is 896 logical px wide, pens opaque,
highlighters at opacity 0.32.

## Decision
- **One geometry.** `strokePath` and its outline computation moved unchanged from
  `apps/web/src/lib/inkStroke.ts` to `packages/shared/src/inkStroke.ts`; the web file re-exports it.
  A new `strokeOutline()` returns the outline as data (`dot` or `left`/`right` point lists) and
  `strokePath()` builds its string from it; the output is byte-identical to the old function
  (checked on 20,000 random strokes).
- **Rasteriser** (`apps/server/src/ink/render.ts`): quadratic segments flattened to at most 16
  lines each, dots to 8–64-gons, filled with a scanline rasteriser: nonzero winding (SVG's default
  fill rule), 4 sub-scanlines per pixel row, exact horizontal coverage at span ends, coverage
  clamped to 1 per stroke so a self-overlapping highlighter is not darker (like `<path opacity>`).
  Strokes composited in stored order onto white in sRGB, as browsers do.
- **Eraser**: the web eraser removes whole strokes from the stored list (`eraseAt`), so drawing what
  is stored is exactly what people see; there is no eraser stroke to render.
- **PNG** (`apps/server/src/ink/png.ts`): 8-bit RGB, per-row None/Sub/Up filter by the usual
  minimum-sum heuristic, `node:zlib` deflate level 6, own CRC-32; no time or text chunks, so the
  same strokes give the same bytes (0937).
- **Size**: scale 1 = 896 px wide. The height is not stored (the web takes it from the DOM), so a
  call renders from `top` (default 0) to just below the lowest stroke, or the `height` asked for.
  Images are at most 1,600 px high; at most 3 per call; the answer says `read_ink(pageId, top=N)`
  for the rest. `scale` 0.25–2.
- Only the ink is drawn, not the page text under it: rendering the body would need a browser. The
  answer says so and gives y positions; the text comes from `read_page`.

## Alternatives considered
- **Return SVG** (paths are already strings): many MCP clients pass only PNG/JPEG/WebP/GIF images
  to the model; SVG would arrive as text.
- **Headless browser screenshot** (body plus ink): a browser on the server, seconds per call.
- **A rendering dependency**: against 0882 for a feature this size.
- **Supersample 4×4 in both directions**: four times the horizontal samples for edges that exact span coverage already gets right (not measured).

## Consequences
- Measured on an Apple M4 (docs/PERFORMANCE.md): a typical note page (300 strokes) ~31 ms; a dense
  page near the 8 MiB save limit (2,000 strokes × 80 points, 3 images) ~221 ms; synthetic 4,000 ×
  150 points ~664 ms. Rendering is synchronous on the event loop; the worst realistic case is the
  dense page. Compared with Chrome rendering the same paths: mean per-channel difference 0.24/255,
  differences above 16 levels only on anti-aliased edges (12.5 % of inked pixels).
- A change to the brush (strokePath) changes both renderers at once.
- Tests: `apps/server/src/ink/render.test.ts` (PNG round trip and CRC, colours, highlighter blend,
  dots, scale, tiles and `nextTop`, malformed strokes, determinism).
