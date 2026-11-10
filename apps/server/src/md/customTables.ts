/**
 * Tables that stand for blocks whose numbers are computed when they are read: inline database views
 * (page embeds of a collection, docs/adr/2120-*) and query blocks (```dataview fences). Used by the
 * file export (md/fileExport.ts, docs/adr/2122-*) and by public pages (routes/publicBlocks.ts,
 * docs/adr/2121-*); each caller decides whose rows these are.
 */
import { asc, eq } from 'drizzle-orm'
import { chartAggregateInput, chartTableMarkdown, isQueryPageRef } from '@inkling/shared'
import type { ChartBlockConfig, ChartDataDTO, QueryResultDTO, QueryRowDTO, ViewConfig, ViewType } from '@inkling/shared'
import { db } from '../db/index'
import { collectionViews } from '../db/schema'
import { collectionViewTableMd, collectionViewTableMdPublic } from './exporter'
import { aggregateCollection } from '../charts/aggregate'

/** Rows of a database view written into a file export / onto a public page at most. */
export const EXPORT_VIEW_MAX_ROWS = 1000
export const PUBLIC_VIEW_MAX_ROWS = 200

export interface EmbedView {
  id: string
  name: string
  type: ViewType
  config: ViewConfig
}

/**
 * The view an inline database view shows: `viewId` when it is a view of `collectionId`, else the
 * collection's first view (`missing` says the saved one is gone), or null when it has no views.
 */
export async function loadEmbedView(collectionId: string, viewId: string): Promise<{ view: EmbedView | null; missing: boolean }> {
  const list = await db
    .select({ id: collectionViews.id, name: collectionViews.name, type: collectionViews.type, config: collectionViews.config })
    .from(collectionViews)
    .where(eq(collectionViews.pageId, collectionId))
    .orderBy(asc(collectionViews.sortOrder), asc(collectionViews.createdAt))
  const views = list.map((v) => ({ ...v, config: (v.config ?? {}) as ViewConfig })) as EmbedView[]
  const found = viewId ? views.find((v) => v.id === viewId) : undefined
  return { view: found ?? views[0] ?? null, missing: !!viewId && !found }
}

export type ViewReader =
  | { kind: 'user'; userId: string; workspaceId: string }
  /** public page: shared rows that `keep` says are inside the link */
  | { kind: 'public'; workspaceId: string; keep: (rowId: string) => boolean }

/**
 * A database view as Markdown: a chart view's numbers (as the chart block's table), any other view
 * as a table of its rows (filters, order, columns). Throws what the readers throw.
 */
export async function viewTableMarkdown(collection: { id: string; title: string }, view: EmbedView | null, reader: ViewReader): Promise<string> {
  if (view?.type === 'chart' && view.config.chart) {
    const cfg: ChartBlockConfig = { ...view.config.chart, source: { type: 'collection', collectionId: collection.id, viewId: view.id } }
    const { source: _source, ...input } = chartAggregateInput(cfg)
    const data: ChartDataDTO = await aggregateCollection(
      { collectionId: collection.id, workspaceId: reader.workspaceId, title: collection.title, view: { name: view.name, config: view.config } },
      input,
      reader.kind === 'user' ? { kind: 'user', userId: reader.userId } : { kind: 'public' },
    )
    return chartTableMarkdown(data, { empty: 'No value' })
  }
  const opts = { ...(view ? { view: view.config, viewType: view.type } : {}) }
  return reader.kind === 'user'
    ? collectionViewTableMd(collection.id, reader.userId, { ...opts, maxRows: EXPORT_VIEW_MAX_ROWS })
    : collectionViewTableMdPublic(collection.id, { ...opts, keep: reader.keep, maxRows: PUBLIC_VIEW_MAX_ROWS })
}

/** Text that is literal inside a GFM table cell (no markup, no HTML, no column break). */
export function mdCell(s: string): string {
  return s.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/[\r\n]+/g, ' ')
}

function cellText(v: unknown, refTitle: (pageId: string, title: string) => string | null): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => cellText(x, refTitle)).filter(Boolean).join(', ')
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (isQueryPageRef(v)) return refTitle(v.pageId, v.title || 'Untitled') ?? ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export interface QueryTableOptions {
  /** the page cell of a row (Markdown, already escaped) */
  page: (row: QueryRowDTO) => string
  /** a linked page's title in a relation cell, or null to leave it out */
  refTitle: (pageId: string, title: string) => string | null
}

/** A query block's result as Markdown: a GFM table (TABLE, LIST, TASK) or a line saying it is empty. */
export function queryResultMarkdown(r: Pick<QueryResultDTO, 'type' | 'withoutId' | 'columns' | 'rows'>, opts: QueryTableOptions): string {
  if (!r.rows.length) return '_No results_\n'
  let head: string[]
  let body: string[][]
  if (r.type === 'TASK') {
    head = ['Task', 'Due', 'Page']
    body = r.rows.map((row) => [mdCell(`${row.task?.checked ? '✅ ' : '⬜ '}${row.task?.text ?? ''}`), mdCell(row.task?.due ?? ''), opts.page(row)])
  } else {
    const cols = r.type === 'LIST' ? (r.columns.length ? ['value'] : []) : r.columns
    head = [...(r.withoutId ? [] : ['Page']), ...cols.map(mdCell)]
    body = r.rows.map((row) => [
      ...(r.withoutId ? [] : [opts.page(row)]),
      ...cols.map((_, i) => mdCell(cellText(row.cells[i], opts.refTitle))),
    ])
  }
  if (!head.length) head = ['Page']
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((c) => `| ${c.join(' | ')} |`)]
  return lines.join('\n') + '\n'
}

/** A query source of a code block (the query block is a ```dataview fence, docs/adr/0204-*). */
export function queryBlockSource(b: { type?: string; props?: Record<string, unknown>; content?: unknown }): string | null {
  if (b.type !== 'codeBlock' || b.props?.language !== 'dataview') return null
  const c = b.content
  if (!Array.isArray(c)) return null
  const text = c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('')
  return text.trim() ? text : null
}
