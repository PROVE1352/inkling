// Old anchors after heading renames (docs/adr/1501-*): the pure replay of change-log rows.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { refAnchors, traceAnchor } from './sectionMoves'
import type { AnchorEvent } from './sectionMoves'

const ren = (prevAnchor: string, anchor: string): AnchorEvent => ({ kind: 'renamed', prevAnchor, anchor })
const add = (anchor: string): AnchorEvent => ({ kind: 'added', prevAnchor: null, anchor })
const rem = (anchor: string): AnchorEvent => ({ kind: 'removed', prevAnchor: null, anchor })

describe('section moves: replaying renames', () => {
  it('follows one rename, a chain, and a parent rename', () => {
    assert.deepEqual(traceAnchor('setup', [ren('setup', 'install')], ['install', 'other']), { status: 'moved', anchor: 'install' })
    assert.deepEqual(traceAnchor('a', [ren('a', 'b'), ren('b', 'c')], ['c']), { status: 'moved', anchor: 'c' })
    assert.deepEqual(
      traceAnchor('setup/backups', [ren('setup/backups', 'install/backups'), ren('setup', 'install')], ['install', 'install/backups']),
      { status: 'moved', anchor: 'install/backups' },
    )
  })

  it('accepts the forms findSection accepts: §anchor, heading text, heading path, short anchor', () => {
    const ev = [ren('setup/backups', 'install/backups'), ren('setup', 'install')]
    const now = ['install', 'install/backups']
    for (const ref of ['§setup', 'Setup', '#setup', 'Setup › Backups', 'Setup > Backups', 'backups']) {
      const want = ref.toLowerCase().includes('backups') ? 'install/backups' : 'install'
      assert.deepEqual(traceAnchor(ref, ev, now), { status: 'moved', anchor: want }, ref)
    }
    assert.deepEqual(refAnchors('결정 사항'), ['결정 사항', '결정-사항'])
  })

  it('a section that was removed after its rename is not found; renamed back is not a move', () => {
    assert.deepEqual(traceAnchor('a', [ren('a', 'b'), rem('b')], ['c']), { status: 'none' })
    assert.deepEqual(traceAnchor('x', [ren('a', 'b')], ['b']), { status: 'none' })
    assert.deepEqual(traceAnchor('a', [ren('a', 'b'), ren('b', 'a')], ['a']), { status: 'moved', anchor: 'a' })
  })

  it('an old name now leading to two sections is ambiguous', () => {
    // "Setup" → "Install"; later a new "Setup" section is added and renamed to "Setup two"
    const ev = [ren('setup', 'install'), add('setup'), ren('setup', 'setup-two')]
    assert.deepEqual(traceAnchor('setup', ev, ['install', 'setup-two']), { status: 'ambiguous', anchors: ['install', 'setup-two'] })
    // one of them gone again: unambiguous
    assert.deepEqual(traceAnchor('setup', [...ev, rem('setup-two')], ['install']), { status: 'moved', anchor: 'install' })
  })

  it('a later section that only reuses the new name is not followed', () => {
    // "a" → "b", "b" deleted, an unrelated "b" added later: "a" is gone, not that new section
    assert.deepEqual(traceAnchor('a', [ren('a', 'b'), rem('b'), add('b')], ['b']), { status: 'none' })
  })
})
