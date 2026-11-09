/**
 * Chart aggregation (docs/adr/1602-*): group the rows of a collection (optionally through one of its
 * views' filters) or of a query block's result, and measure each group.
 *
 * Rows are read the way GET /pages/:id/collection reads them (children of the collection, live,
 * `visibleTo(viewer)`), but only the properties the chart needs are selected
 * (`jsonb_build_object`), inside a transaction with the collection query's statement timeout.
 * Relation cells are reduced to visible links and rollups computed by resolveRelations (only when
 * a relation or rollup field is involved); person groups are member names, never ids (C-L11). The
 * view filters, the keys and the measuring are the shared pure functions (packages/shared charts.ts),
 * so the web views and the chart agree on what a filter matches.
 *
 * A public viewer (share pages, routes/public.ts) reads `scope = 'shared'` rows and gets no
 * relation titles, like the public collection table (md/exporter.ts collectionTableMdShared).
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import {
  aggregateItems,
  CHART_GROUP_TYPES,
  CHART_MEASURE_TYPES,
  CHART_TITLE_FIELD,
  chartMeasureOf,
  chartNumber,
  collectionKeys,
  matchesViewFilters,
  naturalOrder,
  queryCellKeys,
} from '@inkling/shared'
import type { ChartAggregateInput, ChartAxisDTO, ChartDataDTO, ChartDimension, ChartItem, CollectionField, ViewConfig } from '@inkling/shared'
import { db } from '../db/index'
import { collections, pages, users } from '../db/schema'
import { AppError } from '../errors'
import { isWorkspaceMember, resolveRelations } from '../collectionRelations'
import { visibleTo } from '../pageDto'
import { runWorkspaceQuery } from '../routes/query'
import { rangeCacheKey } from '../tokenRange'
import { workspaceVersion } from '../versions'

export const AGGREGATE_STATEMENT_TIMEOUT_MS = 3000
const CACHE_MAX = 200
const CACHE_TTL_MS = 60_000

export type ChartViewer = { kind: 'user'; userId: string } | { kind: 'public' }

export const invalidChart = (message: string) => new AppError(400, 'INVALID_CHART', message)

interface CacheEntry {
  at: number
  version: string
  result: ChartDataDTO
}
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string, version: string): ChartDataDTO | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.version !== version || Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.result
}

function cachePut(key: string, version: string, result: ChartDataDTO): void {
  cache.set(key, { at: Date.now(), version, result })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Tests: forget cached results. */
export function clearChartCache(): void {
  cache.clear()
}

type Dim = { field: CollectionField | typeof CHART_TITLE_FIELD; bucket?: ChartDimension['bucket'] }

function resolveDimension(fields: CollectionField[], d: ChartDimension, what: string): Dim {
  if (d.field === CHART_TITLE_FIELD && !fields.some((f) => f.id === CHART_TITLE_FIELD)) return { field: CHART_TITLE_FIELD }
  const f = fields.find((x) => x.id === d.field)
  if (!f) throw invalidChart(`${what}: no property with id "${d.field}" in this collection`)
  if (!CHART_GROUP_TYPES.has(f.type)) throw invalidChart(`${what}: a ${f.type} property cannot group a chart`)
  if (d.bucket && f.type !== 'date') throw invalidChart(`${what}: day / week / month grouping needs a date property`)
  return { field: f, ...(d.bucket ? { bucket: d.bucket } : {}) }
}

function axis(dim: Dim): ChartAxisDTO {
  if (dim.field === CHART_TITLE_FIELD) return { field: CHART_TITLE_FIELD, name: 'Title', type: 'title' }
  return { field: dim.field.id, name: dim.field.name, type: dim.field.type, ...(dim.bucket ? { bucket: dim.bucket } : {}) }
}

export interface CollectionChartTarget {
  collectionId: string
  workspaceId: string
  title: string
  view?: { name: string; config: ViewConfig }
}

/** Aggregate one collection for a viewer whose access to it the caller has checked. */
export async function aggregateCollection(target: CollectionChartTarget, input: Omit<ChartAggregateInput, 'source'>, viewer: ChartViewer): Promise<ChartDataDTO> {
  const t0 = performance.now()
  const [def] = await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, target.collectionId)).limit(1)
  const fields = (def?.fields ?? []) as CollectionField[]
  const group = resolveDimension(fields, input.groupBy, 'groupBy')
  const series = input.series ? resolveDimension(fields, input.series, 'series') : null
  const measure = chartMeasureOf(input)
  let measureField: CollectionField | null = null
  if (measure.fn !== 'count') {
    measureField = fields.find((f) => f.id === measure.field) ?? null
    if (!measureField) throw invalidChart(`measure: no property with id "${measure.field}" in this collection`)
    if (!CHART_MEASURE_TYPES.has(measureField.type)) throw invalidChart(`measure: ${measure.fn} needs a number property, "${measureField.name}" is ${measureField.type}`)
  }
  if (viewer.kind === 'public' && [group, series].some((d) => d && d.field !== CHART_TITLE_FIELD && d.field.type === 'relation')) {
    throw invalidChart('relation groups are not shown on public pages')
  }

  const filters = (target.view?.config.filters ?? []).filter((f) => fields.some((x) => x.id === f.fieldId))
  const version = await workspaceVersion(target.workspaceId)
  const viewerKey = viewer.kind === 'user' ? `${viewer.userId}|${rangeCacheKey(viewer.userId)}` : 'public'
  const key = `c|${viewerKey}|${target.collectionId}|${JSON.stringify(input)}|${JSON.stringify(filters)}|${target.view?.name ?? ''}`
  const hit = cacheGet(key, version)
  if (hit) return { ...hit, cached: true }

  // properties the chart reads; a rollup needs its relation
  const need = new Map<string, CollectionField>()
  const want = (f: CollectionField | typeof CHART_TITLE_FIELD | null | undefined) => {
    if (!f || f === CHART_TITLE_FIELD) return
    need.set(f.id, f)
    if (f.type === 'rollup' && f.rollup) {
      const rel = fields.find((x) => x.id === f.rollup!.relationFieldId)
      if (rel) need.set(rel.id, rel)
    }
  }
  want(group.field)
  want(series?.field)
  want(measureField)
  for (const flt of filters) want(fields.find((x) => x.id === flt.fieldId))
  const needed = [...need.values()]

  const propsSql: SQL = needed.length
    ? sql`jsonb_build_object(${sql.join(
        needed.map((f) => sql`${f.id}::text, ${pages.props} -> ${f.id}::text`),
        sql`, `,
      )})`
    : sql`'{}'::jsonb`
  const rowGate: SQL = viewer.kind === 'user' ? visibleTo(viewer.userId) : sql`${pages.scope} = 'shared'`

  let raw: { id: string; title: string | null; props: Record<string, unknown> | null }[]
  try {
    raw = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${AGGREGATE_STATEMENT_TIMEOUT_MS}`))
      await tx.execute(sql.raw('SET LOCAL jit = off'))
      return (await tx.execute(sql`
        SELECT ${pages.id} AS id, ${pages.title} AS title, ${propsSql} AS props
          FROM ${pages}
         WHERE ${pages.parentId} = ${target.collectionId}::uuid
           AND ${pages.deletedAt} IS NULL
           AND ${rowGate}
      `)) as unknown as typeof raw
    })
  } catch (err) {
    if ((err as { code?: string }).code === '57014') {
      throw new AppError(400, 'QUERY_TIMEOUT', 'The chart took too long to compute; add a filter to its view')
    }
    throw err
  }

  const rows = raw.map((r) => {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r.props ?? {})) if (v !== null) props[k] = v
    return { id: r.id, title: r.title ?? '', props }
  })

  const refTitles = new Map<string, string>()
  const relFields = needed.filter((f) => f.type === 'relation' || f.type === 'rollup')
  if (relFields.length) {
    if (viewer.kind === 'user') {
      const { refs } = await resolveRelations(target.workspaceId, needed, rows, viewer.userId)
      for (const [id, ref] of Object.entries(refs)) refTitles.set(id, ref.title)
    } else {
      // public: no linked titles; rollups are not computed (as the public table)
      for (const r of rows) for (const f of needed) if (f.type === 'rollup') delete r.props[f.id]
    }
  }

  const kept = filters.length ? rows.filter((r) => matchesViewFilters(r.props, fields, filters)) : rows

  const memberNames = new Map<string, string>()
  const people = [group.field, series?.field].filter((f): f is CollectionField => !!f && f !== CHART_TITLE_FIELD && f.type === 'person')
  if (people.length) {
    const ids = new Set<string>()
    for (const r of kept)
      for (const f of people) {
        const v = r.props[f.id]
        for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)) ids.add(x)
      }
    if (ids.size) {
      // member names only (C-L11): a person cell holding any other user's id reveals nothing
      const us = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, [...ids]), isWorkspaceMember(target.workspaceId)))
      for (const u of us) memberNames.set(u.id, u.name)
    }
  }
  const resolvers = { memberName: (id: string) => memberNames.get(id), refTitle: (id: string) => refTitles.get(id) }

  const items: ChartItem[] = kept.map((r) => ({
    groups: collectionKeys(group.field, group.field === CHART_TITLE_FIELD ? null : r.props[group.field.id], r.title, group.bucket, resolvers),
    ...(series
      ? { series: collectionKeys(series.field, series.field === CHART_TITLE_FIELD ? null : r.props[series.field.id], r.title, series.bucket, resolvers) }
      : {}),
    value: measureField ? chartNumber(r.props[measureField.id]) : null,
  }))
  const agg = aggregateItems(items, {
    fn: measure.fn,
    sort: input.sort,
    limit: input.limit,
    naturalGroups: group.field !== CHART_TITLE_FIELD && naturalOrder(group.field.type),
    naturalSeries: !!series && series.field !== CHART_TITLE_FIELD && naturalOrder(series.field.type),
  })
  const result: ChartDataDTO = {
    source: { type: 'collection', id: target.collectionId, title: target.title, ...(target.view ? { viewName: target.view.name } : {}) },
    group: axis(group),
    ...(series ? { series: axis(series) } : {}),
    measure: { fn: measure.fn, ...(measureField ? { field: measureField.id, name: measureField.name } : {}) },
    groups: agg.groups,
    ...(agg.seriesKeys ? { seriesKeys: agg.seriesKeys } : {}),
    values: agg.values,
    rowCount: kept.length,
    omittedGroups: agg.omittedGroups,
    omittedSeries: agg.omittedSeries,
    elapsedMs: Math.round((performance.now() - t0) * 10) / 10,
  }
  cachePut(key, version, result)
  return result
}

/** The column of a query result named by a dimension (case-insensitive; 'title' = the row's page). */
function columnIndex(columns: string[], name: string): number | 'title' | -1 {
  const i = columns.findIndex((c) => c === name)
  if (i >= 0) return i
  const j = columns.findIndex((c) => c.toLowerCase() === name.toLowerCase())
  if (j >= 0) return j
  return name.toLowerCase() === CHART_TITLE_FIELD ? 'title' : -1
}

/** Aggregate a query block's result (run as the viewer, in a workspace whose membership is checked). */
export async function aggregateQuery(
  userId: string,
  workspaceId: string,
  query: string,
  input: Omit<ChartAggregateInput, 'source'>,
  today: string,
  tz: number,
): Promise<ChartDataDTO> {
  const t0 = performance.now()
  const res = await runWorkspaceQuery(userId, workspaceId, query, today, tz)
  const cols = res.type === 'LIST' && res.columns.length === 0 ? [] : res.columns
  const pick = (d: ChartDimension, what: string) => {
    const at = columnIndex(cols, d.field)
    if (at === -1) {
      throw invalidChart(`${what}: the query has no column "${d.field}" (columns: ${['title', ...cols].map((c) => `"${c}"`).join(', ')})`)
    }
    return at
  }
  const gi = pick(input.groupBy, 'groupBy')
  const si = input.series ? pick(input.series, 'series') : null
  const measure = chartMeasureOf(input)
  const mi = measure.fn === 'count' ? null : pick({ field: measure.field! }, 'measure')
  const cell = (row: (typeof res.rows)[number], at: number | 'title') => (at === 'title' ? { ref: 'page', pageId: row.pageId, title: row.title } : row.cells[at])
  const items: ChartItem[] = res.rows.map((row) => ({
    groups: queryCellKeys(cell(row, gi), input.groupBy.bucket),
    ...(si !== null ? { series: queryCellKeys(cell(row, si), input.series?.bucket) } : {}),
    value: mi === null ? null : chartNumber(cell(row, mi)),
  }))
  const dated = (bucket: unknown, at: number | 'title') => !!bucket || (at !== 'title' && res.rows.length > 0 && res.rows.every((r) => typeof r.cells[at] !== 'string' || /^\d{4}-\d{2}-\d{2}/.test(r.cells[at] as string)))
  const agg = aggregateItems(items, {
    fn: measure.fn,
    sort: input.sort,
    limit: input.limit,
    naturalGroups: dated(input.groupBy.bucket, gi),
    naturalSeries: si !== null && dated(input.series?.bucket, si),
  })
  const colName = (at: number | 'title') => (at === 'title' ? 'Title' : cols[at])
  return {
    source: { type: 'query' },
    group: { field: input.groupBy.field, name: colName(gi), type: 'column', ...(input.groupBy.bucket ? { bucket: input.groupBy.bucket } : {}) },
    ...(si !== null && input.series ? { series: { field: input.series.field, name: colName(si), type: 'column', ...(input.series.bucket ? { bucket: input.series.bucket } : {}) } } : {}),
    measure: { fn: measure.fn, ...(mi !== null ? { field: measure.field, name: colName(mi) } : {}) },
    groups: agg.groups,
    ...(agg.seriesKeys ? { seriesKeys: agg.seriesKeys } : {}),
    values: agg.values,
    rowCount: res.rows.length,
    omittedGroups: agg.omittedGroups,
    omittedSeries: agg.omittedSeries,
    ...(res.truncated ? { truncated: true } : {}),
    elapsedMs: Math.round((performance.now() - t0) * 10) / 10,
    ...(res.cached ? { cached: true } : {}),
  }
}
