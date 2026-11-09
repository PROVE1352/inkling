// The one place that knows the chart library's spec (docs/adr/1601-*): our stored settings plus the
// server's aggregate become a ztd-charts spec. If the library's spec changes, only this file does.
// Data is always inline rows built here from the aggregate — never a URL, CSV or the spec's own data.
import type { ChartSpec } from 'ztd-charts/spec'
import { CHART_OPTION_DENY } from '@inkling/shared'
import type { ChartDataDTO, ChartFn, ChartKeyDTO, ChartKind, ChartSettings } from '@inkling/shared'

export interface AdapterLabels {
  noValue: string
  checked: string
  unchecked: string
  /** measure name: "Count of rows", "Sum of Points" … */
  measure: string
}

/** Library type and how our columns map onto its channels, per kind. */
const KIND: Record<ChartKind, { type: string; channels: 'xy' | 'labelValue' | 'heat' | 'radar'; options?: Record<string, unknown>; seriesOptions?: Record<string, unknown> }> = {
  bar: { type: 'bar', channels: 'xy', options: { orientation: 'vertical', sort: false }, seriesOptions: { layout: 'grouped' } },
  barH: { type: 'bar', channels: 'xy', options: { orientation: 'horizontal', sort: false }, seriesOptions: { layout: 'grouped' } },
  stackedBar: { type: 'bar', channels: 'xy', options: { layout: 'stacked' } },
  line: { type: 'line', channels: 'xy', options: { xType: 'band' } },
  area: { type: 'area', channels: 'xy', options: { xType: 'band', stack: 'none' }, seriesOptions: { stack: 'stacked' } },
  stream: { type: 'stream', channels: 'xy', options: { xType: 'band' } },
  donut: { type: 'donut', channels: 'labelValue', options: { sort: false } },
  pie: { type: 'pie', channels: 'labelValue', options: { sort: false } },
  lollipop: { type: 'lollipop', channels: 'labelValue', options: { sort: false } },
  funnel: { type: 'funnel', channels: 'labelValue' },
  treemap: { type: 'treemap', channels: 'labelValue', options: { sort: false } },
  waffle: { type: 'waffle', channels: 'labelValue' },
  radialBar: { type: 'radialBar', channels: 'labelValue' },
  pareto: { type: 'pareto', channels: 'labelValue' },
  segmented: { type: 'segmented', channels: 'labelValue', options: { sort: false } },
  heatmap: { type: 'heatmap', channels: 'heat' },
  radar: { type: 'radar', channels: 'radar' },
}

export function keyLabel(k: ChartKeyDTO, labels: Pick<AdapterLabels, 'noValue' | 'checked' | 'unchecked'>): string {
  if (k.special === 'empty') return labels.noValue
  if (k.special === 'checked') return labels.checked
  if (k.special === 'unchecked') return labels.unchecked
  return k.label
}

/** Labels must be unique for the chart's categories: a repeated label gets " (2)", " (3)"… */
function uniqueLabels(keys: ChartKeyDTO[], labels: AdapterLabels): string[] {
  const seen = new Map<string, number>()
  return keys.map((k) => {
    const l = keyLabel(k, labels) || labels.noValue
    const n = (seen.get(l) ?? 0) + 1
    seen.set(l, n)
    return n === 1 ? l : `${l} (${n})`
  })
}

function total(v: (number | null)[], fn: ChartFn): number {
  if (fn === 'count' || fn === 'sum') return v.reduce<number>((s, x) => s + (x ?? 0), 0)
  return v.find((x) => x !== null) ?? 0
}

/** User options that are plain values and not ours to set. */
function userOptions(o: ChartSettings['options']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o ?? {})) if (!CHART_OPTION_DENY.has(k)) out[k] = v
  return out
}

/**
 * Settings + aggregate → library spec. `locale` is the app's ('ko-KR' / 'en-US'). The aggregate's
 * groups keep their order (the server sorted them); the library is told not to re-sort.
 */
export function toChartSpec(settings: ChartSettings, data: ChartDataDTO, labels: AdapterLabels, locale: string): ChartSpec {
  const k = KIND[settings.kind] ?? KIND.bar
  const groups = uniqueLabels(data.groups, labels)
  const series = data.seriesKeys ? uniqueLabels(data.seriesKeys, labels) : null
  const fn = data.measure.fn
  const rows: Record<string, unknown>[] = []
  const wantsSeries = series && (k.channels === 'xy' || k.channels === 'heat' || k.channels === 'radar')
  data.groups.forEach((_, gi) => {
    const v = data.values[gi]
    if (Array.isArray(v)) {
      if (wantsSeries) v.forEach((x, si) => rows.push({ label: groups[gi], series: series![si], value: x ?? 0 }))
      else rows.push({ label: groups[gi], value: total(v, fn) })
    } else {
      rows.push({ label: groups[gi], value: v ?? 0 })
    }
  })
  const withSeries = !!wantsSeries && rows.some((r) => 'series' in r)

  let encoding: Record<string, string>
  switch (k.channels) {
    case 'xy':
      encoding = { x: 'label', y: 'value', ...(withSeries ? { series: 'series' } : {}) }
      break
    case 'labelValue':
      encoding = { label: 'label', value: 'value' }
      break
    case 'heat':
      // a heatmap needs two dimensions: without a series the measure is the one row
      if (!withSeries) for (const r of rows) r.series = labels.measure
      encoding = { x: 'label', y: 'series', value: 'value' }
      break
    case 'radar':
      encoding = { axis: 'label', value: 'value', ...(withSeries ? { series: 'series' } : {}) }
      break
  }

  const options: Record<string, unknown> = {
    ...(k.options ?? {}),
    ...(withSeries ? (k.seriesOptions ?? {}) : {}),
    ...userOptions(settings.options),
    locale,
  }
  if (settings.title && !options.ariaLabel) options.ariaLabel = settings.title
  return { type: k.type, data: rows, encoding, options }
}
