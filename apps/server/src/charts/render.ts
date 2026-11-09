/**
 * Chart blocks outside the app (docs/adr/1605-*): plain Markdown exports and public share pages get
 * the chart's numbers as a table, computed for whoever is reading.
 *
 *  - export (`exportFor`): the exporting member, through the same checks as the aggregate route
 *    (visible collection of the page's workspace, a view of it, query run as the member);
 *  - public page (`publicFor`): only a collection that is itself inside what the link shares
 *    (the folder's current subtree), rows with `scope = 'shared'`, no relation titles
 *    (docs/adr/1302-* — nothing outside the link). Query sources and anything else are left out.
 *
 * A chart whose data cannot be shown is removed (its children stay), like embeds on these paths.
 */
import { eq } from 'drizzle-orm'
import { chartAggregateInput, chartTableMarkdown, parseChartBlockConfig } from '@inkling/shared'
import type { ChartBlockConfig, ChartDataDTO, ViewConfig } from '@inkling/shared'
import { db } from '../db/index'
import { collectionViews } from '../db/schema'
import { markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { findVisiblePage } from '../pageDto'
import { aggregateCollection, aggregateQuery } from './aggregate'

export type ChartDataFn = (cfg: ChartBlockConfig) => Promise<ChartDataDTO | null>

/** Any chart block at any depth (callers skip their chart work, and its queries, without one). */
export function hasChartBlocks(blocks: AnyBlock[]): boolean {
  return blocks.some((b) => b.type === 'chart' || (Array.isArray(b.children) && hasChartBlocks(b.children)))
}

async function loadView(viewId: string, collectionId: string): Promise<{ name: string; config: ViewConfig } | null> {
  const [v] = await db
    .select({ pageId: collectionViews.pageId, name: collectionViews.name, config: collectionViews.config })
    .from(collectionViews)
    .where(eq(collectionViews.id, viewId))
    .limit(1)
  return v && v.pageId === collectionId ? { name: v.name, config: (v.config ?? {}) as ViewConfig } : null
}

/**
 * Replaces each chart block (any depth) with a table of its data, or removes it when `dataFor`
 * gives null or fails. Returns the list (mutated in place).
 */
export async function chartsToTables(blocks: AnyBlock[], dataFor: ChartDataFn): Promise<AnyBlock[]> {
  if (!hasChartBlocks(blocks)) return blocks
  const walk = async (list: AnyBlock[]): Promise<AnyBlock[]> => {
    const out: AnyBlock[] = []
    for (const b of list) {
      if (b.type !== 'chart') {
        if (Array.isArray(b.children) && b.children.length) b.children = await walk(b.children)
        out.push(b)
        continue
      }
      const children = Array.isArray(b.children) ? await walk(b.children) : []
      const cfg = parseChartBlockConfig(b.props?.config)
      let data: ChartDataDTO | null = null
      if (cfg) {
        try {
          data = await dataFor(cfg)
        } catch {
          data = null
        }
      }
      if (cfg && data) {
        const title = cfg.title ? `**${cfg.title.replace(/[*_`[\]\\]/g, '\\$&')}**\n\n` : ''
        out.push(...(await markdownToBlocks(`${title}${chartTableMarkdown(data, { empty: 'No value' })}`, () => null)))
      }
      out.push(...children)
    }
    return out
  }
  const next = await walk(blocks)
  blocks.splice(0, blocks.length, ...next)
  return blocks
}

/** Data of a chart for a member exporting a page of `workspaceId`. */
export function exportFor(userId: string, workspaceId: string): ChartDataFn {
  return async (cfg) => {
    const input = chartAggregateInput(cfg)
    const { source, ...rest } = input
    if (source.type === 'query') {
      return aggregateQuery(userId, workspaceId, source.query, rest, new Date().toISOString().slice(0, 10), 0)
    }
    const page = await findVisiblePage(source.collectionId, userId)
    if (!page || page.kind !== 'collection' || page.workspaceId !== workspaceId) return null
    const view = source.viewId ? await loadView(source.viewId, page.id) : undefined
    if (view === null) return null
    return aggregateCollection({ collectionId: page.id, workspaceId, title: page.title, ...(view ? { view } : {}) }, rest, { kind: 'user', userId })
  }
}

/**
 * Data of a chart on a public page. `shared(id)` answers the collection page when it is inside
 * what the link shares (a live, shared page of the same workspace), else null.
 */
export function publicFor(
  workspaceId: string,
  shared: (pageId: string) => { id: string; kind: string; title: string; workspaceId: string } | null | undefined,
): ChartDataFn {
  return async (cfg) => {
    if (cfg.source.type !== 'collection') return null
    const page = shared(cfg.source.collectionId)
    if (!page || page.kind !== 'collection' || page.workspaceId !== workspaceId) return null
    const view = cfg.source.viewId ? await loadView(cfg.source.viewId, page.id) : undefined
    if (view === null) return null
    const { source: _source, ...rest } = chartAggregateInput(cfg)
    return aggregateCollection({ collectionId: page.id, workspaceId, title: page.title, ...(view ? { view } : {}) }, rest, { kind: 'public' })
  }
}
