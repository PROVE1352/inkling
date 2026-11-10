// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Mermaid diagrams (docs/adr/2104-*, 2105-*): the SVG cleaning pass, the locked-down configuration,
// error text; and the heading matcher of section links (docs/adr/2102-*). Uses the jsdom that
// @blocknote/server-util already ships as the DOMParser stand-in. Mermaid itself needs a browser
// layout (getBBox) and is not run here.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanCss, cleanMermaidSvg, svgDataUrl } from './mermaidSvg'
import { MERMAID_SECURE_KEYS, mermaidConfig, shortError } from './mermaid'
import { findHeadingBlock, headingSlug } from './sectionLinkMatch'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRequire = createRequire(path.resolve(here, '../../../server/package.json'))
const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')
const { window } = new JSDOM('')
const parse = (s: string) => new window.DOMParser().parseFromString(s, 'image/svg+xml')
const serialize = (el) => new window.XMLSerializer().serializeToString(el)
const clean = (s: string) => cleanMermaidSvg(s, parse, serialize)

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'

describe('mermaid: SVG cleaning (2105)', () => {
  it('keeps a normal diagram and sizes it from the viewBox', () => {
    const r = clean(
      `<svg ${NS} id="m1" width="100%" style="max-width: 320px;" viewBox="0 0 319.5 120"><style>#m1 .node rect{fill:#eee}</style>` +
        `<g class="node"><rect width="10" height="10"/><text>Start</text></g><path marker-end="url(#m1_arrow)" d="M0 0L1 1"/></svg>`,
    )
    assert.ok(r)
    assert.equal(r.width, 320)
    assert.equal(r.height, 120)
    assert.match(r.svg, /width="320"/)
    assert.doesNotMatch(r.svg, /max-width/)
    assert.match(r.svg, /<text>Start<\/text>/)
    assert.match(r.svg, /url\(#m1_arrow\)/)
    assert.match(r.svg, /#m1 \.node rect\{fill:#eee\}/)
  })
  it('drops scripts, handlers, outside links, @import and outside url()', () => {
    const r = clean(
      `<svg ${NS} viewBox="0 0 10 10" onload="alert(1)">` +
        `<script>alert(2)</script>` +
        `<style>@import url(https://evil.example/x.css); .a{background:url(https://evil.example/p.png)} .b{fill:url(#ok)}</style>` +
        `<a xlink:href="javascript:alert(3)" href="https://evil.example"><text onclick="alert(4)">x</text></a>` +
        `<image href="https://evil.example/track.png"/><image href="data:image/png;base64,AAAA"/>` +
        `<foreignObject><iframe src="https://evil.example"></iframe><div>label</div></foreignObject>` +
        `<rect style="fill:url(https://evil.example/f)"/><animate attributeName="href" to="javascript:alert(5)"/>` +
        `</svg>`,
    )
    assert.ok(r)
    for (const bad of ['alert(1)', 'alert(2)', '<script', 'evil.example', 'javascript:', 'onclick', 'onload', '@import', '<iframe', '<animate']) {
      assert.ok(!r.svg.includes(bad), `${bad} left in ${r.svg}`)
    }
    assert.match(r.svg, /data:image\/png;base64,AAAA/) // raster data image stays
    assert.match(r.svg, /url\(#ok\)/)
    assert.match(r.svg, /<div[^>]*>label<\/div>/) // foreignObject text stays (an <img> runs nothing)
  })
  it('refuses what is not an SVG or has no size', () => {
    assert.equal(clean('<html><body>x</body></html>'), null)
    assert.equal(clean(`<svg ${NS}></svg>`), null)
    assert.equal(clean('<svg'), null)
  })
  it('css: data: SVG and other schemes are not images', () => {
    assert.equal(cleanCss('a{b:url("data:image/svg+xml,<svg/>")}'), 'a{b:none}')
    assert.equal(cleanCss("a{b:url('#x')}"), "a{b:url('#x')}")
  })
  it('data URL encodes the markup', () => {
    assert.match(svgDataUrl('<svg a="#"/>'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E$/)
  })
})

describe('mermaid: configuration (2105)', () => {
  it('strict, no HTML labels, errors not drawn, and the init directive cannot loosen it', () => {
    for (const theme of ['light', 'dark'] as const) {
      const c = mermaidConfig(theme)
      assert.equal(c.securityLevel, 'strict')
      assert.equal(c.htmlLabels, false)
      assert.equal(c.startOnLoad, false)
      assert.equal(c.suppressErrorRendering, true)
      for (const k of ['securityLevel', 'htmlLabels', 'dompurifyConfig', 'themeCSS', 'maxTextSize', 'maxEdges', 'secure']) {
        assert.ok(c.secure.includes(k), k)
      }
    }
    assert.equal(mermaidConfig('dark').theme, 'dark')
    assert.equal(mermaidConfig('light').theme, 'default')
    assert.ok(MERMAID_SECURE_KEYS.length >= 9)
  })
  it('error text is one short line', () => {
    const msg = shortError(new Error('Parse error on line 2:\n...A --> \n-------^\nExpecting \'SQE\', got \'EOF\''))
    assert.equal(msg, 'Parse error on line 2: — ...A -->')
    assert.ok(shortError(new Error('x'.repeat(500))).length <= 240)
  })
})

describe('section links: heading in a loaded document (2102)', () => {
  const h = (id: string, text: string, children = []) => ({ id, type: 'heading', content: [{ type: 'text', text }], children })
  const doc = [
    { id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'Setup' }] },
    h('a', 'Intro'),
    { id: 't', type: 'toggleListItem', content: [], children: [h('n', 'Nested part')] },
    h('b', 'Set up & run'),
  ]
  it('block id first, then text, then slug; headings in toggles count', () => {
    assert.equal(findHeadingBlock(doc, { heading: 'Renamed', blockId: 'a' }), 'a')
    assert.equal(findHeadingBlock(doc, { heading: 'intro' }), 'a')
    assert.equal(findHeadingBlock(doc, { heading: 'nested part' }), 'n')
    assert.equal(findHeadingBlock(doc, { heading: 'set-up-run' }), 'b')
    assert.equal(findHeadingBlock(doc, { heading: 'Setup' }), null) // a paragraph is not a heading
    assert.equal(findHeadingBlock(doc, { heading: 'Gone', blockId: 'p' }), null)
  })
  it('slug matches the server anchor slug', () => {
    assert.equal(headingSlug('결정 사항!'), '결정-사항')
    assert.equal(headingSlug('***'), 'section')
  })
})
