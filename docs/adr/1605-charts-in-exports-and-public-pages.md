# 1605. Charts in exports and on public pages are tables, inside what is shared

- Status: Accepted; amended by 2440 (a link can show charts, drawn as charts)
- Date: 2026-11-10

## Context
A chart has no stored data (ADR 1600). Exports and public share pages are read without the app, and
a public link must never show anything outside what it shares (ADR 1302).

## Decision
- Plain Markdown file export (single page and zip): each chart becomes its title in bold and a GFM
  table of the aggregate for the exporting member (`charts/render.ts exportFor`: visible collection of
  the page's workspace, a view of it, or the query run as the member). Not available → left out.
  Agent notation keeps the token.
- Public pages (`routes/public.ts`): only on a folder link, and only for a collection that is itself
  in the link's current subtree (`share.pages`), aggregated over `scope = 'shared'` rows with no
  relation titles and no rollups (as `collectionTableMdShared`); a table replaces the chart. A
  single-page link, a collection outside the subtree, a query source or a relation grouping: the chart
  is left out, with no title or count. `publicBlocks` drops chart blocks before `blocksToFullHTML`, so
  the config (ids, query text) never reaches public HTML.
- No SVG on public pages in 0.13 (server rendering deferred, ADR 1601).

## Alternatives considered
- A static SVG rendered on the server: needs React DOM server rendering on the server; a table is
  readable and accessible.
- Show public charts for any collection the page's author can see: would publish rows outside the link.

## Consequences
- Public HTML is cached per page revision for up to 10 minutes; a chart's table can be that old.
- Tests: `charts.db.test.ts` (plain export table without hidden source names, agent export tokens,
  public folder link: table for an inside collection, nothing from an outside one or a query),
  `charts/aggregate.test.ts` (public HTML never carries the config).
