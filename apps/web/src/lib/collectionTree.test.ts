// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CollectionField, RowDTO } from '@inkling/shared'
import { applyView } from './collection'
import { toggleCollapsed, viewTree } from './collectionTree'

const COLL = '00000000-0000-4000-8000-000000000001'
const parent: CollectionField = { id: 'par', name: 'Parent item', type: 'relation', relation: { targetPageId: COLL, subItems: true } }
const fields: CollectionField[] = [{ id: 'n', name: 'N', type: 'number' }, parent]
const row = (id: string, n: number, par?: string): RowDTO =>
  ({ id, title: id, props: { n, ...(par ? { par: [par] } : {}) }, sortOrder: 0 }) as unknown as RowDTO

// a ─ a1 ─ a1x
//   └ a2
// b
const rows = [row('b', 5), row('a2', 4, 'a'), row('a1x', 6, 'a1'), row('a', 1), row('a1', 3, 'a')]
const shape = (t: ReturnType<typeof viewTree<RowDTO>>) => t.rows.map((r) => `${'.'.repeat(t.meta?.get(r.id)?.depth ?? 0)}${r.id}`)

test('viewTree: children follow their parent in the order of the given rows', () => {
  const sorted = applyView(rows, fields, { sorts: [{ fieldId: 'n', dir: 'asc' }] })
  const t = viewTree(sorted, fields, {}, new Set(), COLL)
  assert.deepEqual(shape(t), ['a', '.a1', '..a1x', '.a2', 'b'])
  assert.equal(t.meta?.get('a')?.childCount, 2)
  assert.equal(t.parentField?.id, 'par')
})

test('viewTree: a row whose parent is filtered out becomes top level', () => {
  const filtered = applyView(rows, fields, { filter: { mode: 'and', items: [{ fieldId: 'n', op: 'gt', value: 2 }] } })
  const t = viewTree(filtered, fields, {}, new Set(), COLL)
  assert.deepEqual(shape(t), ['b', 'a2', 'a1', '.a1x'])
})

test('viewTree: collapsed rows hide their descendants; flat views and collections without the field stay flat', () => {
  const sorted = applyView(rows, fields, { sorts: [{ fieldId: 'n', dir: 'asc' }] })
  const collapsed = toggleCollapsed(new Set(), 'a1')
  assert.deepEqual(shape(viewTree(sorted, fields, {}, collapsed, COLL)), ['a', '.a1', '.a2', 'b'])
  assert.deepEqual(shape(viewTree(sorted, fields, {}, toggleCollapsed(collapsed, 'a'), COLL)), ['a', 'b'])
  const flat = viewTree(sorted, fields, { subItems: 'flat' }, new Set(), COLL)
  assert.equal(flat.meta, null)
  assert.deepEqual(flat.rows.map((r) => r.id), ['a', 'a1', 'a2', 'b', 'a1x'])
  // a relation to another collection is not a sub-items field
  assert.equal(viewTree(sorted, fields, {}, new Set(), '00000000-0000-4000-8000-000000000002').meta, null)
})
