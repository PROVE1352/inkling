// Chart adapter (docs/adr/1601-*): every kind we offer becomes a spec the chart library itself
// accepts (its own validateSpec), data is inline rows, and our labels / order survive.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateSpec } from 'ztd-charts/spec'
import { CHART_KINDS } from '@inkling/shared'
import type { ChartDataDTO } from '@inkling/shared'
import { toChartSpec } from './adapter'

const labels = { noValue: 'No value', checked: 'Checked', unchecked: 'Unchecked', measure: 'Count of rows' }
const flat: ChartDataDTO = {
  source: { type: 'collection', id: 'c', title: 'Roadmap' },
  group: { field: 'st', name: 'Status', type: 'select' },
  measure: { fn: 'count' },
  groups: [
    { key: 'todo', label: 'Todo' },
    { key: 'done', label: 'Done' },
    { key: null, label: '(empty)', special: 'empty' },
  ],
  values: [3, 5, null],
  rowCount: 8,
  omittedGroups: 0,
  omittedSeries: 0,
  elapsedMs: 1,
}
const matrix: ChartDataDTO = {
  ...flat,
  series: { field: 'ow', name: 'Owner', type: 'person' },
  seriesKeys: [
    { key: 'a', label: 'Ann' },
    { key: 'b', label: 'Ann' },
  ],
  values: [
    [1, 2],
    [4, 1],
    [0, 0],
  ],
}

test('every kind validates with the library, with and without a series', () => {
  for (const kind of CHART_KINDS) {
    for (const data of [flat, matrix]) {
      const spec = toChartSpec({ kind, groupBy: { field: 'st' }, ...(data.seriesKeys ? { series: { field: 'ow' } } : {}) }, data, labels, 'ko-KR')
      const r = validateSpec(spec, { lang: 'en' })
      assert.equal(r.valid, true, `${kind}${data.seriesKeys ? ' + series' : ''}: ${JSON.stringify(r.errors)}`)
      assert.ok(Array.isArray(spec.data), 'inline rows only')
      assert.equal((spec.options as { locale?: string }).locale, 'ko-KR')
    }
  }
})

test('labels: "no value" localized, duplicate names kept apart, order kept, null measured as 0', () => {
  const spec = toChartSpec({ kind: 'bar', groupBy: { field: 'st' } }, flat, labels, 'en-US')
  assert.deepEqual(spec.data, [
    { label: 'Todo', value: 3 },
    { label: 'Done', value: 5 },
    { label: 'No value', value: 0 },
  ])
  assert.equal((spec.options as { sort?: boolean }).sort, false)
  const m = toChartSpec({ kind: 'stackedBar', groupBy: { field: 'st' }, series: { field: 'ow' } }, matrix, labels, 'en-US')
  assert.deepEqual(new Set((m.data as { series: string }[]).map((r) => r.series)), new Set(['Ann', 'Ann (2)']))
  assert.equal((m.options as { layout?: string }).layout, 'stacked')
  // a pie of a matrix shows group totals
  const pie = toChartSpec({ kind: 'pie', groupBy: { field: 'st' } }, matrix, labels, 'en-US')
  assert.deepEqual((pie.data as { value: number }[]).map((r) => r.value), [3, 5, 0])
})

test('user options pass through, ours cannot be overridden by data or theme keys', () => {
  const spec = toChartSpec({ kind: 'donut', groupBy: { field: 'st' }, options: { innerRadius: 0.5, showLabels: false } }, flat, labels, 'en-US')
  assert.equal((spec.options as Record<string, unknown>).innerRadius, 0.5)
  assert.equal((spec.options as Record<string, unknown>).showLabels, false)
  const bad = toChartSpec({ kind: 'donut', groupBy: { field: 'st' }, options: { theme: 'x', locale: 'fr' } as never }, flat, labels, 'en-US')
  assert.equal((bad.options as Record<string, unknown>).theme, undefined)
  assert.equal((bad.options as Record<string, unknown>).locale, 'en-US')
})
