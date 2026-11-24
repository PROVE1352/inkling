// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Section marks next to headings (docs/adr/1627-*): initials, labels, which marks show, the revert source.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setLocaleChoice } from '../i18n'
import { initials, markLabel, revertBlocker, toRevertSource, visibleMarks } from './sectionProvenance'

setLocaleChoice('en')

const NOW = Date.parse('2026-11-24T12:00:00Z')
const item = (over = {}) => ({
  anchor: 'notes',
  blockId: 'b1',
  headingPath: 'Notes',
  seq: '42',
  kind: 'modified',
  changedAt: '2026-11-24T11:55:00Z',
  actor: { id: 'u1', name: 'Kim Yuna' },
  via: null,
  agent: false,
  revertable: true,
  revertedBy: null,
  isRevert: false,
  ...over,
})

describe('sectionProvenance: initials', () => {
  it('Korean names: one character, for one- and two-character names and longer ones', () => {
    assert.equal(initials('규'), '규')
    assert.equal(initials('규찬'), '규')
    assert.equal(initials('김규찬'), '김')
    assert.equal(initials('김 규찬'), '김')
  })
  it('English: first letters of two words, or the first two letters of one word, upper case', () => {
    assert.equal(initials('Kim Yuna'), 'KY')
    assert.equal(initials('ada lovelace byron'), 'AL')
    assert.equal(initials('kyuchan'), 'KY')
    assert.equal(initials('  Bo  '), 'BO')
    assert.equal(initials('X'), 'X')
  })
  it('an empty name is "?"', () => {
    assert.equal(initials(''), '?')
    assert.equal(initials('   '), '?')
  })
})

describe('sectionProvenance: markLabel', () => {
  it('a person: initials and "{name} · {when}"', () => {
    const l = markLabel(item(), NOW)
    assert.equal(l.kind, 'person')
    assert.equal(l.short, 'KY')
    assert.equal(l.title, 'Kim Yuna · 5 minutes ago')
  })
  it('an agent: the client name and "{name} via {client} · {when}"', () => {
    const l = markLabel(item({ via: 'Claude', agent: true }), NOW)
    assert.equal(l.kind, 'agent')
    assert.equal(l.short, 'Claude')
    assert.equal(l.title, 'Kim Yuna via Claude · 5 minutes ago')
  })
  it('an automation or public form via is a person mark that still names the via', () => {
    const l = markLabel(item({ via: 'automation: Triage', agent: false }), NOW)
    assert.equal(l.kind, 'person')
    assert.equal(l.short, 'KY')
    assert.match(l.title, /via automation: Triage/)
  })
})

describe('sectionProvenance: visibleMarks (decision 2: every section with a known actor)', () => {
  it('people and agents both show; no actor or no heading block does not; one mark per block', () => {
    const list = [
      item({ anchor: 'a', blockId: 'b1' }),
      item({ anchor: 'b', blockId: 'b2', via: 'Claude', agent: true }),
      item({ anchor: 'c', blockId: 'b3', actor: null }),
      item({ anchor: 'd', blockId: null }),
      item({ anchor: 'e', blockId: 'b1' }),
    ]
    assert.deepEqual(
      visibleMarks(list).map((m) => m.anchor),
      ['a', 'b'],
    )
    assert.deepEqual(visibleMarks([]), [])
  })
})

describe('sectionProvenance: revertBlocker', () => {
  it('revertable → button; reverted → "Reverted by"; moved → the moved reason; else too large', () => {
    assert.equal(revertBlocker(item()), null)
    assert.equal(revertBlocker(item({ revertedBy: { name: 'Bo', at: '2026-11-24T11:58:00Z' } })), 'reverted')
    assert.equal(revertBlocker(item({ kind: 'moved', revertable: false })), 'moved')
    assert.equal(revertBlocker(item({ revertable: false })), 'tooLarge')
  })
})

describe('sectionProvenance: toRevertSource', () => {
  it('carries the change for the revert dialog', () => {
    assert.deepEqual(toRevertSource(item({ via: 'Claude', agent: true, isRevert: true }), 'p1', 'Page'), {
      seq: '42',
      pageId: 'p1',
      pageTitle: 'Page',
      headingPath: 'Notes',
      via: 'Claude',
      actor: { id: 'u1', name: 'Kim Yuna' },
      changedAt: '2026-11-24T11:55:00Z',
      isRevert: true,
    })
    assert.equal(toRevertSource(item(), 'p1').pageTitle, null)
  })
})
