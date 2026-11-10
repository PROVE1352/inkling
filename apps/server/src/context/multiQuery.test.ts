// find_context with several queries (docs/adr/1720-* .. 1722-*): RRF, one budget, each section once,
// `matched` labels, determinism, and the join point for extra ranked lists (semantic candidates)
// shown with fake lists. No database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Fragment } from './rank'
import type { FindContextResult } from './retrieve'
import { fuseContextResults, rrf, RRF_K } from './multiQuery'
import type { ExtraList } from './multiQuery'
import { renderFindContext } from '../mcpTools/contextTools'

const frag = (pageId: string, anchors: string[], tokens = 100, title = `Page ${pageId}`): Fragment => ({
  pageId,
  workspaceId: 'w',
  title,
  anchor: anchors[0],
  headingPath: anchors[0],
  sections: anchors.map((a) => ({ anchor: a, headingPath: a, version: `v-${a}`, short: a, heading: a })),
  ords: anchors.map((_, i) => i),
  text: `${pageId}-${anchors.join('+')} ` + 'abcd'.repeat(tokens - 4),
  tokens,
  score: 1,
  truncated: false,
})
const more = (pageId: string, anchor: string, tokens = 50): FindContextResult['more'][number] => ({
  pageId,
  title: `Page ${pageId}`,
  anchor,
  headingPath: anchor,
  short: anchor,
  heading: anchor,
  tokens,
})
const res = (fragments: Fragment[], m: FindContextResult['more'] = [], budget = 3500): FindContextResult => ({
  fragments,
  more: m,
  titleOnly: [],
  budget,
  usedTokens: fragments.reduce((n, f) => n + f.tokens, 0),
  candidates: 10,
})
const shownKeys = (r: { fragments: Fragment[] }) => r.fragments.flatMap((f) => f.sections.map((s) => `${f.pageId}#${s.anchor}`))

describe('rrf', () => {
  it('sums 1/(k+rank) over lists; a key found by two lists beats the top of one', () => {
    const out = rrf([
      { label: '1', entries: [['a'], ['b'], ['c']] },
      { label: '2', entries: [['d'], ['c']] },
    ])
    assert.deepEqual(out.map((f) => f.key), ['c', 'a', 'd', 'b'])
    assert.equal(out[0].score, 1 / (RRF_K + 3) + 1 / (RRF_K + 2))
    assert.deepEqual(out[0].labels, ['1', '2'])
  })

  it('ties go to the first list, then the better rank, then the key', () => {
    const out = rrf([
      { label: '1', entries: [['x'], ['y']] },
      { label: '2', entries: [['p'], ['q']] },
    ])
    assert.deepEqual(out.map((f) => f.key), ['x', 'p', 'y', 'q'])
  })

  it('a key repeated inside one list counts once (its best rank)', () => {
    const out = rrf([{ label: '1', entries: [['a', 'a'], ['a']] }])
    assert.equal(out[0].score, 1 / (RRF_K + 1))
  })
})

describe('fuseContextResults', () => {
  it('shows a section found by several queries once, with every query in matched', () => {
    const r = fuseContextResults(
      [res([frag('A', ['s1']), frag('B', ['s1'])]), res([frag('C', ['s1']), frag('A', ['s1'])]), res([frag('A', ['s1'])])],
      { queries: ['one', 'two', 'three'], budget: 3500 },
    )
    // A: all three; then C (rank 1 of query 2) before B (rank 2 of query 1)
    assert.deepEqual(shownKeys(r), ['A#s1', 'C#s1', 'B#s1'])
    assert.deepEqual(r.fragments.map((f) => f.matched), [['1', '2', '3'], ['2'], ['1']])
    // the first query's text is the one printed for a shared section
    assert.equal(r.fragments[0].text, res([frag('A', ['s1'])]).fragments[0].text)
  })

  it('spends one budget in fused order; what does not fit becomes a pointer', () => {
    // two queries, each fills its own 600-token budget; together only one budget
    const q1 = res([frag('A', ['a'], 250), frag('B', ['b'], 250)], [], 600)
    const q2 = res([frag('C', ['c'], 250), frag('D', ['d'], 250)], [more('E', 'e')], 600)
    const r = fuseContextResults([q1, q2], { queries: ['x', 'y'], budget: 600 })
    assert.ok(r.usedTokens <= 600, `${r.usedTokens}`)
    assert.equal(r.budget, 600)
    // RRF interleaves: A (1st of q1), C (1st of q2), then the rest
    assert.deepEqual(shownKeys(r).slice(0, 2), ['A#a', 'C#c'])
    const pointed = r.more.map((m) => `${m.pageId}#${m.anchor}`)
    for (const k of ['A#a', 'B#b', 'C#c', 'D#d', 'E#e']) assert.ok(shownKeys(r).includes(k) !== pointed.includes(k), `${k} shown xor pointed`)
  })

  it('a fragment overlapping one already shown is not printed again; its other section is a pointer', () => {
    const r = fuseContextResults([res([frag('A', ['s1'])]), res([frag('A', ['s1', 's2'])])], { queries: ['x', 'y'], budget: 3500 })
    assert.deepEqual(shownKeys(r), ['A#s1'])
    assert.deepEqual(r.fragments[0].matched, ['1', '2'])
    assert.deepEqual(r.more.map((m) => m.anchor), ['s2'])
  })

  it('the same input gives the same output (prompt-cache determinism)', () => {
    const input = () => [res([frag('A', ['a'], 300), frag('B', ['b'], 200)], [more('F', 'f')]), res([frag('B', ['b'], 200), frag('C', ['c'])]), res([frag('D', ['d'])])]
    const a = fuseContextResults(input(), { queries: ['1', '2', '3'], budget: 700 })
    const b = fuseContextResults(input(), { queries: ['1', '2', '3'], budget: 700 })
    assert.deepEqual(a, b)
    assert.equal(renderFindContext('1', a), renderFindContext('1', b))
  })

  it('truncates the last piece that fits only in part, and marks it', () => {
    const r = fuseContextResults([res([frag('A', ['a'], 200), frag('B', ['b'], 400)], [], 500)], { queries: ['x'], budget: 500 })
    assert.equal(r.fragments.length, 2)
    assert.equal(r.fragments[1].truncated, true)
    assert.ok(r.usedTokens <= 500)
  })
})

describe('extra ranked lists (semantic join point, docs/adr/1722-*)', () => {
  // What semanticCandidates() of context/semantic.ts returns: { pageId, anchor, score }[] best first.
  const semantic = (label: string, items: { pageId: string; anchor: string | null; score: number }[]): ExtraList => ({ label, items })

  it('an extra list re-ranks lexical sections and adds its label to matched', () => {
    const lexical = [res([frag('A', ['a']), frag('B', ['b'])]), res([frag('C', ['c'])])]
    const plain = fuseContextResults(lexical, { queries: ['x', 'y'], budget: 3500 })
    assert.deepEqual(shownKeys(plain), ['A#a', 'C#c', 'B#b'])
    const withSem = fuseContextResults(lexical, {
      queries: ['x', 'y'],
      budget: 3500,
      extra: [semantic('s', [{ pageId: 'B', anchor: 'b', score: 0.91 }, { pageId: 'C', anchor: 'c', score: 0.8 }])],
    })
    assert.deepEqual(shownKeys(withSem), ['B#b', 'C#c', 'A#a'])
    assert.deepEqual(withSem.fragments[0].matched, ['1', 's'])
  })

  it('a list labelled with a query number merges into that query in matched', () => {
    const r = fuseContextResults([res([frag('A', ['a'])]), res([frag('C', ['c'])])], {
      queries: ['x', 'y'],
      budget: 3500,
      extra: [semantic('2', [{ pageId: 'A', anchor: 'a', score: 0.7 }])],
    })
    assert.deepEqual(r.fragments[0].matched, ['1', '2'])
  })

  it('items no query found become pointers (no text); a page-level item credits the page\'s best section', () => {
    const r = fuseContextResults([res([frag('A', ['a']), frag('A2', ['x'])])], {
      queries: ['x'],
      budget: 3500,
      extra: [
        semantic('s', [
          { pageId: 'Z', anchor: 'z', score: 0.95 },
          { pageId: 'A2', anchor: null, score: 0.9 },
          { pageId: 'Y', anchor: null, score: 0.5 },
        ]),
      ],
    })
    assert.deepEqual(shownKeys(r), ['A2#x', 'A#a'])
    assert.deepEqual(r.fragments[0].matched, ['1', 's'])
    assert.deepEqual(r.more.map((m) => [m.pageId, m.anchor]), [['Z', 'z'], ['Y', '']])
    const text = renderFindContext('x', r)
    assert.match(text, /- Untitled \(page Z\): §z\n- Untitled \(page Y\): whole page/)
  })

  it('an item with a resolved fragment is printed like a lexical result', () => {
    const r = fuseContextResults([res([frag('A', ['a'])])], {
      queries: ['x'],
      budget: 3500,
      extra: [{ label: 's', items: [{ pageId: 'S', anchor: 'syn', score: 0.9, fragment: frag('S', ['syn']) }] }],
    })
    assert.deepEqual(shownKeys(r), ['A#a', 'S#syn'])
    assert.deepEqual(r.fragments[1].matched, ['s'])
  })
})

describe('renderFindContext with several queries', () => {
  it('one header naming the queries, matched per fragment, one footer', () => {
    const r = fuseContextResults([res([frag('A', ['a'])], [more('M', 'm')]), res([frag('A', ['a']), frag('B', ['b'])])], {
      queries: ['roll back', '배포 되돌리기'],
      budget: 3500,
    })
    const text = renderFindContext('roll back', r)
    assert.match(text, /^2 result\(s\) for 2 queries \(1 "roll back", 2 "배포 되돌리기"\), ~\d+\/3500 tokens\n/)
    assert.match(text, /\(page A; §a v=v-a; matched: 1,2\)/)
    assert.match(text, /\(page B; §b v=v-b; matched: 2\)/)
    assert.equal(text.match(/<untrusted_content/g)?.length, 1)
    assert.equal(text.match(/^Next: /gm)?.length, 1)
    assert.match(text, /- Page M \(page M\): §m ~50 tok/)
  })

  it('no match names every query', () => {
    const r = fuseContextResults([res([]), res([])], { queries: ['a', 'b'], budget: 3500 })
    assert.match(renderFindContext('a', r), /^No sections match any of 2 queries \(1 "a", 2 "b"\)\./)
  })

  it('a single-query result renders as before (no matched, quoted query)', () => {
    const single = res([frag('A', ['a'])])
    const text = renderFindContext('roll back', single)
    assert.match(text, /^1 result\(s\) for "roll back", ~100\/3500 tokens\n/)
    assert.doesNotMatch(text, /matched:/)
  })
})
