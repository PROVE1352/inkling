// Renamed sections whose body did not change are not sent again (docs/adr/2597-*): the pairing
// prefers an identical body over a heading block that a whole-page replace re-used, and a caller's
// old (anchor, version) is matched to the renamed section by recomputing the version under a
// candidate old heading path.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeSectionChanges } from './sectionChanges'
import type { SectionLike } from './sectionChanges'
import { sectionVersion, splitSections } from './chunker'
import { bodyChangeCount, matchRenamedKnown, oldPathCandidates } from './renamedKnown'

const sec = (anchor: string, text: string, order: number, blockId: string | null = null): SectionLike => ({
  anchor,
  headingPath: anchor,
  blockId,
  text,
  version: `${anchor}:${text}`,
  order,
})
const kinds = (cs: { kind: string; anchor: string; prevAnchor: string | null }[]) =>
  cs.map((c) => `${c.kind}:${c.prevAnchor ? `${c.prevAnchor}>` : ''}${c.anchor}`).sort()

describe('pairing: an identical body beats a re-used heading block', () => {
  it('a replace that drops a section and renumbers the rest (the next heading kept the dropped one\'s block)', () => {
    const before = [sec('2-bravo', 'B', 0, 'h2'), sec('3-charlie', 'C', 1, 'h3'), sec('4-delta', 'D', 2, 'h4'), sec('5-echo', 'E', 3, 'h5')]
    // the minimal edit edited heading h3 in place into "3. Delta" and deleted h4 with Charlie's body
    const after = [sec('2-bravo', 'B', 0, 'h2'), sec('3-delta', 'D', 1, 'h3'), sec('4-echo', 'E', 2, 'h5')]
    const cs = computeSectionChanges(before, after)
    assert.deepEqual(kinds(cs), ['removed:3-charlie', 'renamed:4-delta>3-delta', 'renamed:5-echo>4-echo'])
    for (const c of cs.filter((x) => x.kind === 'renamed')) assert.equal(c.before, c.after)
  })

  it('without an identical body elsewhere the heading block still pairs (body changed)', () => {
    const cs = computeSectionChanges([sec('old', 'body', 0, 'blk1'), sec('x', 'other', 1, 'blk2')], [sec('new', 'body v2', 0, 'blk1'), sec('x', 'other', 1, 'blk2')])
    assert.deepEqual(kinds(cs), ['renamed:old>new'])
  })

  it('empty bodies are no evidence: the heading block decides', () => {
    const before = [sec('a', '', 0, 'h1'), sec('b', '', 1, 'h2')]
    const after = [sec('b2', '', 0, 'h2')]
    assert.deepEqual(kinds(computeSectionChanges(before, after)), ['removed:a', 'renamed:b>b2'])
  })
})

describe('old heading path candidates', () => {
  it('renumbered headings: the old numbers put back into the current text', () => {
    assert.deepEqual(oldPathCandidates(['2. Alpha'], '1-alpha'), [['1. Alpha']])
    assert.deepEqual(oldPathCandidates(['Plan', '10. India'], 'plan/9-india'), [['Plan', '9. India']])
    assert.deepEqual(oldPathCandidates(['2. Alpha'], '2-alpha~2'), [['2. Alpha']])
  })
  it('lower-case and Korean words are put back as well; a different word count gives nothing', () => {
    assert.deepEqual(oldPathCandidates(['회의 2'], '회의-1'), [['회의 1']])
    assert.deepEqual(oldPathCandidates(['Alpha (done)'], 'alpha'), [])
    assert.deepEqual(oldPathCandidates(['A', 'B'], 'a'), [])
  })
})

describe('matchRenamedKnown', () => {
  const page = (titles: [string, string][]) =>
    splitSections(
      titles.flatMap(([h, body]) => [
        { id: `h-${h}`, type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: h, styles: {} }], children: [] },
        { id: `p-${h}`, type: 'paragraph', props: {}, content: [{ type: 'text', text: body, styles: {} }], children: [] },
      ]) as never,
    )
  const old = page([['1. Alpha', 'alpha body'], ['2. Bravo', 'bravo body'], ['3. Charlie', 'charlie body']])
  const known = Object.fromEntries(old.map((s) => [s.anchor, s.version]))

  it('renumbering: every old anchor maps to its new anchor and version, no body needed', () => {
    const now = page([['2. Alpha', 'alpha body'], ['3. Bravo', 'bravo body'], ['4. Charlie', 'charlie body']])
    const m = matchRenamedKnown(Object.entries(known), now, { targets: new Map(), oldPaths: new Map() })
    assert.deepEqual(
      m.map((r) => `${r.from}>${r.to}@${r.version}`),
      now.map((s, i) => `${old[i].anchor}>${s.anchor}@${s.version}`),
    )
  })

  it('a body that changed is never matched (the caller must get it)', () => {
    const now = page([['2. Alpha', 'alpha body EDITED'], ['3. Bravo', 'bravo body'], ['4. Charlie', 'charlie body']])
    const m = matchRenamedKnown(Object.entries(known), now, { targets: new Map(), oldPaths: new Map() })
    assert.deepEqual(m.map((r) => r.from), ['2-bravo', '3-charlie'])
  })

  it('a stale known version is never matched', () => {
    const now = page([['2. Alpha', 'alpha body'], ['3. Bravo', 'bravo body'], ['4. Charlie', 'charlie body']])
    const m = matchRenamedKnown([['1-alpha', '000000000000']], now, { targets: new Map(), oldPaths: new Map() })
    assert.deepEqual(m, [])
  })

  it('a word rename is matched through the change log: its target and an old heading path it recorded', () => {
    const before = page([['Draft', 'the plan']])
    const now = page([['Final', 'the plan']])
    const none = matchRenamedKnown([['draft', before[0].version]], now, { targets: new Map(), oldPaths: new Map() })
    assert.deepEqual(none, [])
    const m = matchRenamedKnown([['draft', before[0].version]], now, { targets: new Map([['draft', 'final']]), oldPaths: new Map([['draft', [['Draft']]]]) })
    assert.deepEqual(m, [{ from: 'draft', to: 'final', version: now[0].version }])
    assert.equal(sectionVersion(['Draft'], 'the plan'), before[0].version)
  })

  it('one current section is claimed once, in a fixed order', () => {
    const now = page([['2. Alpha', 'alpha body']])
    const m1 = matchRenamedKnown([['1-alpha', known['1-alpha']], ['3-alpha', known['1-alpha']]], now, { targets: new Map(), oldPaths: new Map() })
    const m2 = matchRenamedKnown([['3-alpha', known['1-alpha']], ['1-alpha', known['1-alpha']]], now, { targets: new Map(), oldPaths: new Map() })
    assert.deepEqual(m1, m2)
    assert.equal(m1.length, 1)
  })
})

describe('bodyChangeCount (update_page replace hint)', () => {
  it('counts new sections whose body has no identical counterpart before', () => {
    assert.deepEqual(bodyChangeCount(['a', 'b', 'c'], ['a', 'b', 'c']), { changed: 0, total: 3 })
    assert.deepEqual(bodyChangeCount(['a', 'b', 'c'], ['a', 'B', 'c']), { changed: 1, total: 3 })
    assert.deepEqual(bodyChangeCount(['a', 'a', 'c'], ['a', 'a', 'a']), { changed: 1, total: 3 })
    assert.deepEqual(bodyChangeCount(['a', 'b', 'c', 'd'], ['b', 'd']), { changed: 0, total: 2 })
  })
})
