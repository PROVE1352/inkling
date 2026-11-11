# 2444. Public charts only of sources a manager approved

- Status: Accepted
- Amends: 2440, 2441
- Date: 2026-11-11

## Context
ADR 2441 aggregates a public link's charts with the access of the manager who turned them on. Anyone who can
edit the page could then add a chart over a database only that manager can see (a private one, one behind a
page-access override) — `groupBy: title` even lists its row titles — and it would be published under the
manager's name without the manager seeing it. Recording that as a known issue left the hole open.

## Decision
- **Approval list**: `pages.share_chart_sources jsonb` (migration 0061, with the other two columns): the source
  keys of the charts the link shows at the moment a manager turns charts on — `c:<collection id>` for a
  collection or a view of it, `q:<sha-256>` of a query's text with runs of white space made one space and the
  ends trimmed (`charts/publicCharts.ts chartSourceKey`). Read from the same pages as the count (the page; a
  folder link's doc pages inside it, at most 300).
- **Public render**: the enabler path (`exportFor` as the recorded manager) runs only for a chart whose source
  key is in the list. Any other chart — added after the switch, or whose source was changed — is left out with
  its title, as an unavailable chart is. The folder link's own collections (`publicFor`) do not need approval,
  as before 2440.
- **Approve again**: `PATCH /pages/:id/share { approveChartSources: true }` (owners and admins; the route is
  session-only, so no API or MCP token can call it; 409 while charts are off) stores the sources the link's
  charts use now and records the caller as the account the charts are aggregated with. Audited as
  `share.charts_changed` with the number of sources before and after. The dialog shows "N newly added charts
  are not public yet" with **Publish these charts too** (`ShareStatusDTO.charts.pending`).
- **Clearing**: turning charts off and unpublishing (`CLEARED_SHARE_LINK`) clear the list; a new link has none.
- **Cache**: the render cache key carries a fingerprint of the list (with the enabler), so an approval shows at
  the next request.
- **Unit of approval is the source**, not the chart: once a database is approved, an editor's new chart of it —
  grouped or measured by any of its properties, through any of its views — is published without another
  approval. The dialog says so: "Turning this on approves the databases the charts use now: their labels and
  numbers are published as charts."

## Alternatives considered
- **Approve each chart (its whole config)**: an editor could not even change a chart's title or kind without
  taking it off the public page; the question a manager answers is "may this database be shown", not "this
  bar chart".
- **Aggregate as the chart's last editor**: blocks know no author per block, and a member's access could still
  differ from what the manager meant to publish.
- **Only the database's shared rows (as `publicFor`)**: private rows are only the author's own; the hole is
  databases the editor cannot see at all, which this would still publish.
- **Keep it as a known issue** (2441's trade-off): the coordinator's call was to close it.

## Trade-offs
- A chart over an approved database can still publish another of its properties (e.g. row titles) that no
  approved chart showed. Recorded in KNOWN-ISSUES.
- A query's approval is its exact text (modulo white space): reformatting a query in other ways makes it wait.

## Consequences
- `ShareStatusDTO.charts` gains `pending` (`hidden` includes it).
- Tests: `charts/publicCharts.db.test.ts` ("approved sources only": a member adds a chart of a database only
  Alice can see → nothing of it in the public answer, pending 1; a new chart of an approved database and an
  approved query written with other spaces show at once; another query text waits; a member and a token cannot
  approve; an admin who cannot see the database approves → still out; Alice approves → shown; off and
  unpublish clear the list), browser check step 8.

## References
- `apps/server/src/charts/publicCharts.ts`, `apps/server/src/routes/pages.ts`, `apps/server/src/routes/public.ts`,
  `apps/web/src/components/ShareChartsOption.tsx`, ADR 2440, 2441, 2443
