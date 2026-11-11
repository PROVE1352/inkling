// @ts-nocheck
// Charts on public pages (docs/adr/2440-*): the public form of an aggregate keeps labels, order and
// numbers and drops every key and source detail; the chart drawn from it is the spec the app draws
// from the full aggregate, for every kind (the library's own validateSpec accepts it).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateSpec } from 'ztd-charts/spec'
import { CHART_KINDS, chartDataOfPublic, chartTableMarkdown, publicChartOf } from '@inkling/shared'
import { chartTables } from '../../lib/publicCharts'
import { toChartSpec } from './adapter'

const labels = { noValue: 'No value', checked: 'Checked', unchecked: 'Unchecked', measure: 'Sum · Points' }
const data = {
  source: { type: 'collection', id: 'COLLECTION-ID', title: 'Secret collection', viewName: 'Secret view' },
  group: { field: 'FIELD-ST', name: 'Status', type: 'select' },
  series: { field: 'FIELD-OW', name: 'Owner', type: 'person' },
  measure: { fn: 'sum', field: 'FIELD-PTS', name: 'Points' },
  groups: [
    { key: 'OPT-TODO', label: 'Todo' },
    { key: null, label: '(empty)', special: 'empty' },
  ],
  seriesKeys: [
    { key: 'MEMBER-ANN', label: 'Ann' },
    { key: 'MEMBER-BO', label: 'Bo' },
  ],
  values: [
    [3, 1],
    [0, 2],
  ],
  rowCount: 6,
  omittedGroups: 1,
  omittedSeries: 0,
  elapsedMs: 4,
  cached: true,
}

test('the public form has labels and numbers only', () => {
  const p = publicChartOf('ic-0a1b2c3d4e5f-0', { kind: 'stackedBar', title: 'Load' }, data)
  const text = JSON.stringify(p)
  for (const secret of ['COLLECTION-ID', 'Secret collection', 'Secret view', 'FIELD-', 'OPT-TODO', 'MEMBER-', 'rowCount', 'elapsedMs', 'cached', '"key"'])
    assert.ok(!text.includes(secret), secret)
  assert.deepEqual(p, {
    anchor: 'ic-0a1b2c3d4e5f-0',
    kind: 'stackedBar',
    title: 'Load',
    group: 'Status',
    series: 'Owner',
    measure: { fn: 'sum', name: 'Points' },
    groups: [{ label: 'Todo' }, { label: '(empty)', special: 'empty' }],
    seriesKeys: [{ label: 'Ann' }, { label: 'Bo' }],
    values: [
      [3, 1],
      [0, 2],
    ],
    omittedGroups: 1,
    omittedSeries: 0,
  })
  // a copy: the cached aggregate is not shared with the response
  assert.notEqual(p.values, data.values)
  assert.notEqual(p.values[0], data.values[0])
})

test('every kind draws the same spec from the public form as from the aggregate', () => {
  for (const kind of CHART_KINDS) {
    const p = publicChartOf('a', { kind }, data)
    const fromPublic = toChartSpec({ kind }, chartDataOfPublic(p), labels, 'en-US')
    const fromApp = toChartSpec({ kind, groupBy: { field: 'FIELD-ST' } }, data, labels, 'en-US')
    assert.deepEqual(fromPublic, fromApp, kind)
    assert.equal(validateSpec(fromPublic).valid, true, kind)
  }
})

test('the table written from the public form is the export table', () => {
  const p = publicChartOf('a', { kind: 'bar' }, data)
  assert.equal(chartTableMarkdown(chartDataOfPublic(p), { empty: 'No value' }), chartTableMarkdown(data, { empty: 'No value' }))
})

test('placeholders are found by anchor only; a malformed anchor is never put in a selector', () => {
  const seen = []
  const root = {
    querySelector: (sel) => {
      seen.push(sel)
      return sel.includes('-t"]') ? { table: true } : null
    },
  }
  const found = chartTables(root, [{ anchor: 'ic-ab-0' }, { anchor: 'x"] , body [a="' }])
  assert.equal(found.length, 1)
  assert.deepEqual(seen, ['.bn-block-outer[data-id="ic-ab-0-t"]', '.bn-block-outer[data-id="ic-ab-0"]'])
})
