# 2442. Public charts are drawn in the browser from labels and numbers, a table underneath

- Status: Accepted
- Amends: 1605, 1601
- Date: 2026-11-11

## Context
ADR 1605 showed a public chart as a table because drawing needed the chart library, which only the web app
has (ADR 1601), and public HTML must never carry the chart's config. Visitors of a shared report expect the
chart they saw in the app; crawlers, readers without scripts, screen readers and Markdown downloads still
need the numbers as text.

## Decision
- **Server**: each chart that has data (ADR 2441) becomes two ordinary blocks before `blocksToFullHTML`: its
  title in bold (when it has one) and a GFM table of the aggregate, whose block ids are a per-render anchor —
  `ic-<12 hex>-<n>` and `…-t` (the HTML's `data-id`). The anchor is random per render so no block written into
  a page can stand in for a chart. The page response gains `charts: PublicChartDTO[]` — `anchor`, `kind`,
  `title?`, `group` and `series?` (property display names), `measure {fn, name?}`, `groups` and
  `seriesKeys?` as `{label, special?}`, `values`, `omittedGroups`, `omittedSeries`, `truncated?`
  (`packages/shared/src/charts.ts publicChartOf`). The table is written from that same public form
  (`chartDataOfPublic` → `chartTableMarkdown`), so table and chart carry exactly the same text. Library
  options from the config are not sent. `md/convert.ts publicBlocks` still drops any chart block left.
- **Web**: `lib/publicCharts.ts renderPublicChartsIn(root, charts, theme)` (after the client sanitizer, like
  Mermaid, ADR 2191) finds each chart's table by anchor, then imports the chart chunk
  (`components/charts/PublicChartMount.tsx` + its CSS) only when a page has charts. It draws the app's own
  `ChartRender` (the same chunk the editor loads) through the same adapter (`toChartSpec`) in front of the
  table, inside a bordered figure with title and caption, and hides title and table with a clip (not
  `display: none`), so screen readers keep the table. A chart that cannot be drawn leaves its table visible.
  Charts are drawn at once (`animateOnView: false`), not when scrolled into view, so printing shows every one;
  "Save as PDF" waits for charts still loading (`printWhenReady` → `publicChartsIdle`). While printing
  (`beforeprint`, or the print media query, which Chrome also matches for its own PDF) every chart is drawn
  again in the light palette without animation, because print.css puts the page on white paper in either
  theme; `afterprint` restores the page's theme.
- **Presentation**: `Presentation` takes `charts` and draws them on the slide copies (the same call).
- **Print**: the SVG has a viewBox and 100% width; print CSS removes the clip of the plot box and caps the
  SVG at the paper width, so a chart drawn in wide view is scaled, not cut.
- **Markdown download**: the same blocks (title + table), as before.
- **Old clients**: a cached 0.19 client ignores `charts` and shows the tables, as 1605.

## Alternatives considered
- **Server-rendered SVG** (`react-dom/server` + the library on the server): one more dependency path on the
  server (ADR 1601 kept the library out of it), inline SVG through the public HTML sanitizer, and no keyboard
  or tooltip; the browser already has the library and the data is small.
- **Tables only (keep 1605)**: no new code, but not what the publisher shared.
- **Send the config and let the page call the aggregate route**: the config carries ids and query text, and
  the route needs a member.
- **Mount with React portals inside `dangerouslySetInnerHTML`**: the body HTML is replaced on every new
  revision; a separate root per placeholder (as the diagrams) has a clear cleanup and serves the slides too.

## Consequences
- Bundle (PERFORMANCE.md, gzip, against 0.19.1): entry +267 B (its static closure +84 B), PublicView chunk
  +33 B and its static closure +802 B (the Presentation chunk carries `lib/publicCharts.ts` and the chart
  chunk's preload list); a page with charts additionally loads `PublicChartMount` 1.4 kB, its CSS 0.2 kB, the
  adapter 1.0 kB and `ChartRender` 50.8 kB (byte-identical to 0.19.1); a page without charts loads none of the
  chart code. The adapter is now its own chunk shared by the editor (CollabEditor −770 B) and the public chart
  chunk; the app's idle warm-up of the editor chunk fetches it on every page, as it fetched the editor before.
- Tests: `apps/web/src/components/charts/publicChart.test.ts` (public form keeps labels and numbers only;
  every kind gives the app's spec and passes the library's validateSpec; the table equals the export table;
  anchors are never put in a selector unless well-formed), `charts/publicCharts.db.test.ts` (anchors in the
  HTML, DTO keys, whole-response string checks), browser check (drawn SVG, bars, hidden tables, print,
  presentation, 390 px, dark, no chunk without charts).

## References
- `apps/server/src/charts/publicCharts.ts`, `apps/server/src/routes/public.ts`,
  `apps/web/src/lib/publicCharts.ts`, `apps/web/src/components/charts/PublicChartMount.tsx`,
  `apps/web/src/pages/PublicView.tsx`, ADR 1601, 1605, 2191, 2361, 2440
