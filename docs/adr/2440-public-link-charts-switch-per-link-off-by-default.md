# 2440. Charts on a public link: a per-link switch, off by default

- Status: Accepted
- Amends: 1605
- Date: 2026-11-11

## Context
A chart stores its settings, not its data (ADR 1600). ADR 1605 kept public pages inside ADR 1302 ("nothing
outside what the link shares"): a folder link shows a chart of a collection inside the link as a table, and a
single-page link drops every chart without a word. Most charts are about a database somewhere else in the
workspace, so a report shared as one page lost all of its charts, and the person who shared it was not told.

## Decision
- **Setting**: `pages.share_include_charts boolean not null default false` and `pages.share_charts_by uuid`
  (→ `users.id`, `on delete set null`), migration 0061, next to the download setting (ADR 2362). Only
  `PATCH /pages/:id/share` `{ includeCharts }` changes it, with the rule of the other link settings
  (owners and admins of the workspace; the route is session-only, so no API or MCP token can call it,
  `tokenPolicy.ts SESSION_ONLY`), audited as `share.charts_changed` with before/after. Turning it on records
  the caller in `share_charts_by` (ADR 2441); sending `true` while it is on keeps the recorded person;
  turning it off clears both. Creating a link never sets it (`createShareSchema` is strict, the insert
  writes `false`/`null`); unpublishing clears it (`CLEARED_SHARE_LINK`), so a re-published link starts off.
- **What it publishes**: for each chart of the page(s) the link shows, its title, kind and aggregate as
  labels and numbers (`PublicChartDTO`, ADR 2442). Never the block's config: collection, view and field ids,
  query text, library options, group keys (option, member and row ids), the collection's or view's name, or
  rows other than as group labels.
- **Off** (every existing link after the upgrade): as ADR 1605, except that a folder link's charts of its own
  collections are drawn as charts (ADR 2442) instead of tables.
- **Folder links**: the switch is the folder's, for every page inside it (as the download).
- **Status**: `ShareStatusDTO` gains `includeCharts`, `chartsBy` (the recorded person's name, while on) and
  `charts: { total, hidden }` — chart blocks of the page (a folder: its doc pages inside the link, at most
  300) and how many the public page leaves out with the current setting. GET answers it before a link exists
  (the setting is off then), POST and PATCH with their responses, so the dialog's count follows the switch.
  It is counted from the configs and whether their sources resolve (`exportTarget` / `publicTarget`), never
  by aggregating; only documents whose stored bytes contain the block name are decoded. Measured on 300 doc
  pages of 60 kB: 26 ms with one chart, 75 ms with 30 pages holding a chart, 361 ms when all 300 do (median of
  6, local Postgres; 330 ms for the 30-chart folder before the byte filter).
- **Dialog**: "N charts on this page do not show on the public link", the switch (managers) and what it
  publishes ("labels and numbers; the rows behind them are not shared; worked out with the access of whoever
  turns this on; up to 10 minutes old"), `components/ShareChartsOption.tsx`.

## Alternatives considered
- **Always show charts on public pages**: every existing link would start publishing numbers from
  databases outside it on upgrade, without anyone choosing it.
- **Keep ADR 1605 (tables, inside the link only)**: safe, but the common case — a report page about a
  workspace database — stays empty, and the publisher has no way to say "yes, publish these numbers".
- **A per-chart switch in the chart's settings**: finer, but a setting in the document travels with copies,
  templates and duplicates into pages shared by other people; the link is where publishing is decided.
- **A per-workspace switch**: links differ (a public dashboard vs. a review copy), as for downloads.

## Consequences
- Upgrade: migration 0061; existing links keep the 1605 behaviour (switch off) until a manager turns it on.
- Tests: `charts/publicCharts.db.test.ts` (off by default and nothing of a chart in the page then; managers
  only, audited, kept on resend; the gate first; off again at once; cleared on unpublish; count before a link),
  `shareAccess.test.ts`.

## References
- `apps/server/src/routes/pages.ts` (POST/PATCH/GET share), `apps/server/src/shareSettings.ts`,
  `apps/server/src/charts/publicCharts.ts`, ADR 1302, 1600, 1605, 2362, 2441, 2442, 2443
