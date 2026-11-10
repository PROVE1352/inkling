// Charts (docs/adr/1600-*, 1601-*, 1602-*): the stored chart format, the aggregate request / result
// shapes, and the pure functions that turn rows into chart cells.
//
// The stored format is ours, not the chart library's: a chart block keeps `chartBlockConfigSchema`
// (canonical JSON in its `config` prop), a collection chart view keeps `chartSettingsSchema` in its
// view config (`config.chart`). The web turns a config plus an aggregate result into a ztd-charts
// spec in one adapter (apps/web/src/components/charts/adapter.ts); nothing here knows that library.
// The chart never carries data or a data URL: the data is always the aggregate the server computed
// for the viewer.
//
// This file must not import values from './index' (index re-exports it); type imports are fine.

import { formulaResultType, isFormulaErrorCell } from './formula'
import { z } from 'zod'
import type { CollectionField, FilterOp } from './index'

// ---------------------------------------------------------------------------
// Stored format
// ---------------------------------------------------------------------------

/** Chart kinds the settings UI offers; the adapter maps each to a ztd chart type. */
export const CHART_BASIC_KINDS = ['bar', 'barH', 'stackedBar', 'line', 'area', 'donut', 'pie'] as const
/** Further kinds that take the same group/value data; set from the "more" list or by agents. */
export const CHART_MORE_KINDS = ['lollipop', 'funnel', 'treemap', 'waffle', 'radialBar', 'pareto', 'segmented', 'heatmap', 'radar', 'stream'] as const
export const CHART_KINDS = [...CHART_BASIC_KINDS, ...CHART_MORE_KINDS] as const
export type ChartKind = (typeof CHART_KINDS)[number]
/** Kinds that draw a second grouping (series); heatmap needs one. */
export const CHART_SERIES_KINDS: readonly ChartKind[] = ['bar', 'barH', 'stackedBar', 'line', 'area', 'heatmap', 'radar', 'stream']

export const CHART_BUCKETS = ['day', 'week', 'month'] as const
export type ChartBucket = (typeof CHART_BUCKETS)[number]
export const CHART_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const
export type ChartFn = (typeof CHART_FNS)[number]
export const CHART_SORTS = ['auto', 'label', 'valueDesc', 'valueAsc'] as const
export type ChartSort = (typeof CHART_SORTS)[number]

/** Groups drawn at most (the rest are counted in `omittedGroups`); series at most. */
export const CHART_MAX_GROUPS = 100
export const CHART_MAX_SERIES = 12
/** Default group limit: few slices for pies, more bars elsewhere. */
export function defaultChartLimit(kind: ChartKind | undefined): number {
  return kind === 'pie' || kind === 'donut' || kind === 'waffle' || kind === 'funnel' ? 12 : 30
}

/** The pseudo field that groups by row title (collections only). */
export const CHART_TITLE_FIELD = 'title'

const fieldRef = z.string().trim().min(1).max(200)

export const chartDimensionSchema = z.strictObject({
  /** collection: field id or 'title'; query source: column name */
  field: fieldRef,
  /** date grouping */
  bucket: z.enum(CHART_BUCKETS).optional(),
})
export type ChartDimension = z.infer<typeof chartDimensionSchema>

export const chartMeasureSchema = z
  .strictObject({
    fn: z.enum(CHART_FNS),
    /** number field (id) or query column for sum / avg / min / max */
    field: fieldRef.optional(),
  })
  .refine((m) => m.fn === 'count' || !!m.field, { message: 'sum, avg, min and max need a number field' })
export type ChartMeasure = z.infer<typeof chartMeasureSchema>

/**
 * Library options passed through to the chart (`options` of a ztd spec): plain values only, a
 * handful of keys, no data, theme or locale (those come from the app). The web drops options the
 * library's own validation rejects.
 */
export const CHART_OPTION_DENY = new Set(['data', 'url', 'csv', 'values', 'theme', 'locale', 'width', 'fetchInit', 'syncId', 'className', 'style'])
const optionValue = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([z.string().max(200), z.number().finite()])).max(20),
])
export const chartOptionsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), optionValue)
  .refine((o) => Object.keys(o).length <= 20, { message: 'At most 20 chart options' })
  .refine((o) => !Object.keys(o).some((k) => CHART_OPTION_DENY.has(k)), { message: 'Chart options cannot set data, theme or locale' })
  .refine((o) => JSON.stringify(o).length <= 4096, { message: 'Chart options are limited to 4 KB' })

const settingsShape = {
  kind: z.enum(CHART_KINDS),
  groupBy: chartDimensionSchema,
  series: chartDimensionSchema.optional(),
  measure: chartMeasureSchema.optional(),
  sort: z.enum(CHART_SORTS).optional(),
  limit: z.number().int().min(1).max(CHART_MAX_GROUPS).optional(),
  title: z.string().trim().max(120).optional(),
  options: chartOptionsSchema.optional(),
}

/** What a collection's chart view stores (`viewConfig.chart`): the view itself is the source. */
export const chartSettingsSchema = z.strictObject(settingsShape)
export type ChartSettings = z.infer<typeof chartSettingsSchema>

export const chartSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('collection'),
    collectionId: z.uuid(),
    /** apply this view's filters (a view of the same collection) */
    viewId: z.uuid().optional(),
  }),
  z.strictObject({
    type: z.literal('query'),
    /** query block source (docs/QUERY.md), run in the workspace of the page that holds the chart */
    query: z.string().trim().min(1).max(2000),
  }),
])
export type ChartSource = z.infer<typeof chartSourceSchema>

/** What a chart block stores (its `config` prop, canonical JSON — see canonicalChartJson). */
export const chartBlockConfigSchema = z.strictObject({ source: chartSourceSchema, ...settingsShape })
export type ChartBlockConfig = z.infer<typeof chartBlockConfigSchema>

/** Upper bound of a block's `config` prop (bytes of JSON). */
export const CHART_CONFIG_MAX = 8 * 1024

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeysDeep(x)
    }
    return out
  }
  return v
}

/**
 * Canonical form of a chart config: defaults left out (measure count, sort auto, empty title or
 * options), keys sorted. The block prop and the agent token are this JSON, so a read → write round
 * trip gives the same string.
 */
export function canonicalChartConfig<T extends ChartSettings | ChartBlockConfig>(c: T): T {
  const out = { ...c } as Record<string, unknown>
  const m = out.measure as ChartMeasure | undefined
  if (m && m.fn === 'count') delete out.measure
  if (out.sort === 'auto') delete out.sort
  if (out.title === '') delete out.title
  if (out.options && Object.keys(out.options as object).length === 0) delete out.options
  return sortKeysDeep(out) as T
}

export function canonicalChartJson(c: ChartBlockConfig): string {
  return JSON.stringify(canonicalChartConfig(c))
}

/** A block's `config` prop → the config, or null when it is empty or invalid. */
export function parseChartBlockConfig(raw: unknown): ChartBlockConfig | null {
  if (typeof raw !== 'string' || !raw || raw.length > CHART_CONFIG_MAX) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const r = chartBlockConfigSchema.safeParse(v)
  return r.success ? r.data : null
}

export function chartMeasureOf(c: { measure?: ChartMeasure }): ChartMeasure {
  return c.measure ?? { fn: 'count' }
}

// ---------------------------------------------------------------------------
// Aggregate request / result (POST /api/workspaces/:id/charts/aggregate)
// ---------------------------------------------------------------------------

export const chartAggregateSchema = z.strictObject({
  source: chartSourceSchema,
  groupBy: chartDimensionSchema,
  series: chartDimensionSchema.optional(),
  measure: chartMeasureSchema.optional(),
  sort: z.enum(CHART_SORTS).optional(),
  limit: z.number().int().min(1).max(CHART_MAX_GROUPS).optional(),
  /** the viewer's date, for relative dates of a query source (as POST /query) */
  today: z.iso.date().optional(),
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
})
export type ChartAggregateInput = z.infer<typeof chartAggregateSchema>

/** The aggregate request of a block config (or of view settings plus the view as source). */
export function chartAggregateInput(c: ChartBlockConfig): ChartAggregateInput {
  return {
    source: c.source,
    groupBy: c.groupBy,
    ...(c.series && CHART_SERIES_KINDS.includes(c.kind) ? { series: c.series } : {}),
    ...(c.measure ? { measure: c.measure } : {}),
    ...(c.sort ? { sort: c.sort } : {}),
    limit: c.limit ?? defaultChartLimit(c.kind),
  }
}

/** `empty`: no value; `checked` / `unchecked`: checkbox groups (labels are localized by clients). */
export type ChartKeySpecial = 'empty' | 'checked' | 'unchecked'

export interface ChartKeyDTO {
  /** stable key (option id, member id, row id, date bucket, text); null for "no value" */
  key: string | null
  /** display label (option name, member name, row title, date bucket, text) */
  label: string
  special?: ChartKeySpecial
}

export interface ChartAxisDTO {
  /** the requested field (id or column) */
  field: string
  /** its display name ("Title" for the row title) */
  name: string
  /** field type, or 'column' for a query source */
  type: string
  bucket?: ChartBucket
}

export interface ChartDataDTO {
  source: { type: 'collection'; id: string; title: string; viewName?: string } | { type: 'query' }
  group: ChartAxisDTO
  series?: ChartAxisDTO
  measure: { fn: ChartFn; field?: string; name?: string }
  /** groups after sort and limit, in drawing order */
  groups: ChartKeyDTO[]
  /** series in drawing order (absent without a series dimension) */
  seriesKeys?: ChartKeyDTO[]
  /** values[g] (no series) or values[g][s]: null when there is nothing to measure (avg of no numbers) */
  values: (number | null)[] | (number | null)[][]
  /** rows that went into the chart (after the view's filters, or the query's rows) */
  rowCount: number
  omittedGroups: number
  omittedSeries: number
  /** a query source returned fewer rows than matched (its LIMIT or the server cap) */
  truncated?: boolean
  elapsedMs: number
  cached?: boolean
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export interface ChartKey extends ChartKeyDTO {
  /** natural order (option index, date, …); compared before the label */
  order: number | string
}

export const EMPTY_CHART_KEY: ChartKey = { key: null, label: '(empty)', special: 'empty', order: Number.POSITIVE_INFINITY }

export interface ChartItem {
  groups: ChartKey[]
  series?: ChartKey[]
  /** the measured number of this row (null when the field holds no number) */
  value: number | null
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** `YYYY-MM-DD…` → its day / week (ISO week, the Monday) / month bucket, or null. */
export function dateBucket(value: string, bucket: ChartBucket | undefined): string | null {
  const m = DATE_RE.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (bucket === 'month') return `${m[1]}-${m[2]}`
  if (bucket === 'week') {
    const t = Date.UTC(y, mo - 1, d)
    const dow = (new Date(t).getUTCDay() + 6) % 7 // Monday = 0
    return new Date(t - dow * 86_400_000).toISOString().slice(0, 10)
  }
  return `${m[1]}-${m[2]}-${m[3]}`
}

export interface ChartResolvers {
  /** workspace member's name; undefined for anyone else (never shown by id) */
  memberName(id: string): string | undefined
  /** visible linked row's title; undefined when hidden */
  refTitle(id: string): string | undefined
}

/** Fields a chart can group by. */
export const CHART_GROUP_TYPES = new Set<CollectionField['type']>(['select', 'multiSelect', 'person', 'date', 'checkbox', 'relation', 'text', 'url', 'number'])
/** Fields a chart can sum / average. */
export const CHART_MEASURE_TYPES = new Set<CollectionField['type']>(['number', 'rollup'])

/** A property can group a chart: the group types, and formulas (by what they yield, docs/adr/1827-*). */
export function chartCanGroup(f: CollectionField): boolean {
  return CHART_GROUP_TYPES.has(f.type) || f.type === 'formula'
}

/** A property can be summed / averaged: numbers, rollups, and formulas that yield a number. */
export function chartCanMeasure(fields: CollectionField[], f: CollectionField): boolean {
  return CHART_MEASURE_TYPES.has(f.type) || (f.type === 'formula' && formulaResultType(fields, f.id) === 'number')
}

function textKey(s: string, order?: number | string): ChartKey {
  const label = s.length > 100 ? `${s.slice(0, 99)}…` : s
  return { key: label, label, order: order ?? label.toLowerCase() }
}

function dateValue(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { start?: unknown }).start === 'string') return (v as { start: string }).start
  return null
}

/** Group keys of one collection row for one field (`title` = the row title). */
export function collectionKeys(
  field: CollectionField | typeof CHART_TITLE_FIELD,
  value: unknown,
  title: string,
  bucket: ChartBucket | undefined,
  r: ChartResolvers,
): ChartKey[] {
  if (field === CHART_TITLE_FIELD) return [textKey(title || 'Untitled')]
  const empty = [EMPTY_CHART_KEY]
  switch (field.type) {
    case 'select': {
      const opts = field.options ?? []
      const i = opts.findIndex((o) => o.id === value)
      return i < 0 ? empty : [{ key: opts[i].id, label: opts[i].name, order: i }]
    }
    case 'multiSelect': {
      if (!Array.isArray(value)) return empty
      const opts = field.options ?? []
      const out: ChartKey[] = []
      for (const id of new Set(value)) {
        const i = opts.findIndex((o) => o.id === id)
        if (i >= 0) out.push({ key: opts[i].id, label: opts[i].name, order: i })
      }
      return out.length ? out : empty
    }
    case 'person': {
      const ids = Array.isArray(value) ? value : [value]
      const out: ChartKey[] = []
      for (const id of new Set(ids)) {
        if (typeof id !== 'string') continue
        const name = r.memberName(id)
        // not a member: counted as "no value", the id is never shown (C-L11)
        if (name !== undefined) out.push({ key: id, label: name, order: name.toLowerCase() })
      }
      return out.length ? out : empty
    }
    case 'relation': {
      if (!Array.isArray(value)) return empty
      const out: ChartKey[] = []
      for (const id of new Set(value)) {
        const t = typeof id === 'string' ? r.refTitle(id) : undefined
        if (t !== undefined) out.push({ key: id as string, label: t || 'Untitled', order: (t || 'Untitled').toLowerCase() })
      }
      return out.length ? out : empty
    }
    case 'date': {
      const s = dateValue(value)
      const k = s ? dateBucket(s, bucket) : null
      return k ? [{ key: k, label: k, order: k }] : empty
    }
    case 'checkbox':
      return value === true
        ? [{ key: 'true', label: 'Checked', special: 'checked', order: 0 }]
        : [{ key: 'false', label: 'Unchecked', special: 'unchecked', order: 1 }]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [{ key: String(value), label: String(value), order: value }] : empty
    case 'text':
    case 'url': {
      const s = typeof value === 'string' ? value.trim() : ''
      return s ? [textKey(s)] : empty
    }
    default:
      return empty
  }
}

/** Group keys of one query result cell (person cells are names already, relations page refs). */
export function queryCellKeys(cell: unknown, bucket: ChartBucket | undefined): ChartKey[] {
  const empty = [EMPTY_CHART_KEY]
  if (cell === null || cell === undefined || cell === '') return empty
  if (Array.isArray(cell)) {
    const out: ChartKey[] = []
    const seen = new Set<string | null>()
    for (const c of cell) {
      for (const k of queryCellKeys(c, bucket)) {
        if (k.key === null || seen.has(k.key)) continue
        seen.add(k.key)
        out.push(k)
      }
    }
    return out.length ? out : empty
  }
  if (typeof cell === 'object') {
    const o = cell as Record<string, unknown>
    if (o.ref === 'page' && typeof o.pageId === 'string' && typeof o.title === 'string') {
      const label = o.title || 'Untitled'
      return [{ key: o.pageId, label, order: label.toLowerCase() }]
    }
    return empty
  }
  if (typeof cell === 'boolean') {
    return cell
      ? [{ key: 'true', label: 'Checked', special: 'checked', order: 0 }]
      : [{ key: 'false', label: 'Unchecked', special: 'unchecked', order: 1 }]
  }
  if (typeof cell === 'number') return Number.isFinite(cell) ? [{ key: String(cell), label: String(cell), order: cell }] : empty
  const s = String(cell).trim()
  if (!s) return empty
  if (bucket || DATE_RE.test(s)) {
    const k = dateBucket(s, bucket)
    if (k) return [{ key: k, label: k, order: k }]
  }
  return [textKey(s)]
}

export function chartNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

interface Acc {
  n: number
  sum: number
  nums: number
  min: number
  max: number
}
const newAcc = (): Acc => ({ n: 0, sum: 0, nums: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY })
function add(a: Acc, v: number | null) {
  a.n++
  if (v === null) return
  a.nums++
  a.sum += v
  if (v < a.min) a.min = v
  if (v > a.max) a.max = v
}
function result(a: Acc | undefined, fn: ChartFn): number | null {
  if (!a) return fn === 'count' || fn === 'sum' ? 0 : null
  switch (fn) {
    case 'count':
      return a.n
    case 'sum':
      return Math.round(a.sum * 1e9) / 1e9
    case 'avg':
      return a.nums ? Math.round((a.sum / a.nums) * 1e6) / 1e6 : null
    case 'min':
      return a.nums ? a.min : null
    case 'max':
      return a.nums ? a.max : null
  }
}

function cmpOrder(a: ChartKey, b: ChartKey): number {
  if (a.key === null || b.key === null) return a.key === b.key ? 0 : a.key === null ? 1 : -1
  if (typeof a.order === 'number' && typeof b.order === 'number') return a.order - b.order
  return String(a.order).localeCompare(String(b.order)) || a.label.localeCompare(b.label)
}

export interface AggregateOptions {
  fn: ChartFn
  sort?: ChartSort
  limit?: number
  /** the dimension has a natural order (options, dates, checkbox): 'auto' keeps it */
  naturalGroups: boolean
  naturalSeries?: boolean
}

export interface AggregateResult {
  groups: ChartKeyDTO[]
  seriesKeys?: ChartKeyDTO[]
  values: (number | null)[] | (number | null)[][]
  omittedGroups: number
  omittedSeries: number
}

const dto = (k: ChartKey): ChartKeyDTO => (k.special ? { key: k.key, label: k.label, special: k.special } : { key: k.key, label: k.label })

/**
 * Groups items by their group (and series) keys and measures each group. A row with several keys
 * (multi-select, relations, people) counts in each of its groups once. 'auto' sort keeps a natural
 * order and otherwise puts the largest group first; "no value" is always last.
 */
export function aggregateItems(items: ChartItem[], o: AggregateOptions): AggregateResult {
  const groups = new Map<string, { k: ChartKey; acc: Acc }>()
  const series = new Map<string, { k: ChartKey; acc: Acc }>()
  const cells = new Map<string, Acc>()
  const id = (k: ChartKey) => (k.key === null ? '\u0000' : `k${k.key}`)
  for (const it of items) {
    for (const g of it.groups) {
      const gid = id(g)
      let ge = groups.get(gid)
      if (!ge) groups.set(gid, (ge = { k: g, acc: newAcc() }))
      add(ge.acc, it.value)
      if (it.series) {
        for (const s of it.series) {
          const sid = id(s)
          const cid = `${gid}\u0001${sid}`
          let c = cells.get(cid)
          if (!c) cells.set(cid, (c = newAcc()))
          add(c, it.value)
        }
      }
    }
    if (it.series && it.groups.length) {
      for (const s of it.series) {
        const sid = id(s)
        let se = series.get(sid)
        if (!se) series.set(sid, (se = { k: s, acc: newAcc() }))
        add(se.acc, it.value)
      }
    }
  }

  const order = (list: { k: ChartKey; acc: Acc }[], natural: boolean, sort: ChartSort) => {
    const val = (e: { acc: Acc }) => result(e.acc, o.fn) ?? Number.NEGATIVE_INFINITY
    list.sort((a, b) => {
      if (a.k.key === null || b.k.key === null) return cmpOrder(a.k, b.k)
      if (sort === 'label') return a.k.label.localeCompare(b.k.label) || cmpOrder(a.k, b.k)
      if (sort === 'valueAsc') return val(a) - val(b) || cmpOrder(a.k, b.k)
      if (sort === 'valueDesc' || !natural) return val(b) - val(a) || cmpOrder(a.k, b.k)
      return cmpOrder(a.k, b.k)
    })
    return list
  }
  const sort = o.sort ?? 'auto'
  const limit = Math.min(o.limit ?? CHART_MAX_GROUPS, CHART_MAX_GROUPS)
  const gl = order([...groups.values()], o.naturalGroups, sort)
  const shownG = gl.slice(0, limit)
  const hasSeries = items.some((i) => i.series)
  if (!hasSeries) {
    return {
      groups: shownG.map((e) => dto(e.k)),
      values: shownG.map((e) => result(e.acc, o.fn)),
      omittedGroups: gl.length - shownG.length,
      omittedSeries: 0,
    }
  }
  // series: natural order when it has one, else largest first; capped
  const sl = order([...series.values()], o.naturalSeries ?? false, 'auto')
  const shownS = sl.slice(0, CHART_MAX_SERIES)
  return {
    groups: shownG.map((e) => dto(e.k)),
    seriesKeys: shownS.map((e) => dto(e.k)),
    values: shownG.map((g) => shownS.map((s) => result(cells.get(`${id(g.k)}\u0001${id(s.k)}`), o.fn))),
    omittedGroups: gl.length - shownG.length,
    omittedSeries: sl.length - shownS.length,
  }
}

/** Dimensions whose values have an order of their own ('auto' sort keeps it). */
export function naturalOrder(type: string): boolean {
  return type === 'select' || type === 'date' || type === 'checkbox' || type === 'number'
}

// ---------------------------------------------------------------------------
// View filters (shared by the web views and the server's chart aggregate)
// ---------------------------------------------------------------------------

/** One filter of a view (viewConfig.filters) against a row's stored value. */
export function matchesFilter(
  field: CollectionField,
  value: unknown,
  op: FilterOp,
  target: string | number | boolean | undefined,
): boolean {
  // a formula error (web marker) reads as an empty value
  if (isFormulaErrorCell(value)) value = null
  const isEmpty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  switch (op) {
    case 'empty':
      return isEmpty
    case 'notEmpty':
      return !isEmpty
    case 'eq':
      if (field.type === 'multiSelect') return Array.isArray(value) && value.includes(target as string)
      return String(value ?? '') === String(target ?? '')
    case 'ne':
      if (field.type === 'multiSelect') return !(Array.isArray(value) && value.includes(target as string))
      return String(value ?? '') !== String(target ?? '')
    case 'contains':
      if (field.type === 'rollup' && Array.isArray(value))
        return value.some((v) => String(v).toLowerCase().includes(String(target ?? '').toLowerCase()))
      if (Array.isArray(value)) return value.includes(target as string)
      return String(value ?? '')
        .toLowerCase()
        .includes(String(target ?? '').toLowerCase())
    case 'gt':
    case 'lt': {
      if (field.type === 'number' || ((field.type === 'rollup' || field.type === 'formula') && typeof value === 'number')) {
        const a = Number(value)
        const b = Number(target)
        if (Number.isNaN(a) || Number.isNaN(b)) return false
        return op === 'gt' ? a > b : a < b
      }
      // date/text etc. compare lexicographically as strings
      if (isEmpty) return false
      const a = String(value)
      const b = String(target ?? '')
      return op === 'gt' ? a > b : a < b
    }
    default:
      return true
  }
}

/** Every filter must match; filters on fields that no longer exist are ignored (as the views do). */
export function matchesViewFilters(
  props: Record<string, unknown>,
  fields: CollectionField[],
  filters: { fieldId: string; op: FilterOp; value?: string | number | boolean }[] | undefined,
): boolean {
  if (!filters?.length) return true
  for (const flt of filters) {
    const field = fields.find((f) => f.id === flt.fieldId)
    if (!field) continue
    if (!matchesFilter(field, props[flt.fieldId], flt.op, flt.value)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Text summary (agent reads, exports)
// ---------------------------------------------------------------------------

function fmt(n: number | null): string {
  if (n === null) return '–'
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** Total of a group across its series (count / sum add up; others show the first series). */
function groupValue(values: ChartDataDTO['values'], i: number, fn: ChartFn): number | null {
  const v = values[i]
  if (!Array.isArray(v)) return v ?? null
  if (fn === 'count' || fn === 'sum') return v.reduce<number>((s, x) => s + (x ?? 0), 0)
  return v.find((x) => x !== null) ?? null
}

/**
 * One line of numbers for agents and plain text: "count by Status: Done 12, In progress 5, Todo 3
 * (20 rows)". `top` groups at most; labels are member-written text (callers mark them untrusted).
 */
export function chartSummaryLine(d: ChartDataDTO, top = 8): string {
  const what = d.measure.fn === 'count' ? 'count' : `${d.measure.fn} of ${d.measure.name ?? d.measure.field ?? ''}`
  const by = `${d.group.name}${d.group.bucket ? ` (${d.group.bucket})` : ''}${d.series ? ` × ${d.series.name}` : ''}`
  const parts = d.groups.slice(0, top).map((g, i) => `${g.label.replace(/[\r\n]+/g, ' ')} ${fmt(groupValue(d.values, i, d.measure.fn))}`)
  const more = d.groups.length - Math.min(top, d.groups.length) + d.omittedGroups
  const tail = `${d.rowCount} row${d.rowCount === 1 ? '' : 's'}${more > 0 ? `, ${more} more group${more === 1 ? '' : 's'}` : ''}`
  return `${what} by ${by}: ${parts.length ? parts.join(', ') : 'no data'} (${tail})`
}

/** Markdown table of an aggregate (plain exports, public pages): label | value [| series…]. */
export function chartTableMarkdown(d: ChartDataDTO, labels: { empty?: string; checked?: string; unchecked?: string } = {}): string {
  const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
  const label = (k: ChartKeyDTO) =>
    k.special === 'empty' ? (labels.empty ?? k.label) : k.special === 'checked' ? (labels.checked ?? k.label) : k.special === 'unchecked' ? (labels.unchecked ?? k.label) : k.label
  const measure = d.measure.fn === 'count' ? 'Count' : `${d.measure.fn[0].toUpperCase()}${d.measure.fn.slice(1)} of ${d.measure.name ?? d.measure.field ?? ''}`
  const head = d.seriesKeys ? [d.group.name, ...d.seriesKeys.map(label)] : [d.group.name, measure]
  const lines = [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  d.groups.forEach((g, i) => {
    const v = d.values[i]
    const vals = Array.isArray(v) ? v.map(fmt) : [fmt(v ?? null)]
    lines.push(`| ${[cell(label(g)), ...vals].join(' | ')} |`)
  })
  return lines.join('\n')
}
