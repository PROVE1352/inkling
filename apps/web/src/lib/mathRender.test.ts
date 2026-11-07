// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// KaTeX rendering of math nodes (docs/adr/0997-*): safety options and refused commands, against the
// real katex package (KaTeX renders to a string without a DOM).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import katex from 'katex'
import { KATEX_SAFE_OPTIONS, renderLatex } from './mathRender'

describe('renderLatex (0997)', () => {
  it('renders display and inline math', () => {
    const d = renderLatex(katex, '\\frac{a}{b} + \\sqrt{x_1}', true)
    assert.equal(d.ok, true)
    assert.match(d.html, /class="katex-display"/)
    const i = renderLatex(katex, 'E = mc^2', false)
    assert.equal(i.ok, true)
    assert.doesNotMatch(i.html, /katex-display/)
  })

  it('uses the safe options', () => {
    assert.equal(KATEX_SAFE_OPTIONS.trust, false)
    assert.equal(KATEX_SAFE_OPTIONS.throwOnError, false)
    assert.equal(KATEX_SAFE_OPTIONS.strict, 'warn')
  })

  it('refuses link, image, HTML and macro commands before KaTeX runs', () => {
    for (const [src, cmd] of [
      ['\\href{javascript:alert(1)}{x}', '\\href'],
      ['\\url{https://example.com}', '\\url'],
      ['\\includegraphics{https://example.com/a.png}', '\\includegraphics'],
      ['\\htmlClass{x}{y}', '\\htmlClass'],
      ['\\htmlStyle{background:url(x)}{y}', '\\htmlStyle'],
      ['\\gdef\\x{1} \\x', '\\gdef'],
      ['\\newcommand{\\r}{\\rule{1em}{1em}}', '\\newcommand'],
    ]) {
      const r = renderLatex(katex, src, true)
      assert.deepEqual(r, { ok: false, reason: 'blocked', command: cmd }, src)
    }
  })

  it('trust:false keeps dangerous commands inert even without the pre-check', () => {
    const html = katex.renderToString('\\href{javascript:alert(1)}{x}\\includegraphics{x.png}\\htmlId{a}{b}', {
      ...KATEX_SAFE_OPTIONS,
      macros: {},
    })
    assert.doesNotMatch(html, /<a |href=|<img|id="a"/)
  })

  it('reports parse errors with the message instead of throwing', () => {
    const r = renderLatex(katex, '\\frac{a}{', true)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'parse')
    assert.match(r.message, /KaTeX parse error/)
    // an unknown command still renders (in errorColor), with the reason as a warning
    const u = renderLatex(katex, '\\notacommand x', false)
    assert.equal(u.ok, true)
    assert.match(u.warning, /Undefined control sequence: \\notacommand/)
    assert.equal(renderLatex(katex, '\\color{#d14343} x', false).warning, undefined)
  })

  it('caps sizes and expansion, and rejects oversized sources', () => {
    const big = renderLatex(katex, '\\rule{5000em}{1em}', false)
    assert.equal(big.ok, true)
    assert.match(big.html, /border-right-width:20em/) // maxSize: 20
    assert.deepEqual(renderLatex(katex, 'x'.repeat(4_001), false), { ok: false, reason: 'tooLong', max: 4_000 })
  })

  it('escapes text, so source markup never becomes HTML', () => {
    const r = renderLatex(katex, '\\text{<img src=x onerror=alert(1)>}', false)
    assert.equal(r.ok, true)
    assert.doesNotMatch(r.html, /<img/)
    assert.match(r.html, /&lt;img/)
  })
})
