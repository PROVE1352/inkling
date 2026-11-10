// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/workspaceListing.test.ts
// The workspace switcher's order with groups and archived workspaces (docs/adr/2300-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { arrangeWorkspaces, hasArrangement, landingWorkspace, moveId, switcherOrder } from './workspaceListing'

const ws = (id, name, listing) => ({ id, name, icon: null, inviteCode: '', role: 'owner', ...(listing ? { listing } : {}) })
const g = (id, name) => ({ id, name, collapsed: false })

describe('arrangeWorkspaces', () => {
  it('nothing arranged: the server order, one part, no shape change', () => {
    const list = [ws('a', 'A'), ws('b', 'B'), ws('c', 'C')]
    const r = arrangeWorkspaces(list, [])
    assert.deepEqual(r.ungrouped.map((w) => w.id), ['a', 'b', 'c'])
    assert.deepEqual(r.groups, [])
    assert.deepEqual(r.archived, [])
    assert.equal(hasArrangement(list, []), false)
    assert.deepEqual(switcherOrder(list, []).map((w) => w.id), ['a', 'b', 'c'])
  })

  it('ungrouped first, groups in order with positions, archived last by name', () => {
    const list = [
      ws('a', 'Alpha'),
      ws('b', 'Beta', { groupId: 'g2', group: 'Contests', position: 1 }),
      ws('c', 'Gamma', { groupId: 'g2', group: 'Contests', position: 0 }),
      ws('d', 'Delta', { groupId: 'g1', group: 'Classes' }),
      ws('e', 'Zulu old', { archived: true, groupId: 'g2', group: 'Contests', position: 2 }),
      ws('f', 'Echo old', { archived: true }),
      ws('h', 'Hotel', { position: 0 }),
    ]
    const groups = [g('g1', 'Classes'), g('g2', 'Contests')]
    const r = arrangeWorkspaces(list, groups)
    assert.deepEqual(r.ungrouped.map((w) => w.id), ['h', 'a'], 'positioned first, then server order')
    assert.deepEqual(r.groups.map((x) => [x.group.id, x.items.map((w) => w.id)]), [['g1', ['d']], ['g2', ['c', 'b']]])
    assert.deepEqual(r.archived.map((w) => w.id), ['f', 'e'])
    assert.deepEqual(switcherOrder(list, groups).map((w) => w.id), ['h', 'a', 'd', 'c', 'b', 'f', 'e'])
    assert.equal(hasArrangement(list, groups), true)
  })

  it('a group id the list no longer has counts as no group; an empty group still shows', () => {
    const r = arrangeWorkspaces([ws('a', 'A', { groupId: 'gone', group: 'Gone' })], [g('g1', 'Empty')])
    assert.deepEqual(r.ungrouped.map((w) => w.id), ['a'])
    assert.deepEqual(r.groups.map((x) => [x.group.id, x.items.length]), [['g1', 0]])
  })

  it('archived only: the shape changes even without groups', () => {
    assert.equal(hasArrangement([ws('a', 'A', { archived: true })], []), true)
  })
})

describe('landingWorkspace', () => {
  const list = [ws('a', 'A', { archived: true }), ws('b', 'B', { groupId: 'g', group: 'G' }), ws('c', 'C')]
  it('the last one used wins, archived or not', () => {
    assert.equal(landingWorkspace(list, [g('g', 'G')], 'a').id, 'a')
  })
  it('otherwise the first not archived in switcher order', () => {
    assert.equal(landingWorkspace(list, [g('g', 'G')], null).id, 'c')
    assert.equal(landingWorkspace(list, [g('g', 'G')], 'missing').id, 'c')
  })
  it('everything archived: the first one', () => {
    assert.equal(landingWorkspace([ws('x', 'X', { archived: true })], [], null).id, 'x')
  })
})

describe('moveId', () => {
  it('moves inside the list and ignores out-of-range moves', () => {
    assert.deepEqual(moveId(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
    assert.deepEqual(moveId(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
    assert.deepEqual(moveId(['a', 'b'], 0, 5), ['a', 'b'])
  })
})
