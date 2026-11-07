// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Math render scheduling (docs/adr/0998-*): the LRU bounds and the deferral threshold.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LAZY_THRESHOLD, RenderCache, placeholderStyle, shouldDefer } from './mathScheduler'

describe('math render cache (0998)', () => {
  it('evicts the least recently used entry beyond the entry cap', () => {
    const c = new RenderCache(3, 1e9)
    for (const k of ['a', 'b', 'c']) c.set(k, { size: 1 })
    c.get('a') // a is now the most recent
    c.set('d', { size: 1 })
    assert.equal(c.get('b'), undefined)
    assert.ok(c.get('a') && c.get('c') && c.get('d'))
    assert.equal(c.size, 3)
  })
  it('evicts by total size too, but keeps at least the newest entry', () => {
    const c = new RenderCache(100, 10)
    c.set('a', { size: 6 })
    c.set('b', { size: 6 })
    assert.equal(c.get('a'), undefined)
    assert.ok(c.get('b'))
    c.set('huge', { size: 50 })
    assert.equal(c.size, 1)
    assert.ok(c.get('huge'))
  })
})

describe('deferral threshold (0998)', () => {
  it('defers only from the threshold in the default mode', () => {
    assert.equal(shouldDefer(LAZY_THRESHOLD - 1, 'auto'), false)
    assert.equal(shouldDefer(LAZY_THRESHOLD, 'auto'), true)
    assert.equal(shouldDefer(1, 'e'), true)
    for (const m of ['a', 'b']) assert.equal(shouldDefer(1e6, m), false)
  })
  it('placeholders reserve more height for multi-line and fraction sources', () => {
    const one = parseFloat(placeholderStyle('k1', 'x+y', true).minHeight)
    const frac = parseFloat(placeholderStyle('k2', '\\frac{a}{b}', true).minHeight)
    const rows = parseFloat(placeholderStyle('k3', 'a \\\\ b \\\\ c', true).minHeight)
    assert.ok(frac > one && rows > frac)
    assert.match(placeholderStyle('k4', 'x^2', false).minWidth, /em$/)
  })
})
