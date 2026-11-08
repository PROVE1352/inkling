// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Heading folds: which blocks a fold hides, when the selection opens it, storage (docs/adr/1221-*).
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { foldCss, foldLayout, foldsToOpen, foldTarget, loadFolds, MAX_FOLD_PAGES, saveFolds } from './headingFolds'

// Fake ProseMirror nodes in BlockNote's layout: doc → blockGroup → blockContainer(content, blockGroup?)
const node = (name, attrs = {}, children = []) => ({
  type: { name },
  attrs,
  childCount: children.length,
  child: (i) => children[i],
  nodeSize: 2,
})
const block = (id, type, level, kids) =>
  node('blockContainer', { id }, [
    node(type, type === 'heading' ? { level } : {}),
    ...(kids ? [node('blockGroup', {}, kids)] : []),
  ])
const h = (id, level, kids) => block(id, 'heading', level, kids)
const p = (id, kids) => block(id, 'paragraph', 0, kids)
const docOf = (...blocks) => node('doc', {}, [node('blockGroup', {}, blocks)])

// a resolved position at a top-level block (depth 3 = its content) or inside its children (depth 4)
const at = (doc, index, inChildren = false) => {
  const group = doc.child(0)
  const top = group.child(index)
  const path = [doc, group, top, inChildren ? top.child(1) : top.child(0)]
  return { depth: 3, node: (d) => path[d], index: (d) => (d === 1 ? index : 0) }
}

const doc = docOf(
  p('intro'),
  h('a', 1),
  p('a1'),
  h('a-sub', 2),
  p('a2'),
  h('b', 1, [p('b-child')]),
  p('b1'),
  h('c', 2),
  p('c1'),
)

describe('foldLayout', () => {
  it('hides blocks up to the next heading of the same or a higher level', () => {
    const l = foldLayout(doc, new Set(['a']))
    assert.deepEqual([...l.hiddenBy.keys()], ['a1', 'a-sub', 'a2'])
    assert.deepEqual(l.active, ['a'])
  })

  it('an H2 fold ends at the next H2 or H1; a fold inside a fold stays remembered', () => {
    assert.deepEqual([...foldLayout(doc, new Set(['a-sub'])).hiddenBy.keys()], ['a2'])
    const both = foldLayout(doc, new Set(['a', 'a-sub']))
    assert.deepEqual([...both.hiddenBy.entries()], [['a1', 'a'], ['a-sub', 'a'], ['a2', 'a']])
    assert.deepEqual(both.active, ['a', 'a-sub'])
  })

  it('a heading with nested children hides them too; the last section runs to the end', () => {
    const l = foldLayout(doc, new Set(['b']))
    assert.deepEqual(l.withChildren, ['b'])
    assert.deepEqual([...l.hiddenBy.keys()], ['b1', 'c', 'c1'])
  })

  it('drops ids that are not top-level headings (deleted, renamed to a paragraph, nested)', () => {
    const l = foldLayout(doc, new Set(['gone', 'a1', 'b-child']))
    assert.equal(l.hiddenBy.size, 0)
    assert.deepEqual(l.active, [])
  })
})

describe('foldsToOpen', () => {
  const layout = foldLayout(doc, new Set(['a', 'b']))
  const group = doc.child(0)
  it('the caret on a visible block or on the folded heading itself opens nothing', () => {
    assert.deepEqual([...foldsToOpen(layout, at(doc, 0), at(doc, 0), group)], [])
    assert.deepEqual([...foldsToOpen(layout, at(doc, 1), at(doc, 1), group)], [])
  })
  it('the caret in a hidden block opens its fold (Enter at the end of a folded heading, Backspace into it)', () => {
    assert.deepEqual([...foldsToOpen(layout, at(doc, 2), at(doc, 2), group)], ['a'])
  })
  it('the caret in a folded heading’s own children opens it', () => {
    assert.deepEqual([...foldsToOpen(layout, at(doc, 5, true), at(doc, 5, true), group)], ['b'])
  })
  it('a range over hidden blocks opens every fold it crosses (select all)', () => {
    assert.deepEqual([...foldsToOpen(layout, at(doc, 0), at(doc, 8), group)].sort(), ['a', 'b'])
  })
})

describe('foldCss', () => {
  it('is empty without folds and screen-only otherwise', () => {
    assert.equal(foldCss(foldLayout(doc, new Set())), '')
    const css = foldCss(foldLayout(doc, new Set(['b'])), (s) => s)
    assert.match(css, /^@media screen/)
    assert.match(css, /\.bn-block-outer\[data-id="b1"\]/)
    assert.match(css, /\.bn-block-outer\[data-id="b"\] > \.bn-block > \.bn-block-group/)
  })
  it('marks a folded heading that hides something with "…" after its text, not one that hides nothing', () => {
    const css = foldCss(foldLayout(doc, new Set(['a', 'a-sub'])), (s) => s)
    assert.match(css, /data-id="a"\] > \.bn-block > \.bn-block-content > \.bn-inline-content::after/)
    // a-sub is inside a's hidden range: no marker of its own
    assert.doesNotMatch(css, /data-id="a-sub"\][^,{]*::after/)
    assert.match(css, /content: "\\2026"/)
    // c folded at the very end of a document whose next heading follows at once hides nothing
    const empty = docOf(h('x', 1), h('y', 1), p('y1'))
    assert.equal(foldCss(foldLayout(empty, new Set(['x'])), (s) => s), '')
  })
})

describe('foldTarget (⌘. / Ctrl+.)', () => {
  const group = doc.child(0)
  it('the caret in a heading: that heading, caret stays', () => {
    assert.deepEqual(foldTarget(at(doc, 1), group), { id: 'a', inHeading: true })
  })
  it('the caret in a section body: the nearest heading above (any level), caret must move', () => {
    assert.deepEqual(foldTarget(at(doc, 2), group), { id: 'a', inHeading: false })
    assert.deepEqual(foldTarget(at(doc, 4), group), { id: 'a-sub', inHeading: false })
    assert.deepEqual(foldTarget(at(doc, 6), group), { id: 'b', inHeading: false })
  })
  it('the caret in a heading’s own nested children: that heading, caret must move', () => {
    assert.deepEqual(foldTarget(at(doc, 5, true), group), { id: 'b', inHeading: false })
  })
  it('before the first heading: nothing', () => {
    assert.equal(foldTarget(at(doc, 0), group), null)
    assert.equal(foldTarget({ depth: 1, node: () => doc, index: () => 0 }, group), null)
  })
})

describe('fold storage', () => {
  beforeEach(() => {
    const m = new Map()
    globalThis.localStorage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
  })
  it('round-trips per page and removes the key when the last page has no folds', () => {
    saveFolds('p1', ['a', 'b'])
    assert.deepEqual(loadFolds('p1'), ['a', 'b'])
    assert.deepEqual(loadFolds('p2'), [])
    saveFolds('p1', [])
    assert.equal(localStorage.getItem('inkling:folds'), null)
  })
  it('keeps at most MAX_FOLD_PAGES pages, dropping the least recently changed', () => {
    for (let i = 0; i <= MAX_FOLD_PAGES; i++) saveFolds(`p${i}`, ['x'], i)
    assert.deepEqual(loadFolds('p0'), [])
    assert.deepEqual(loadFolds(`p${MAX_FOLD_PAGES}`), ['x'])
  })
})
