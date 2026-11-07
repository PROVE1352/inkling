// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Unified diff rows and activity day grouping (docs/adr/1003-*, 1004-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffIsEmpty, diffRows } from './diff'
import { groupByDay, localDayKey, relativeDay } from './activity'

const eq = (s) => ({ t: '=', s })

describe('diffRows', () => {
  it('keeps changes and folds long unchanged runs around them', () => {
    const ops = [
      ...Array.from({ length: 10 }, (_, i) => eq(`a${i}`)),
      { t: '-', s: 'old' },
      { t: '+', s: 'new' },
      ...Array.from({ length: 10 }, (_, i) => eq(`b${i}`)),
    ]
    const rows = diffRows(ops, 2)
    assert.deepEqual(rows, [
      { t: 'skip', count: 8 },
      eq('a8'),
      eq('a9'),
      { t: '-', s: 'old' },
      { t: '+', s: 'new' },
      eq('b0'),
      eq('b1'),
      { t: 'skip', count: 8 },
    ])
  })

  it('keeps short unchanged runs between changes intact', () => {
    const ops = [{ t: '-', s: 'x' }, eq('1'), eq('2'), eq('3'), { t: '+', s: 'y' }]
    assert.deepEqual(diffRows(ops, 1), ops)
  })

  it('splits units that carry newlines into rows', () => {
    assert.deepEqual(diffRows([{ t: '+', s: 'a\nb' }]), [
      { t: '+', s: 'a' },
      { t: '+', s: 'b' },
    ])
  })

  it('detects an empty edit script', () => {
    assert.equal(diffIsEmpty([eq('a')]), true)
    assert.equal(diffIsEmpty([eq('a'), { t: '+', s: 'b' }]), false)
  })
})

describe('groupByDay', () => {
  it('groups consecutive items of one local day, newest first', () => {
    const at = (y, m, d, h) => new Date(y, m - 1, d, h).toISOString()
    const items = [
      { id: 1, changedAt: at(2026, 11, 7, 15) },
      { id: 2, changedAt: at(2026, 11, 7, 9) },
      { id: 3, changedAt: at(2026, 11, 6, 23) },
    ]
    const g = groupByDay(items)
    assert.deepEqual(
      g.map((x) => [x.day, x.items.map((i) => i.id)]),
      [
        ['2026-11-07', [1, 2]],
        ['2026-11-06', [3]],
      ],
    )
  })

  it('names today and yesterday', () => {
    const now = new Date(2026, 10, 7, 10)
    assert.equal(relativeDay('2026-11-07', now), 'today')
    assert.equal(relativeDay('2026-11-06', now), 'yesterday')
    assert.equal(relativeDay('2026-11-01', now), null)
    assert.equal(localDayKey('nope'), '')
  })
})
