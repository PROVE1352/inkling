import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { components } from '@inkling/shared'
import { db } from './db/index'
import { pageLinks, pages } from './db/schema'
import { visibleTo } from './pageDto'

/**
 * Link islands and unlinked pages of a workspace, as one viewer sees it (docs/adr/1123-*).
 *
 * Node set = the graph view's node set (GET /workspaces/:id/graph): live pages the viewer may see
 * (visibleTo: shared pages + the viewer's own private pages), collection rows excluded. Edges =
 * page_links with both ends in that set, taken as undirected. Islands = connected components,
 * found with union-find (union every edge, then group by find()).
 *
 * Computed from scratch on every call that the HTTP layer does not answer with a 304. Union-find
 * cannot take a union back, so a deleted link could not be removed from a maintained structure —
 * an incremental version would need a fully dynamic connectivity structure for a list that costs
 * O((V + E) α(V)) to rebuild. The route's ETag is the graph's own data version (workspaceVersion +
 * indexEpoch: every page create/trash/restore/rename/scope change and every page_links rewrite
 * changes it), so an unchanged graph costs one version query.
 *
 * Permissions: a link to a page the viewer cannot see is not an edge for that viewer, so a page
 * whose only link goes to someone else's private page is "unlinked" for that viewer. Counting that
 * hidden link instead would tell the viewer that a private page links here.
 */

export interface IslandPage {
  id: string
  title: string
  icon: string | null
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  updatedAt: string
}

export interface LinkIslands {
  /** Pages in the node set (folders included, like the graph). */
  pages: number
  links: number
  /** Islands of two or more pages, largest first. */
  islands: { size: number; hub: { id: string; title: string }; pageIds: string[] }[]
  /** Pages with no link in or out (folders excluded: they have no body to link from), newest first. */
  unlinked: IslandPage[]
  unlinkedTotal: number
}

const MAX_UNLINKED = 500
const MAX_ISLAND_IDS = 200

export async function linkIslands(workspaceId: string, userId: string): Promise<LinkIslands> {
  const parent = alias(pages, 'parent')
  const nodeRows = await db
    .select({ id: pages.id, title: pages.title, icon: pages.icon, kind: pages.kind, updatedAt: pages.updatedAt })
    .from(pages)
    .leftJoin(parent, eq(pages.parentId, parent.id))
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        isNull(pages.deletedAt),
        visibleTo(userId),
        or(isNull(pages.parentId), ne(parent.kind, 'collection')),
      ),
    )
  const ids = nodeRows.map((r) => r.id)
  const inSet = new Set(ids)
  // Links whose source is a live page of the workspace (a join, not an id list of every page);
  // both ends are then checked against the viewer's node set.
  const src = alias(pages, 'src')
  const linkRows = ids.length
    ? await db
        .select({ s: pageLinks.sourcePageId, t: pageLinks.targetPageId })
        .from(pageLinks)
        .innerJoin(src, eq(src.id, pageLinks.sourcePageId))
        .where(and(eq(src.workspaceId, workspaceId), isNull(src.deletedAt)))
    : []
  const edges: [string, string][] = []
  const degree = new Map<string, number>()
  for (const l of linkRows) {
    // Both ends must be pages this viewer sees: a private page's or a collection row's links are
    // not edges for anyone who cannot see that page.
    if (!inSet.has(l.s) || !inSet.has(l.t) || l.s === l.t) continue
    edges.push([l.s, l.t])
    degree.set(l.s, (degree.get(l.s) ?? 0) + 1)
    degree.set(l.t, (degree.get(l.t) ?? 0) + 1)
  }
  const { groups } = components(ids, edges)
  const byId = new Map(nodeRows.map((r) => [r.id, r]))

  const islands: LinkIslands['islands'] = []
  for (const g of groups) {
    if (g.length < 2) break // largest first: the rest are single pages
    let hub = g[0]
    for (const id of g) if ((degree.get(id) ?? 0) > (degree.get(hub) ?? 0)) hub = id
    islands.push({ size: g.length, hub: { id: hub, title: byId.get(hub)!.title }, pageIds: g.slice(0, MAX_ISLAND_IDS) })
  }

  const unlinkedRows = nodeRows
    .filter((r) => !degree.has(r.id) && r.kind !== 'folder')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
  return {
    pages: ids.length,
    links: edges.length,
    islands,
    unlinked: unlinkedRows.slice(0, MAX_UNLINKED).map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      kind: r.kind,
      updatedAt: r.updatedAt.toISOString(),
    })),
    unlinkedTotal: unlinkedRows.length,
  }
}
