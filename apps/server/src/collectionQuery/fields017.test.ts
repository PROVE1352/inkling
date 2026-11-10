// 0.17 field types, the view filter tree and sub-item ordering, pure (docs/adr/2140-*, 2142-*, 2144-*).
// The evaluator lives in packages/shared and is the one the web views, charts and the server's chart
// aggregate use, so these cases pin what both sides compute.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fillAutoProps,
  formatUniqueId,
  isFlatAndFilter,
  matchesViewFilter,
  matchesViewFilters,
  parseUniqueId,
  treeRows,
  viewConfigSchema,
  viewFilterOf,
  viewFilterPatch,
} from '@inkling/shared'
import type { CollectionField, ViewFilter } from '@inkling/shared'
import { fieldResolver, kindOf } from './filter'
import { formatCell, mapWrite } from './values'

const status: CollectionField = {
  id: 'st',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', name: 'Todo', color: 'gray' },
    { id: 'done', name: 'Done', color: 'green' },
  ],
}
const pts: CollectionField = { id: 'pt', name: 'Points', type: 'number' }
const uid: CollectionField = { id: 'id', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'TASK' } }
const created: CollectionField = { id: 'ct', name: 'Created', type: 'createdTime' }
const editor: CollectionField = { id: 'eb', name: 'Editor', type: 'editedBy' }
const fields = [status, pts, uid, created, editor]

describe('view filter tree', () => {
  const rows = [
    { st: 'todo', pt: 1, id: 1, ct: '2026-11-09T23:59:00.000Z' },
    { st: 'done', pt: 5, id: 2, ct: '2026-11-10T00:00:00.000Z' },
    { st: 'todo', pt: 8, id: 3, ct: '2026-11-10T12:00:00.000Z' },
    { pt: 3, id: 4, ct: '2026-11-11T00:00:00.000Z' },
  ]
  const ids = (tree: ViewFilter | null) => rows.filter((r) => matchesViewFilter(r, fields, tree)).map((r) => r.id)

  it('reads the pre-0.17 flat list as AND, and the tree wins over it', () => {
    const legacy = { filters: [{ fieldId: 'st', op: 'eq' as const, value: 'todo' }, { fieldId: 'pt', op: 'gt' as const, value: 2 }] }
    assert.deepEqual(ids(viewFilterOf(legacy)), [3])
    assert.equal(matchesViewFilters(rows[2], fields, legacy.filters), true)
    const both = { ...legacy, filter: { mode: 'or' as const, items: [{ fieldId: 'id', op: 'eq' as const, value: 'TASK-4' }] } }
    assert.deepEqual(ids(viewFilterOf(both)), [4])
  })

  it('OR, NOT on a condition and on a group, one level of groups', () => {
    assert.deepEqual(ids({ mode: 'or', items: [{ fieldId: 'st', op: 'eq', value: 'done' }, { fieldId: 'pt', op: 'gt', value: 7 }] }), [2, 3])
    assert.deepEqual(ids({ mode: 'and', items: [{ fieldId: 'st', op: 'eq', value: 'todo', not: true }] }), [2, 4])
    assert.deepEqual(
      ids({ mode: 'and', items: [{ fieldId: 'pt', op: 'gt', value: 0 }, { mode: 'or', not: true, items: [{ fieldId: 'st', op: 'empty' }, { fieldId: 'id', op: 'lt', value: '#2' }] }] }),
      [2, 3],
    )
  })

  it('conditions on deleted fields are ignored, also inside OR groups; an empty tree matches all', () => {
    assert.deepEqual(ids({ mode: 'or', items: [{ fieldId: 'gone', op: 'eq', value: 'x' }] }), [1, 2, 3, 4])
    assert.deepEqual(ids({ mode: 'or', items: [{ fieldId: 'gone', op: 'eq', value: 'x' }, { fieldId: 'id', op: 'eq', value: 3 }] }), [3])
    assert.deepEqual(ids({ mode: 'and', items: [] }), [1, 2, 3, 4])
  })

  it('created time compares by the UTC day; IDs by number with or without the prefix', () => {
    assert.deepEqual(ids({ mode: 'and', items: [{ fieldId: 'ct', op: 'eq', value: '2026-11-10' }] }), [2, 3])
    assert.deepEqual(ids({ mode: 'and', items: [{ fieldId: 'ct', op: 'lt', value: '2026-11-10' }] }), [1])
    assert.deepEqual(ids({ mode: 'and', items: [{ fieldId: 'id', op: 'gt', value: 'task-2' }] }), [3, 4])
    assert.deepEqual(ids({ mode: 'and', items: [{ fieldId: 'id', op: 'contains', value: 'SK-1' }] }), [1])
  })

  it('saving: a plain AND list goes to `filters` (0.16 reads it), anything else to `filter`', () => {
    const flat: ViewFilter = { mode: 'and', items: [{ fieldId: 'st', op: 'eq', value: 'todo' }] }
    assert.equal(isFlatAndFilter(flat), true)
    assert.deepEqual(viewFilterPatch(flat), { filters: [{ fieldId: 'st', op: 'eq', value: 'todo' }], filter: undefined })
    const or: ViewFilter = { mode: 'or', items: flat.items }
    assert.deepEqual(viewFilterPatch(or), { filter: or, filters: [] })
    assert.deepEqual(viewFilterPatch({ mode: 'and', items: [{ fieldId: 'st', op: 'eq', value: 'todo', not: true }] }).filters, [])
    assert.deepEqual(viewFilterPatch(null), { filters: [], filter: undefined })
  })

  it('the stored shape: groups hold conditions only, at most 10 items per level', () => {
    const nested = { filter: { mode: 'and', items: [{ mode: 'or', items: [{ mode: 'and', items: [] }] }] } }
    assert.equal(viewConfigSchema.safeParse(nested).success, false)
    const many = { filter: { mode: 'and', items: Array.from({ length: 11 }, () => ({ fieldId: 'st', op: 'empty' })) } }
    assert.equal(viewConfigSchema.safeParse(many).success, false)
    assert.equal(viewConfigSchema.safeParse({ filter: { mode: 'or', items: [{ mode: 'and', not: true, items: [{ fieldId: 'st', op: 'eq', value: 'x' }] }] } }).success, true)
  })
})

describe('unique IDs and automatic values', () => {
  it('formats and parses IDs', () => {
    assert.equal(formatUniqueId(uid, 12), 'TASK-12')
    assert.equal(formatUniqueId({ uniqueId: {} }, 12), '12')
    assert.equal(formatUniqueId(uid, null), '')
    for (const s of ['TASK-12', 'task-12', '#12', '12', 12]) assert.equal(parseUniqueId(uid, s), 12, String(s))
    for (const s of ['TASK-', 'OTHER-12', '-3', '0', 'TASK-1.5', 1.5]) assert.equal(parseUniqueId(uid, s), null, String(s))
  })

  it('fills automatic values from the page columns; the creator stands in until someone edits', () => {
    const fs: CollectionField[] = [created, editor, { id: 'cb', name: 'By', type: 'createdBy' }, uid]
    const props: Record<string, unknown> = { ct: 'stale', eb: 'stale' }
    const at = new Date('2026-11-10T01:02:03.456Z')
    fillAutoProps(fs, props, { createdAt: at, updatedAt: at, createdBy: 'u1', createdVia: 'Claude Code', editedBy: null, editedVia: null, rowNumber: 7 })
    assert.deepEqual(props, { ct: '2026-11-10T01:02:03.456Z', eb: 'u1', 'via:eb': 'Claude Code', cb: 'u1', 'via:cb': 'Claude Code', id: 7 })
    fillAutoProps(fs, props, { createdAt: at, updatedAt: at, createdBy: 'u1', createdVia: 'Claude Code', editedBy: 'u2', editedVia: null, rowNumber: 7 })
    assert.equal(props.eb, 'u2')
    assert.equal('via:eb' in props, false, 'a browser edit has no via')
  })

  it('query_rows kinds, cells and writes', () => {
    const r = fieldResolver([...fields, { id: 'em', name: 'Mail', type: 'email' }, { id: 'ph', name: 'Phone', type: 'phone' }])
    assert.equal(kindOf(r.resolve('ID')), 'number')
    assert.equal(kindOf(r.resolve('Created')), 'date')
    assert.equal(kindOf(r.resolve('Editor')), 'person')
    assert.equal(kindOf(r.resolve('Mail')), 'text')
    const ctx = { refTitles: new Map<string, string>(), personNames: new Map([['u2', 'Minho']]) }
    const props = { id: 3, ct: '2026-11-10T01:02:03.456Z', eb: 'u2', 'via:eb': 'Claude Code' }
    assert.equal(formatCell(r.resolve('ID'), '', props, ctx), 'TASK-3')
    assert.equal(formatCell(r.resolve('Created'), '', props, ctx), '2026-11-10T01:02Z')
    assert.equal(formatCell(r.resolve('Editor'), '', props, ctx), 'Minho (via Claude Code)')
    assert.throws(() => mapWrite(fields, { ID: 4 }, { userId: 'u', today: '2026-11-10' }), /"ID" is an automatic value/)
    assert.throws(() => mapWrite([...fields, { id: 'em', name: 'Mail', type: 'email' }], { Mail: 'not an address' }, { userId: 'u', today: '2026-11-10' }), /email/)
    assert.deepEqual(mapWrite([{ id: 'ph', name: 'Phone', type: 'phone' }], { Phone: '+82 10-1234-5678' }, { userId: 'u', today: '2026-11-10' }).props, { ph: '+82 10-1234-5678' })
  })
})

describe('sub-item order', () => {
  const parent: CollectionField = { id: 'p', name: 'Parent', type: 'relation', relation: { targetPageId: '00000000-0000-4000-8000-000000000000', subItems: true } }
  const row = (id: string, p?: string) => ({ id, props: p ? { p: [p] } : {} })
  const list = [row('a'), row('b'), row('a1', 'a'), row('a2', 'a'), row('a1x', 'a1'), row('o', 'gone'), row('c1', 'c2'), row('c2', 'c1')]

  it('children follow their parent depth-first; a missing parent makes a top-level row; a loop still shows every row once', () => {
    const t = treeRows(list, parent)
    assert.deepEqual(t.map((x) => `${x.row.id}:${x.depth}`), ['a:0', 'a1:1', 'a1x:2', 'a2:1', 'b:0', 'o:0', 'c1:0', 'c2:1'])
    assert.equal(t.find((x) => x.row.id === 'a')!.childCount, 2)
  })

  it('collapsed rows hide their descendants; no field = flat', () => {
    assert.deepEqual(treeRows(list, parent, new Set(['a'])).map((x) => x.row.id), ['a', 'b', 'o', 'c1', 'c2'])
    assert.deepEqual(treeRows(list, null).map((x) => x.depth), list.map(() => 0))
  })
})
