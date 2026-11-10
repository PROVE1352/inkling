// Section names for writes (docs/adr/1960-*): matchSectionRef keeps findSection's rules but returns
// every candidate of a loose ref; rivalSections finds live sections that answered to the name before,
// from the change log and from an index that has not caught up with typing yet.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findSection, matchSectionRef, refNameForms } from './chunker'
import { rivalSections } from './sectionMoves'
import type { AnchorEvent } from './sectionMoves'

const sec = (anchor: string, blockId: string | null, headingPath: string[], version = `v-${anchor}`) => ({ anchor, blockId, headingPath, version })

describe('matchSectionRef', () => {
  const outline = [
    sec('_intro', null, []),
    sec('beta', 'b0', ['Beta']),
    sec('beta/decided', 'b1', ['Beta', 'Decided']),
    sec('alpha', 'a0', ['Alpha']),
    sec('alpha/decided', 'a1', ['Alpha', 'Decided']),
    sec('alpha/notes', 'a2', ['Alpha', 'Notes']),
  ]
  it('exact: the anchor, a block id, the whole path in any form', () => {
    for (const ref of ['alpha/decided', '§alpha/decided', 'a1', 'Alpha › Decided', 'alpha > decided', 'ALPHA/DECIDED']) {
      const m = matchSectionRef(outline, ref)
      assert.equal(m.kind, 'exact', ref)
      assert.equal(m.kind === 'exact' && m.section.anchor, 'alpha/decided', ref)
    }
    const b = matchSectionRef(outline, 'a1')
    assert.ok(b.kind === 'exact' && b.byBlockId)
  })
  it('loose: every section the end of the path fits, where findSection takes the first', () => {
    const m = matchSectionRef(outline, 'decided')
    assert.deepEqual(m.kind === 'loose' && m.candidates.map((s) => s.anchor), ['beta/decided', 'alpha/decided'])
    assert.equal(findSection(outline, 'decided')?.anchor, 'beta/decided')
    const one = matchSectionRef(outline, 'Notes')
    assert.deepEqual(one.kind === 'loose' && one.candidates.map((s) => s.anchor), ['alpha/notes'])
    assert.equal(findSection(outline, 'Notes')?.anchor, 'alpha/notes', 'one candidate = what findSection returns')
    assert.equal(matchSectionRef(outline, 'nowhere').kind, 'none')
  })
  it('a repeated path (`~2`) does not make the short anchor of the first one loose-ambiguous', () => {
    const twin = [sec('beta/decided', 'b1', ['Beta', 'Decided']), sec('beta/decided~2', 'b2', ['Beta', 'Decided'])]
    const m = matchSectionRef(twin, 'decided')
    assert.deepEqual(m.kind === 'loose' && m.candidates.map((s) => s.anchor), ['beta/decided'])
    assert.deepEqual(refNameForms('Alpha › Decided'), ['alpha › decided', 'alpha/decided'])
  })
})

describe('rivalSections', () => {
  // after "# Beta / ## Decided" went in between "# Alpha" and its "## Decided"
  const outline = [
    sec('alpha', 'a0', ['Alpha']),
    sec('beta', 'b0', ['Beta']),
    sec('beta/decided', 'b1', ['Beta', 'Decided']),
    sec('beta/decided~2', 'a1', ['Beta', 'Decided']),
  ]
  const target = [outline[2]]
  const forms = refNameForms('decided')
  it('change log: the section that was alpha/decided is now beta/decided~2', () => {
    const events: AnchorEvent[] = [
      { kind: 'added', anchor: 'alpha', prevAnchor: null },
      { kind: 'added', anchor: 'alpha/decided', prevAnchor: null },
      { kind: 'renamed', anchor: 'beta/decided~2', prevAnchor: 'alpha/decided' },
      { kind: 'added', anchor: 'beta', prevAnchor: null },
      { kind: 'added', anchor: 'beta/decided', prevAnchor: null },
    ]
    const fresh = outline.map((s) => ({ anchor: s.anchor, blockId: s.blockId }))
    assert.deepEqual(rivalSections(outline, target, null, forms, events, fresh).map((s) => s.anchor), ['beta/decided~2'])
    // no change rows (or none that fit): no rival
    assert.deepEqual(rivalSections(outline, target, null, forms, [], fresh), [])
  })
  it('index not caught up with typing: indexed alpha/decided is block a1, which is beta/decided~2 now', () => {
    const stale = [
      { anchor: 'alpha', blockId: 'a0' },
      { anchor: 'alpha/decided', blockId: 'a1' },
    ]
    assert.deepEqual(rivalSections(outline, target, null, forms, [], stale).map((s) => s.anchor), ['beta/decided~2'])
    // a deleted block is no rival
    assert.deepEqual(rivalSections(outline, target, null, forms, [], [{ anchor: 'alpha/decided', blockId: 'gone' }]), [])
  })
  it('exact anchor: `decided` renamed to `decided~2` and a new `decided` added', () => {
    const top = [sec('_intro', null, []), sec('decided', 'n1', ['Decided']), sec('decided~2', 'o1', ['Decided'])]
    const events: AnchorEvent[] = [
      { kind: 'added', anchor: 'decided', prevAnchor: null },
      { kind: 'renamed', anchor: 'decided~2', prevAnchor: 'decided' },
      { kind: 'added', anchor: 'decided', prevAnchor: null },
    ]
    assert.deepEqual(rivalSections(top, [top[1]], 'decided', [], events, []).map((s) => s.anchor), ['decided~2'])
    // and from the index alone, before the change log has the rows
    assert.deepEqual(rivalSections(top, [top[1]], 'decided', [], [], [{ anchor: 'decided', blockId: 'o1' }]).map((s) => s.anchor), ['decided~2'])
  })
  it('renamed back to the same name: no rival', () => {
    const one = [sec('done', 'x1', ['Done']), sec('p/decided', 'y1', ['P', 'Decided'])]
    const events: AnchorEvent[] = [
      { kind: 'renamed', anchor: 'p/done', prevAnchor: 'p/decided' },
      { kind: 'renamed', anchor: 'p/decided', prevAnchor: 'p/done' },
    ]
    assert.deepEqual(rivalSections(one, [one[1]], null, refNameForms('decided'), events, []), [])
  })
})

describe('computeSectionChanges: an anchor that passed to another heading', () => {
  const s = (anchor: string, text: string, order: number, blockId: string | null) => ({ anchor, headingPath: anchor, blockId, text, version: `${anchor}:${text}`, order })
  const kinds = (cs: { kind: string; anchor: string; prevAnchor: string | null }[]) =>
    cs.map((c) => `${c.kind}:${c.prevAnchor ? `${c.prevAnchor}>` : ''}${c.anchor}`).sort()
  it('a second "Decided" above the first: renamed decided>decided~2 and added decided, not "modified"', async () => {
    const { computeSectionChanges } = await import('./sectionChanges')
    const before = [s('_intro', 'intro', 0, null), s('decided', 'keep me', 1, 'o1')]
    const after = [s('_intro', 'intro', 0, null), s('decided', 'new one', 1, 'n1'), s('decided~2', 'keep me', 2, 'o1')]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['added:decided', 'renamed:decided>decided~2'])
  })
  it('the first of two deleted: removed decided and renamed decided~2>decided', async () => {
    const { computeSectionChanges } = await import('./sectionChanges')
    const before = [s('decided', 'one', 0, 'o1'), s('decided~2', 'two', 1, 'o2')]
    const after = [s('decided', 'two', 0, 'o2')]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['removed:decided', 'renamed:decided~2>decided'])
  })
  it('a heading retyped as a new block (the old one is gone) is still "modified"', async () => {
    const { computeSectionChanges } = await import('./sectionChanges')
    assert.deepEqual(kinds(computeSectionChanges([s('decided', 'a', 0, 'o1')], [s('decided', 'b', 0, 'n1')])), ['modified:decided'])
  })
})
