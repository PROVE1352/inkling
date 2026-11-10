// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Presentation mode slide split (docs/adr/1843-*), on the jsdom that @blocknote/server-util ships.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cloneForSlides, slideKey, splitSlides, swipeDirection, topLevelBlocks } from './present'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRequire = createRequire(path.resolve(here, '../../../server/package.json'))
const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')

const block = (type: string, inner: string, attrs = '') =>
  `<div class="bn-block-outer" data-node-type="blockOuter" data-id="${Math.random()}"><div class="bn-block"><div class="bn-block-content" data-content-type="${type}"${attrs}>${inner}</div></div></div>`
const h = (lvl: number, text: string) => block('heading', `<h${lvl} class="bn-inline-content">${text}</h${lvl}>`, ` data-level="${lvl}"`)
const p = (text: string) => block('paragraph', `<p class="bn-inline-content">${text}</p>`)
const hr = () => block('divider', '<hr>')
const doc = (...blocks: string[]) => new JSDOM(`<div class="bn-block-group" data-node-type="blockGroup">${blocks.join('')}</div>`).window.document
const texts = (slides: Element[][]) => slides.map((s) => s.map((b) => b.textContent).join('|'))

describe('presentation slides (1843)', () => {
  it('splits at the highest heading level present; the intro stays on the opening slide', () => {
    const d = doc(p('intro'), h(2, 'A'), p('a1'), h(3, 'A.1'), p('a2'), h(2, 'B'), p('b'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['intro', 'A|a1|A.1|a2', 'B|b'])
  })

  it('a page that starts with a heading gets an empty opening (title) slide', () => {
    const d = doc(h(1, 'One'), p('x'), h(1, 'Two'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'One|x', 'Two'])
  })

  it('dividers end a slide and are not shown; blank paragraphs at the edges and empty slides go', () => {
    const d = doc(p('intro'), hr(), p(''), p('after rule'), p(''), hr(), hr(), h(2, 'H'), p('h'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['intro', 'after rule', 'H|h'])
  })

  it('no headings and no dividers: one slide', () => {
    assert.deepEqual(texts(splitSlides(topLevelBlocks(doc(p('a'), p('b'))))), ['a|b'])
  })

  it('nested blocks belong to their parent; clones lose ids and editability', () => {
    const nested = `<div class="bn-block-outer" data-id="n"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p contenteditable="true">parent</p></div><div class="bn-block-group">${h(2, 'child heading')}</div></div></div>`
    const d = doc(h(2, 'A'), nested)
    const slides = splitSlides(topLevelBlocks(d))
    assert.equal(slides.length, 2)
    const [copy] = cloneForSlides([slides[1][1]])
    assert.equal(copy.querySelector('[data-id]'), null)
    assert.equal(copy.getAttribute('data-id'), null)
    assert.equal(copy.querySelector('[contenteditable]'), null)
  })

  it('keys and swipes', () => {
    assert.equal(slideKey('ArrowRight', 0, 3), 1)
    assert.equal(slideKey('ArrowRight', 2, 3), 2)
    assert.equal(slideKey('ArrowLeft', 0, 3), 0)
    assert.equal(slideKey('End', 0, 3), 2)
    assert.equal(slideKey('a', 0, 3), null)
    assert.equal(swipeDirection(-80, 10), 1)
    assert.equal(swipeDirection(80, 10), -1)
    assert.equal(swipeDirection(30, 0), 0)
    assert.equal(swipeDirection(-80, 90), 0)
  })
})
