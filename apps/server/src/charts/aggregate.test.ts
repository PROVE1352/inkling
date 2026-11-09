// Chart stored format, pure aggregation and the chart token (docs/adr/1600-*, 1602-*, 1604-*). Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateItems,
  canonicalChartJson,
  chartBlockConfigSchema,
  chartSummaryLine,
  chartTableMarkdown,
  collectionKeys,
  dateBucket,
  matchesViewFilters,
  parseChartBlockConfig,
  queryCellKeys,
  viewConfigSchema,
  createViewSchema,
} from '@inkling/shared'
import type { ChartDataDTO, ChartItem, CollectionField } from '@inkling/shared'
import { blocksToFullHTML, blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'

const C = '6f1c2a10-1111-4c3b-9a55-0123456789ab'
const status: CollectionField = {
  id: 'st',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', name: 'Todo', color: 'gray' },
    { id: 'doing', name: 'Doing', color: 'blue' },
    { id: 'done', name: 'Done', color: 'green' },
  ],
}
const tags: CollectionField = {
  id: 'tg',
  name: 'Tags',
  type: 'multiSelect',
  options: [
    { id: 'a', name: 'A', color: 'red' },
    { id: 'b', name: 'B', color: 'blue' },
  ],
}
const owner: CollectionField = { id: 'ow', name: 'Owner', type: 'person' }
const due: CollectionField = { id: 'du', name: 'Due', type: 'date' }
const done: CollectionField = { id: 'ck', name: 'Done', type: 'checkbox' }
const links: CollectionField = { id: 'rl', name: 'Blocks', type: 'relation', relation: { targetPageId: C } }
const resolvers = {
  memberName: (id: string) => (id === 'u-ann' ? 'Ann' : undefined),
  refTitle: (id: string) => (id === 'r-vis' ? 'Visible row' : undefined),
}

describe('chart stored format', () => {
  it('accepts a config, rejects data, unknown keys and option data/theme', () => {
    const ok = chartBlockConfigSchema.safeParse({ source: { type: 'collection', collectionId: C }, kind: 'bar', groupBy: { field: 'st' } })
    assert.equal(ok.success, true)
    for (const bad of [
      { source: { type: 'collection', collectionId: C }, kind: 'bar', groupBy: { field: 'st' }, data: [{ a: 1 }] },
      { source: { type: 'collection', collectionId: C }, kind: 'bar', groupBy: { field: 'st' }, options: { data: 'x' } },
      { source: { type: 'collection', collectionId: C }, kind: 'bar', groupBy: { field: 'st' }, options: { theme: 'dark' } },
      { source: { type: 'url', url: 'https://example.com/x.json' }, kind: 'bar', groupBy: { field: 'st' } },
      { source: { type: 'collection', collectionId: C }, kind: 'sankey', groupBy: { field: 'st' } },
      { source: { type: 'collection', collectionId: C }, kind: 'bar', groupBy: { field: 'st' }, measure: { fn: 'sum' } },
    ]) {
      assert.equal(chartBlockConfigSchema.safeParse(bad).success, false, JSON.stringify(bad))
    }
  })

  it('canonical JSON drops defaults and sorts keys, so a round trip gives the same string', () => {
    const a = canonicalChartJson({
      title: '',
      sort: 'auto',
      measure: { fn: 'count' },
      kind: 'bar',
      groupBy: { field: 'st' },
      source: { type: 'collection', collectionId: C },
    })
    assert.equal(a, `{"groupBy":{"field":"st"},"kind":"bar","source":{"collectionId":"${C}","type":"collection"}}`)
    assert.equal(canonicalChartJson(parseChartBlockConfig(a)!), a)
    assert.equal(parseChartBlockConfig(''), null)
    assert.equal(parseChartBlockConfig('{"kind":"bar"}'), null)
  })

  it('view config takes chart settings (no source) and the chart view type', () => {
    assert.equal(viewConfigSchema.safeParse({ chart: { kind: 'donut', groupBy: { field: 'st' } } }).success, true)
    assert.equal(viewConfigSchema.safeParse({ chart: { kind: 'donut', groupBy: { field: 'st' }, source: { type: 'query', query: 'LIST' } } }).success, false)
    assert.equal(createViewSchema.safeParse({ name: 'Chart', type: 'chart', config: { chart: { kind: 'bar', groupBy: { field: 'st' } } } }).success, true)
  })
})

describe('chart keys', () => {
  it('dates go to day / ISO week (Monday) / month buckets', () => {
    assert.equal(dateBucket('2026-11-11', 'week'), '2026-11-09')
    assert.equal(dateBucket('2026-11-09T10:00', 'week'), '2026-11-09')
    assert.equal(dateBucket('2026-11-15', 'week'), '2026-11-09')
    assert.equal(dateBucket('2026-01-01', 'week'), '2025-12-29')
    assert.equal(dateBucket('2026-11-15', 'month'), '2026-11')
    assert.equal(dateBucket('2026-11-15', undefined), '2026-11-15')
    assert.equal(dateBucket('soon', 'day'), null)
  })

  it('collection values: options by name, people by member name only, relations by visible title', () => {
    assert.deepEqual(collectionKeys(status, 'doing', 'x', undefined, resolvers).map((k) => k.label), ['Doing'])
    assert.deepEqual(collectionKeys(status, 'gone', 'x', undefined, resolvers).map((k) => k.key), [null])
    assert.deepEqual(collectionKeys(tags, ['a', 'b', 'a', 'zz'], 'x', undefined, resolvers).map((k) => k.label), ['A', 'B'])
    assert.deepEqual(collectionKeys(owner, 'u-ann', 'x', undefined, resolvers).map((k) => k.label), ['Ann'])
    // a non-member's id is never a label or a key
    const outsider = collectionKeys(owner, 'u-outsider', 'x', undefined, resolvers)
    assert.deepEqual(outsider.map((k) => [k.key, k.special]), [[null, 'empty']])
    assert.deepEqual(collectionKeys(links, ['r-vis', 'r-hidden'], 'x', undefined, resolvers).map((k) => k.label), ['Visible row'])
    assert.deepEqual(collectionKeys(links, ['r-hidden'], 'x', undefined, resolvers).map((k) => k.key), [null])
    assert.deepEqual(collectionKeys(done, undefined, 'x', undefined, resolvers).map((k) => k.special), ['unchecked'])
    assert.deepEqual(collectionKeys(due, '2026-11-12', 'x', 'month', resolvers).map((k) => k.key), ['2026-11'])
    assert.deepEqual(collectionKeys('title', null, 'Launch', undefined, resolvers).map((k) => k.label), ['Launch'])
  })

  it('query cells: page refs by title, arrays per element, dates bucketed', () => {
    assert.deepEqual(queryCellKeys([{ ref: 'page', pageId: 'p1', title: 'One' }, { ref: 'page', pageId: 'p1', title: 'One' }], undefined).map((k) => k.label), ['One'])
    assert.deepEqual(queryCellKeys('2026-11-12', 'month').map((k) => k.key), ['2026-11'])
    assert.deepEqual(queryCellKeys(null, undefined).map((k) => k.special), ['empty'])
    assert.deepEqual(queryCellKeys(true, undefined).map((k) => k.special), ['checked'])
  })

  it('view filters match like the web views', () => {
    assert.equal(matchesViewFilters({ st: 'done' }, [status], [{ fieldId: 'st', op: 'eq', value: 'done' }]), true)
    assert.equal(matchesViewFilters({ st: 'todo' }, [status], [{ fieldId: 'st', op: 'eq', value: 'done' }]), false)
    assert.equal(matchesViewFilters({ tg: ['a'] }, [tags], [{ fieldId: 'tg', op: 'eq', value: 'a' }]), true)
    assert.equal(matchesViewFilters({}, [status], [{ fieldId: 'missing', op: 'eq', value: 'x' }]), true)
  })
})

describe('aggregateItems', () => {
  const key = (k: string | null, order: number | string = k ?? '') =>
    k === null ? { key: null, label: '(empty)', special: 'empty' as const, order: Number.POSITIVE_INFINITY } : { key: k, label: k, order }
  const items: ChartItem[] = [
    { groups: [key('Todo', 0)], value: 1 },
    { groups: [key('Done', 2)], value: 5 },
    { groups: [key('Done', 2)], value: null },
    { groups: [key(null)], value: 2 },
    { groups: [key('Doing', 1)], value: 3 },
    { groups: [key('Done', 2)], value: 4 },
  ]

  it('count / sum / avg / min / max; natural order kept, "no value" last', () => {
    const c = aggregateItems(items, { fn: 'count', naturalGroups: true })
    assert.deepEqual(c.groups.map((g) => g.key), ['Todo', 'Doing', 'Done', null])
    assert.deepEqual(c.values, [1, 1, 3, 1])
    assert.deepEqual(aggregateItems(items, { fn: 'sum', naturalGroups: true }).values, [1, 3, 9, 2])
    assert.deepEqual(aggregateItems(items, { fn: 'avg', naturalGroups: true }).values, [1, 3, 4.5, 2])
    assert.deepEqual(aggregateItems(items, { fn: 'min', naturalGroups: true }).values, [1, 3, 4, 2])
    assert.deepEqual(aggregateItems(items, { fn: 'max', naturalGroups: true }).values, [1, 3, 5, 2])
  })

  it('without a natural order the largest group comes first; limit counts the rest', () => {
    const r = aggregateItems(items, { fn: 'count', naturalGroups: false, limit: 2 })
    // ties keep the natural order (Todo before Doing)
    assert.deepEqual(r.groups.map((g) => g.key), ['Done', 'Todo'])
    assert.equal(r.omittedGroups, 2)
    const asc = aggregateItems(items, { fn: 'sum', naturalGroups: true, sort: 'valueAsc' })
    assert.deepEqual(asc.groups.map((g) => g.key), ['Todo', 'Doing', 'Done', null])
    const lab = aggregateItems(items, { fn: 'sum', naturalGroups: true, sort: 'label' })
    assert.deepEqual(lab.groups.map((g) => g.key), ['Doing', 'Done', 'Todo', null])
  })

  it('a row with several keys counts once in each; series give a matrix', () => {
    const r = aggregateItems(
      [
        { groups: [key('A', 0), key('B', 1)], series: [key('x')], value: 2 },
        { groups: [key('A', 0)], series: [key('y')], value: 3 },
      ],
      { fn: 'sum', naturalGroups: true, naturalSeries: true },
    )
    assert.deepEqual(r.groups.map((g) => g.key), ['A', 'B'])
    assert.deepEqual(r.seriesKeys?.map((s) => s.key), ['x', 'y'])
    assert.deepEqual(r.values, [
      [2, 3],
      [2, 0],
    ])
  })
})

describe('chart text', () => {
  const data: ChartDataDTO = {
    source: { type: 'collection', id: C, title: 'Roadmap' },
    group: { field: 'st', name: 'Status', type: 'select' },
    measure: { fn: 'count' },
    groups: [
      { key: 'done', label: 'Done | shipped' },
      { key: null, label: '(empty)', special: 'empty' },
    ],
    values: [12, 3],
    rowCount: 15,
    omittedGroups: 0,
    omittedSeries: 0,
    elapsedMs: 1,
  }
  it('summary line and Markdown table', () => {
    assert.equal(chartSummaryLine(data), 'count by Status: Done | shipped 12, (empty) 3 (15 rows)')
    assert.equal(chartTableMarkdown(data, { empty: 'No value' }), '| Status | Count |\n| --- | --- |\n| Done \\| shipped | 12 |\n| No value | 3 |')
  })
})

describe('chart token (agent notation)', () => {
  const cfg = canonicalChartJson({ source: { type: 'collection', collectionId: C }, kind: 'donut', groupBy: { field: 'st' }, title: 'a --> b' })
  const block = (config: string): AnyBlock => ({ type: 'chart', props: { config }, children: [] }) as AnyBlock

  it('reads as one token line with the config object, writes back the same block', async () => {
    const md = (await blocksToMarkdown([block(cfg)], { assetMode: 'absolute', notation: 'agent' })).markdown.trim()
    assert.match(md, /^<!-- inkling:chart \{"groupBy":\{"field":"st"\},"kind":"donut",.*\} -->$/)
    assert.doesNotMatch(md.slice(4, -3), /--/)
    const back = await markdownToBlocks(md, () => null)
    assert.equal(back.length, 1)
    assert.equal(back[0].type, 'chart')
    assert.equal(back[0].props?.config, cfg)
  })

  it('an empty block is {}, a summary comment next to the token is dropped, a bad config is not a block', async () => {
    const md = (await blocksToMarkdown([block('')], { assetMode: 'absolute', notation: 'agent' })).markdown.trim()
    assert.equal(md, '<!-- inkling:chart {} -->')
    const withSummary = `${md}\n<!-- inkling:chart-data count by Status: Done 3 (3 rows) -->\n\nafter`
    const back = await markdownToBlocks(withSummary, () => null)
    assert.deepEqual(back.map((b) => b.type), ['chart', 'paragraph'])
    const bad = await markdownToBlocks(`<!-- inkling:chart {"kind":"bar","source":{"type":"query","query":"LIST"},"groupBy":{"field":"x"},"options":{"data":"https://evil"}} -->`, () => null)
    assert.equal(bad.some((b) => b.type === 'chart'), false)
  })

  it('plain Markdown and public HTML leave the chart out (exports replace it with a table first)', async () => {
    const md = (await blocksToMarkdown([block(cfg)], { assetMode: 'absolute' })).markdown
    assert.doesNotMatch(md, /inkling:chart|groupBy/)
    const html = await blocksToFullHTML([block(cfg)])
    assert.doesNotMatch(html, /groupBy|collectionId/)
  })
})
