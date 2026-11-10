// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Presentation mode slide split (docs/adr/1843-*), on the jsdom that @blocknote/server-util ships.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cloneForSlides, slideKey, splitLevel, splitSlides, swipeDirection, topLevelBlocks } from './present'
import { renderMermaidIn } from './mermaidPublic'
import { setLocaleChoice } from '../i18n'

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

  it('one H1 as the title and H2 sections (2323): splits at the H1 and at every H2', () => {
    const h2s = Array.from({ length: 15 }, (_, i) => [h(2, `S${i + 1}`), p(`s${i + 1}`)]).flat()
    const d = doc(h(1, 'Doc'), p('intro'), ...h2s)
    const got = texts(splitSlides(topLevelBlocks(d)))
    assert.equal(got.length, 1 + 1 + 15)
    assert.deepEqual(got.slice(0, 3), ['', 'Doc|intro', 'S1|s1'])
    assert.equal(got[16], 'S15|s15')
    assert.equal(splitLevel(topLevelBlocks(d)), 2)
  })

  it('H1 right above the first H2: the H1 keeps a slide of its own, no empty slide', () => {
    const d = doc(h(1, 'Doc'), h(2, 'A'), p('a'), h(2, 'B'), p('b'), h(2, 'C'), h(2, 'D'), h(2, 'E'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'Doc', 'A|a', 'B|b', 'C', 'D', 'E'])
  })

  it('several H1s with H2s below: splits at the H1s only, as before', () => {
    const d = doc(h(1, 'One'), p('x'), h(2, 'a'), p('y'), h(2, 'b'), h(1, 'Two'), h(2, 'c'), h(1, 'Three'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'One|x|a|y|b', 'Two|c', 'Three'])
  })

  it('no heading, one heading, only H2s', () => {
    assert.deepEqual(texts(splitSlides(topLevelBlocks(doc(p('a'), p('b'))))), ['a|b'])
    assert.deepEqual(texts(splitSlides(topLevelBlocks(doc(p('a'), h(2, 'Only'), p('b'))))), ['a', 'Only|b'])
    assert.deepEqual(texts(splitSlides(topLevelBlocks(doc(h(2, 'A'), p('a'), h(2, 'B'), p('b'), h(2, 'C'))))), ['', 'A|a', 'B|b', 'C'])
  })

  it('one H1 and one H2 with five H3s: splits at the H3s too (the shallowest level used twice)', () => {
    const h3s = Array.from({ length: 5 }, (_, i) => [h(3, `T${i + 1}`), p(`t${i + 1}`)]).flat()
    const d = doc(h(1, 'Doc'), p('intro'), h(2, 'Part'), p('part'), ...h3s)
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'Doc|intro', 'Part|part', 'T1|t1', 'T2|t2', 'T3|t3', 'T4|t4', 'T5|t5'])
  })

  it('one heading per level (H1, then one H2): the highest level only, as before', () => {
    const d = doc(h(1, 'Doc'), p('x'), h(2, 'Sub'), p('y'))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'Doc|x|Sub|y'])
  })

  it('dividers still end slides between the heading splits', () => {
    const d = doc(h(1, 'Doc'), p('intro'), hr(), p('aside'), h(2, 'A'), p('a'), hr(), hr(), p('after'), h(2, 'B'), p(''))
    assert.deepEqual(texts(splitSlides(topLevelBlocks(d))), ['', 'Doc|intro', 'aside', 'A|a', 'after', 'B'])
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

  it('button block copies (0.18): the button is disabled and its settings control is left out', () => {
    const btn = block(
      'button',
      '<div contenteditable="false" data-inkling-button><div><button type="button" data-button-run>Add task</button><button type="button" data-button-settings>⚙</button></div></div>',
    )
    const d = doc(h(2, 'A'), btn)
    const [copy] = cloneForSlides([splitSlides(topLevelBlocks(d))[1][1]])
    const run = copy.querySelector('[data-button-run]')
    assert.ok(run)
    assert.equal(run.hasAttribute('disabled'), true)
    assert.equal(copy.querySelector('[data-button-settings]'), null)
    assert.equal(copy.textContent, 'Add task')
  })

  it('Mermaid slides: server HTML code is drawn on the slide; an editor copy with its diagram is kept', async () => {
    setLocaleChoice('en')
    // public link: BlockNote's code block HTML with the source only
    const serverCode = (src: string) =>
      block('codeBlock', `<pre><code class="bn-inline-content language-mermaid" data-language="mermaid">${src}</code></pre>`, ' data-language="mermaid"')
    // in-app: a copy of the editor's block whose diagram is drawn (MermaidBlock.tsx)
    const editorCopy = (src: string) =>
      block(
        'codeBlock',
        `<div><select><option>Mermaid</option></select></div><pre><code>${src}</code></pre><div class="nd-mermaid-host"><img class="nd-mermaid-img" src="data:image/svg+xml;base64,PHN2Zy8+"></div>`,
        ' data-language="mermaid"',
      ).replace('class="bn-block-content"', 'class="bn-block-content nd-mermaid nd-mermaid-ok"')
    const d = doc(h(1, 'One'), serverCode('flowchart LR\n A--&gt;B'), h(1, 'Two'), editorCopy('flowchart LR\n C--&gt;D'))
    const slides = splitSlides(topLevelBlocks(d))
    assert.deepEqual(texts(slides).map((t) => t.split('|')[0]), ['', 'One', 'Two'])
    const calls: string[] = []
    const render = async (source: string) => {
      calls.push(source)
      return { ok: true, src: 'data:image/svg+xml;base64,PHN2Zy8+', width: 10, height: 10 }
    }
    for (const [i, slide] of [slides[1], slides[2]].entries()) {
      const body = d.createElement('div')
      d.body.appendChild(body) // drawn only while on the page (the presenter's slide is)
      body.replaceChildren(...slide.map((b) => b.cloneNode(true)))
      const stop = renderMermaidIn(body, 'light', render)
      await new Promise((r) => setTimeout(r, 0))
      const shown = [...body.querySelectorAll('img[src^="data:image/svg"]')].filter((img) => img.closest('[style*="display: none"]') === null)
      assert.equal(shown.length, 1, `slide ${i + 1} shows one diagram`)
      stop()
      body.remove()
    }
    assert.deepEqual(calls, ['flowchart LR\n A-->B'])
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
