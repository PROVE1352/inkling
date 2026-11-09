// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Ink layer sync rules (docs/adr/0815-*, 0854-*, 1340-*): load merge, 412 merge, when a save may go out,
// and the page-view key that keeps one ink layer per page.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { canSaveInk, mergeConflict, mergeLoaded } from './inkSync'

const s = (id) => ({ id, color: '#000000', size: 2, points: [1, 2, 0.5] })
const ids = (list) => list.map((x) => x.id)

describe('mergeLoaded (strokes drawn before the server copy arrived)', () => {
  it('keeps the server strokes and adds the local ones on top', () => {
    assert.deepEqual(ids(mergeLoaded([s('a'), s('b')], [s('x')])), ['a', 'b', 'x'])
  })
  it('nothing drawn yet → the server list as is', () => {
    assert.deepEqual(ids(mergeLoaded([s('a')], [])), ['a'])
  })
  it('does not duplicate a stroke both sides have', () => {
    assert.deepEqual(ids(mergeLoaded([s('a'), s('x')], [s('x')])), ['a', 'x'])
  })
})

describe('mergeConflict (412 INK_CONFLICT)', () => {
  it('keeps strokes another device added and strokes added here; drops strokes erased here', () => {
    const base = new Set(['a', 'b'])
    const server = [s('a'), s('b'), s('remote')]
    const local = [s('a'), s('mine')] // b erased here
    assert.deepEqual(ids(mergeConflict(server, local, base)), ['a', 'remote', 'mine'])
  })
  it('a stale local copy never removes strokes the server gained after the base', () => {
    const base = new Set(['a'])
    assert.deepEqual(ids(mergeConflict([s('a'), s('n1'), s('n2')], [s('a')], base)), ['a', 'n1', 'n2'])
  })
})

describe('canSaveInk', () => {
  it('no save before the server version is known', () => {
    assert.equal(canSaveInk(undefined), false)
  })
  it('saves once a base exists, including the "no ink yet" base', () => {
    assert.equal(canSaveInk({ updatedAt: null, ids: new Set() }), true)
    assert.equal(canSaveInk({ updatedAt: '2026-11-09T04:01:14.000Z', ids: new Set(['a']) }), true)
  })
})

describe('PageView ink layer key', () => {
  // InkLayer and HeadingFolds used to share key={page.id} as siblings. With pen mode on, a page change
  // made React lose the old InkLayer: its SVG and toolbar stayed on screen over the next page,
  // Done no longer closed them, and they kept window listeners and a frozen stroke list.
  const src = readFileSync(new URL('../pages/PageView.tsx', import.meta.url), 'utf8')
  // `key={…}` expressions with balanced braces (template literals contain `${…}`)
  const keyAt = (i) => {
    let depth = 1
    let j = i
    while (depth > 0 && j < src.length) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    return src.slice(i, j - 1).trim()
  }
  const keys = [...src.matchAll(/\bkey=\{/g)].map((m) => keyAt(m.index + m[0].length))
  const inkAt = src.search(/<InkLayer\s+key=\{/)
  it('InkLayer has a key no other element in PageView uses', () => {
    assert.ok(inkAt >= 0, 'InkLayer must be keyed')
    const mine = keyAt(src.indexOf('key={', inkAt) + 'key={'.length)
    assert.equal(keys.filter((k) => k === mine).length, 1, `key {${mine}} is shared with a sibling`)
  })
})
