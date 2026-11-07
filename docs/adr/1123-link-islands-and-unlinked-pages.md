# 1123. Link islands and unlinked pages

- Status: Accepted
- Date: 2026-11-07

## Context
The graph view colours nodes by top-level folder and can hide orphans, but it cannot answer two
questions people ask of a growing workspace: which groups of pages link only among themselves
(islands), and which pages nothing links to or from (candidates to connect, merge or trash).

## Decision
- **Islands = connected components** of the link graph, direction ignored, computed by
  union-find (`components()` in `packages/shared/src/unionFind.ts`, ADR 1120): union both ends of
  every link, then group pages by `find()`. Largest island first; an island is named after its
  most linked page.
- **Web** (`components/graph/graphModel.ts`): from the `/graph` data the page already has, no
  extra request. Settings → Groups → "링크 섬별 색" / "Color by link island" (exclusive with folder
  colours); the legend lists the islands and a click shows only that island ("이 섬만 보기",
  not saved). Pages linked only by #tags are grey ("태그로만 연결").
- **Server** `GET /workspaces/:id/graph/islands` (`routes/graph.ts`, `linkIslands.ts`): island
  sizes and members (200 ids per island), and the unlinked pages (no link in or out; folders left
  out — they have no body; newest first, 500 listed, exact total). The graph settings panel shows
  this list under "연결 없는 페이지" / "Unlinked pages" with links to the pages.
- **Same node rules as `/graph`:** live pages the viewer may see (`visibleTo`), collection rows
  excluded; an edge counts only when both ends are in that set.
- **When it is computed / invalidation:** from scratch on every request that is not answered with
  a 304, and the ETag is the graph's own data version — `(user, workspaceVersion, indexEpoch)`,
  the key `/graph` already uses (ADR 0752). Any page create, trash, restore, rename or scope
  change moves `workspaceVersion`; any rewrite of `page_links` (including a link removed by an
  edit) bumps `indexEpoch`. No server-side result cache: the answer is per viewer (private pages)
  and the union-find part is a few milliseconds.

## Why this data structure, and where it does not fit
Union-find is the natural structure for "which component is x in" while edges are only added:
one pass over the links, near-constant time per link, no adjacency lists. It cannot remove an
edge: when a link is deleted, the forest has no way to split the island it joined. So the
structure is never maintained across edits; it is rebuilt per request (O((V + E) α(V))) under a
version key. Keeping islands live under deletions would need a fully dynamic connectivity
structure (e.g. Holm–de Lichtenberg–Thorup), far more code than a rebuild that costs ~3 ms.

Permissions follow from the node set, not from the structure: a link to a page the viewer cannot
see is not an edge for that viewer, so a page whose only link goes to someone else's private page
is "unlinked" for that viewer. Counting the hidden link would tell the viewer that a private
page links there.

## Measured
5,000 pages and 26,000 random links in one workspace (one giant island), Postgres 16 in Docker
on a laptop shared with other work, Node 22.23.4, 20 calls after 3 warm-ups; ranges over 2 runs:

| | p50 | p95 |
|---|---:|---:|
| `linkIslands()` (queries + union-find + list) | 56.5–62.6 ms | 71.8–91.4 ms |
| union-find part alone (`components()`, 5,000 ids, 26,000 edges) | 2.4–2.9 ms | 4.3–7.8 ms |
| `/graph`'s node + link queries (same data, for comparison) | 52.3–56.6 ms | 62.4–66.0 ms |

The database reads dominate; the union-find is ≈ 4–5 % of the request. The link query joins
`pages` instead of passing every page id as a parameter (as `/graph` does); within noise of it.

## Alternatives considered
- **Maintain islands incrementally on link insert** (union-find in memory): breaks on the first
  link removal (no split), per-viewer node sets would need one forest per viewer.
- **Compute islands in SQL** (recursive CTE over `page_links`): far slower on dense graphs and no
  simpler.
- **Add the endpoint to `routes/workspaces.ts` next to `/graph`:** that file was being changed by
  another work stream; a small separate route file keeps the change local.

## Consequences
- One new read endpoint (rate-limited like `/graph`, 60/min per member IP).
- Folders and collection rows never appear as unlinked; a collection page can.
- "Unlinked" ignores #tags (tags are not links); the graph's own orphan colour still counts tag
  links when tag nodes are shown.

## References
- ADR 0710 (graph engine), ADR 0752 (ETags from data versions), ADR 0756 (visibility),
  ADR 1120 (union-find).
