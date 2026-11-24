// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Rendered KaTeX in pasted HTML (lib/paste/katexHtml.ts): the TeX annotation becomes a math block or
// inlineMath; HTML without it is left alone. BlockNote's parser is stood in for by hand-made blocks.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareKatexHtml } from './katexHtml'

// the jsdom @blocknote/server-util ships (as in columns.test.ts)
const serverRequire = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../server/package.json'))
const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')
const parse = (html) => new JSDOM(html).window.document

const katex = (tex, block = false) =>
  `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"${block ? ' display="block"' : ''}><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">rendered</span></span></span>`
const P = (text) => ({ id: 'p', type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] })
const keys = (html) => html.match(/Iq[a-z]{12}[BI]\d+Q/g) ?? []

describe('paste: KaTeX in HTML', () => {
  it('a .katex-display paragraph becomes a math block, an inline .katex inlineMath', () => {
    const html = `<p><span class="katex-display">${katex('E = mc^2', true)}</span></p><p>줄 안 ${katex('a^2 + b^2')} 입니다.</p>`
    const prep = prepareKatexHtml(html, parse)
    assert.ok(prep)
    assert.ok(!prep.html.includes('katex'))
    assert.ok(!prep.html.includes('rendered'))
    const [b, i] = keys(prep.html)
    assert.match(b, /B\d+Q$/)
    assert.match(i, /I\d+Q$/)
    const out = prep.restore([P(b), P(`줄 안 ${i} 입니다.`)])
    assert.deepEqual(out[0], { id: 'p', type: 'math', props: { latex: 'E = mc^2' }, children: [] })
    assert.deepEqual(out[1].content, [
      { type: 'text', text: '줄 안 ', styles: {} },
      { type: 'inlineMath', props: { latex: 'a^2 + b^2' } },
      { type: 'text', text: ' 입니다.', styles: {} },
    ])
  })

  it('a display formula inside running text becomes inlineMath', () => {
    const prep = prepareKatexHtml(`<p>앞 <span class="katex-display">${katex('x', true)}</span> 뒤</p>`, parse)
    const [k] = keys(prep.html)
    const out = prep.restore([P(`앞 ${k} 뒤`)])
    assert.deepEqual(out[0].content[1], { type: 'inlineMath', props: { latex: 'x' } })
  })

  it('MathML display="block" without the wrapper counts as display', () => {
    const prep = prepareKatexHtml(`<div>${katex('\\int_0^1 f', true)}</div>`, parse)
    assert.match(keys(prep.html)[0], /B\d+Q$/)
  })

  it('HTML without KaTeX, or KaTeX without a TeX annotation, is left alone', () => {
    assert.equal(prepareKatexHtml('<p>평범한 글 $x$</p>', parse), null)
    assert.equal(prepareKatexHtml('<p><span class="katex"><span class="katex-html">x</span></span> application/x-tex</p>', parse), null)
  })

  it('the rest of the HTML is kept as it was', () => {
    const prep = prepareKatexHtml(`<h2>제목</h2><ul><li><b>굵게</b> ${katex('y')}</li></ul><table><tr><td>셀</td></tr></table>`, parse)
    const [k] = keys(prep.html)
    assert.equal(prep.html, `<h2>제목</h2><ul><li><b>굵게</b> ${k}</li></ul><table><tbody><tr><td>셀</td></tr></tbody></table>`)
  })
})
