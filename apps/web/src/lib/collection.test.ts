// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CollectionField, RowDTO, ViewConfig } from '@inkling/shared'
import { viewFilterPatch } from '@inkling/shared'
import { applyView, formatTimestamp, formatValue, membersWithPeople } from './collection'

const fields: CollectionField[] = [
  { id: 'st', name: 'Status', type: 'select', options: [{ id: 'a', name: 'Open', color: 'gray' }, { id: 'b', name: 'Done', color: 'green' }] },
  { id: 'n', name: 'Points', type: 'number' },
  { id: 'ct', name: 'Created', type: 'createdTime' },
  { id: 'id', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'TASK' } },
  { id: 'by', name: 'Created by', type: 'createdBy' },
]

const row = (id: string, props: Record<string, unknown>): RowDTO =>
  ({ id, title: id, props, sortOrder: 0 }) as unknown as RowDTO

const rows: RowDTO[] = [
  row('r1', { st: 'a', n: 1, ct: '2026-11-08T10:00:00.000Z', id: 3, by: 'u1' }),
  row('r2', { st: 'b', n: 5, ct: '2026-11-09T23:59:00.000Z', id: 12, by: 'u2' }),
  row('r3', { st: 'a', n: 9, ct: '2026-11-10T00:01:00.000Z', id: 7, by: 'u1' }),
  row('r4', { n: 2, ct: '2026-11-10T09:00:00.000Z', id: 20 }),
]
const ids = (config: ViewConfig) => applyView(rows, fields, config).map((r) => r.id)

test('applyView: legacy flat `filters` still apply as AND', () => {
  assert.deepEqual(ids({ filters: [{ fieldId: 'st', op: 'eq', value: 'a' }, { fieldId: 'n', op: 'gt', value: 4 }] }), ['r3'])
})

test('applyView: OR tree, NOT condition and a negated group', () => {
  // Status is Done OR Points < 2
  assert.deepEqual(
    ids({ filter: { mode: 'or', items: [{ fieldId: 'st', op: 'eq', value: 'b' }, { fieldId: 'n', op: 'lt', value: 2 }] } }),
    ['r1', 'r2'],
  )
  // NOT (Status is Open)
  assert.deepEqual(ids({ filter: { mode: 'and', items: [{ fieldId: 'st', op: 'eq', value: 'a', not: true }] } }), ['r2', 'r4'])
  // Points > 1 AND NOT (Status is Open OR Status is empty)
  assert.deepEqual(
    ids({
      filter: {
        mode: 'and',
        items: [
          { fieldId: 'n', op: 'gt', value: 1 },
          { mode: 'or', not: true, items: [{ fieldId: 'st', op: 'eq', value: 'a' }, { fieldId: 'st', op: 'empty' }] },
        ],
      },
    }),
    ['r2'],
  )
})

test('applyView: the tree wins over a stale legacy list', () => {
  assert.deepEqual(
    ids({ filters: [{ fieldId: 'st', op: 'eq', value: 'b' }], filter: { mode: 'and', items: [{ fieldId: 'n', op: 'gt', value: 8 }] } }),
    ['r3'],
  )
})

test('applyView: a tree saved through viewFilterPatch filters the same rows', () => {
  const plain = { mode: 'and' as const, items: [{ fieldId: 'st', op: 'eq' as const, value: 'a' }] }
  const p1 = viewFilterPatch(plain)
  assert.equal(p1.filter, undefined)
  assert.deepEqual(ids(p1), ['r1', 'r3'])
  const or = { mode: 'or' as const, items: [{ fieldId: 'st', op: 'eq' as const, value: 'b' }, { fieldId: 'id', op: 'eq' as const, value: 'TASK-20' }] }
  const p2 = viewFilterPatch(or)
  assert.deepEqual(p2.filters, [])
  assert.deepEqual(ids(p2), ['r2', 'r4'])
})

test('applyView: timestamps filter by UTC day, IDs by number', () => {
  assert.deepEqual(ids({ filter: { mode: 'and', items: [{ fieldId: 'ct', op: 'eq', value: '2026-11-10' }] } }), ['r3', 'r4'])
  assert.deepEqual(ids({ filter: { mode: 'and', items: [{ fieldId: 'id', op: 'gt', value: 'TASK-7' }] } }), ['r2', 'r4'])
})

test('applyView: sorts IDs numerically and timestamps by the full ISO string', () => {
  assert.deepEqual(ids({ sorts: [{ fieldId: 'id', dir: 'asc' }] }), ['r1', 'r3', 'r2', 'r4'])
  assert.deepEqual(ids({ sorts: [{ fieldId: 'ct', dir: 'desc' }] }), ['r4', 'r3', 'r2', 'r1'])
})

test('formatValue: ID with prefix, person-like names, timestamps in local time', () => {
  const name = (id: string) => ({ u1: 'Ann' })[id]
  assert.equal(formatValue(fields[3], 12), 'TASK-12')
  assert.equal(formatValue(fields[4], 'u1', name), 'Ann')
  const iso = '2026-11-10T09:12:33.120Z'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  assert.equal(formatValue(fields[2], iso), local)
  assert.equal(formatTimestamp('not a date'), '')
})

test('membersWithPeople: adds the guest response names without duplicating members', () => {
  const members = [{ id: 'u1', name: 'Ann', email: 'a@x', role: 'member' as const }]
  assert.equal(membersWithPeople(members, undefined), members)
  const merged = membersWithPeople(members, { u1: 'Ann (people)', u2: 'Bo' })
  assert.deepEqual(
    merged?.map((m) => [m.id, m.name]),
    [
      ['u1', 'Ann'],
      ['u2', 'Bo'],
    ],
  )
  assert.deepEqual(membersWithPeople(undefined, { u2: 'Bo' })?.map((m) => m.name), ['Bo'])
})
