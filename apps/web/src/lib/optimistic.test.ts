// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/optimistic.test.ts
// Targeted optimistic rollback (docs/adr/0853-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { patchItems, patchRowProps, revertItems, revertRowProps } from './optimistic'

describe('patchItems / revertItems (0853)', () => {
  const base = [
    { id: 'a', title: 'A', parentId: null },
    { id: 'b', title: 'B', parentId: null },
  ]

  it('a failed mutation reverts only its own fields, keeping a later mutation on another item', () => {
    const m1 = patchItems(base, new Map([['a', { title: 'A1' }]]))
    const m2 = patchItems(m1.list, new Map([['b', { title: 'B2' }]]))
    const after = revertItems(m2.list, m1.undo) // m1 fails after m2 was applied
    assert.deepEqual(after, [
      { id: 'a', title: 'A', parentId: null },
      { id: 'b', title: 'B2', parentId: null },
    ])
  })

  it('does not clobber a newer write to the same field', () => {
    const m1 = patchItems(base, new Map([['a', { title: 'A1' }]]))
    const m2 = patchItems(m1.list, new Map([['a', { title: 'A2' }]]))
    assert.equal(revertItems(m2.list, m1.undo)[0].title, 'A2')
    // …but the newer one failing restores the value it replaced
    assert.equal(revertItems(m2.list, m2.undo)[0].title, 'A1')
  })

  it('leaves server data from a refetch alone', () => {
    const m1 = patchItems(base, new Map([['a', { parentId: 'b' }]]))
    const refetched = [{ id: 'a', title: 'A', parentId: 'server' }, base[1]]
    assert.equal(revertItems(refetched, m1.undo)[0].parentId, 'server')
  })

  it('restores absent fields as absent', () => {
    const m1 = patchItems(base, new Map([['a', { icon: 'x' }]]))
    assert.equal('icon' in revertItems(m1.list, m1.undo)[0], false)
  })
})

describe('patchRowProps / revertRowProps (0853)', () => {
  const rows = [{ id: 'r', props: { s: 'todo', n: 1 } }]
  it('merges with null-delete and reverts per key', () => {
    const m1 = patchRowProps(rows, 'r', { s: 'done', n: null })
    assert.deepEqual(m1.rows[0].props, { s: 'done' })
    const m2 = patchRowProps(m1.rows, 'r', { s: 'later' })
    const after = revertRowProps(m2.rows, m1.undo)
    assert.deepEqual(after[0].props, { s: 'later', n: 1 })
  })
})
