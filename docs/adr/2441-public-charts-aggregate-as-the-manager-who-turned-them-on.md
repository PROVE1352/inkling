# 2441. Public charts are aggregated as the manager who turned them on, while a member

- Status: Accepted
- Date: 2026-11-11

## Context
A public visitor has no account, so a chart outside the link (ADR 2440) needs someone's access to be
computed with. The Markdown export already aggregates charts "as the exporting member" (`charts/render.ts
exportFor`, ADR 1605): a collection of the page's workspace the member can see and a view of it, or a query
run as the member.

## Decision
- **Who**: the account recorded in `pages.share_charts_by` when the switch was turned on. Per chart, first
  match (`charts/publicCharts.ts publicChartData`):
  1. that person, through `exportFor(person, workspaceId)` — the export's own path and checks, so its
     sources are the export's: a collection or a view of a collection of this workspace, relation and rollup
     groupings as the export resolves them for that person, and query sources run as that person;
  2. on a folder link, `publicFor` (ADR 1605): a collection inside the link, shared rows, no relation titles —
     so turning the switch on, or the person losing access, never removes a chart the link showed before;
  3. nothing: the chart is left out with its title (its children stay).
- **While a member**: `chartsEnabler` reads `workspace_members` for that person on every request, before
  the render cache (ADR 2443). A guest's page grants do not count: someone removed from the workspace stops
  publishing at the next request even if they keep grants. A deleted account clears the column (`set null`).
  A demoted member (admin → member) still counts: they can still see the sources, and the setting is not
  theirs to change any more, only to lose.
- **Always out**: a source in another workspace (`exportTarget` compares the collection's workspace with the
  page's; queries run in the page's workspace), whatever the person can see; anything the person cannot see
  now (private to someone else, trashed, outside a page-access override).
- The aggregate runs outside any request context (no token range, no agent connection), like a member's
  export from the browser.

## Alternatives considered
- **The page's author, or the link's creator**: neither chose to publish numbers; the switch is the choice.
- **Whoever views the dialog last / the current owner**: changes silently with people; the recorded person is
  shown in the dialog ("worked out with Owner's access") and changes only when a manager turns it off and on.
- **Shared rows only, as `publicFor`** for every collection: a chart of a collection outside the link would
  be computed over rows the link does not share either way; the export's path is the one members already
  trust for "a member's numbers outside the app".
- **No query sources**: they are the export's; leaving them out would make the public page differ from the
  file the same member downloads.

## Trade-offs
- **Confused deputy, by design**: anyone who can edit a page whose link has the switch on can add a chart that
  is aggregated with the recorded person's access, including `groupBy: title` (row titles as labels) of a
  collection that editor cannot see, if they know its id. The output is the chart's labels and numbers on the
  public page. Mitigations: only managers turn it on, the dialog names whose access is used, and the switch
  belongs to one link; a page's editors are usually the people who could see the sources anyway. Recorded in
  KNOWN-ISSUES.
- A collection made private, trashed or moved out of reach shows on the public page until the page's cached
  render expires (at most 10 minutes, ADR 2443); losing membership applies at once.

## Consequences
- Tests: `charts/publicCharts.db.test.ts` (as the recorded person: collection, view filter, series, sum, query
  source; another workspace left out for a person who can see it; the person removed → charts gone from a
  warm cache; a source made private → gone at the next render, dialog count follows; folder link falls back
  to its own collections).

## References
- `apps/server/src/charts/publicCharts.ts`, `apps/server/src/charts/render.ts` (`exportTarget`, `exportFor`,
  `publicTarget`, `publicFor`), ADR 1302, 1602, 1605, 2440, 2443
