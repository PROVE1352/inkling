// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/sanitizeHtml.test.ts
// Public share HTML sanitizer (docs/adr/0852-*). Uses the jsdom that @blocknote/server-util already
// ships (no new dependency) as the DOMParser stand-in.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { safeUrl, sanitizeHtml } from './sanitizeHtml'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRequire = createRequire(path.resolve(here, '../../../server/package.json'))
const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')

const O = 'https://notes.example.org'
const parse = (html: string) => new JSDOM(html).window.document
const clean = (html: string) => sanitizeHtml(html, { origin: O, parse })

describe('sanitizeHtml (0852)', () => {
  it('keeps a column width (flex-grow, a plain number) and drops anything else in it (2420)', () => {
    const out = clean('<div class="bn-block-column-list" data-node-type="columnList"><div class="bn-block-column" data-node-type="column" data-width="1.2" style="flex-grow: 1.2"><p>a</p></div><div style="flex-grow: url(x)"><p>b</p></div></div>')
    assert.match(out, /data-width="1.2" style="flex-grow: 1.2;?"/)
    assert.doesNotMatch(out, /url\(/)
  })

  it('keeps BlockNote markup intact', () => {
    const html =
      '<div class="bn-block-group" data-node-type="blockGroup"><div class="bn-block-outer" data-id="x">' +
      '<div class="bn-block-content" data-content-type="paragraph" data-text-color="blue">' +
      '<p class="bn-inline-content"><strong>b</strong><em><u><s><code>c</code></s></u></em>' +
      '<a href="https://ex.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">l</a></p></div></div></div>'
    assert.equal(clean(html), html)
  })

  it('keeps math nodes as the server renders them (source in data-latex and as text, docs/adr/0997-*)', () => {
    // exact shape of apps/server blocksToFullHTML for a math block and an inline equation
    const html =
      '<div class="bn-block-content" data-content-type="math" data-latex="\\frac{a}{b} <x> &amp;"><div class="nd-math-source">\\frac{a}{b} &lt;x&gt; &amp;</div></div>' +
      '<p class="bn-inline-content">a <span class="nd-math-inline-source" data-inline-content-type="inlineMath" data-latex="x^2">x^2</span> b</p>'
    assert.equal(clean(html), html)
    // the attribute keeps the text only; markup inside it never becomes an element
    const doc = parse(clean('<div data-content-type="math" data-latex="<img src=x onerror=alert(1)>">s</div>'))
    assert.equal(doc.querySelector('img'), null)
    assert.equal(doc.querySelector('[data-latex]').getAttribute('data-latex'), '<img src=x onerror=alert(1)>')
  })

  it('keeps public asset URLs, folder-share links, image width and table layout styles', () => {
    const out = clean(
      '<figure style="position: relative; width: 300px;"><img class="bn-visual-media" src="/api/public/tok/files/abc" alt="x.png" width="300"></figure>' +
        '<a href="/s/tok/p/ref">int</a><table style="--default-cell-min-width: 120px;"><colgroup><col style="width: 100px;"></colgroup><tbody><tr><td colspan="1" colwidth="100"><p>a</p></td></tr></tbody></table>' +
        '<div class="bn-resize-handle" style="left: 4px; display: none;"></div>',
    )
    assert.match(out, /src="\/api\/public\/tok\/files\/abc"/)
    assert.match(out, /href="\/s\/tok\/p\/ref"/)
    assert.match(out, /style="position: relative; width: 300px;"/)
    assert.match(out, /style="--default-cell-min-width: 120px;"/)
    assert.match(out, /style="left: 4px; display: none;"/)
  })

  it('removes scripts, styles, iframes, objects, templates, forms, math with their content', () => {
    const out = clean(
      '<p>ok</p><script>alert(1)</script><style>*{}</style><iframe src="https://ex.com"></iframe>' +
        '<object data="x"></object><embed src="x"><template><img src=x onerror=alert(1)></template>' +
        '<form action="https://evil.com"><button>go</button></form><math><mi>x</mi></math><noscript><img src=x onerror=alert(1)></noscript>',
    )
    assert.equal(out, '<p>ok</p>')
  })

  it('drops every on* handler and unknown attributes', () => {
    const out = clean('<p onclick="alert(1)" onmouseover="x" foo="bar" class="k">t</p><img src="https://ex.com/a.png" onerror="alert(1)" srcset="javascript:alert(1)">')
    assert.equal(out, '<p class="k">t</p><img src="https://ex.com/a.png">')
  })

  it('drops dangerous href/src schemes and cross-origin tricks', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:https://notes.example.org/x',
      '//evil.com/x',
      '/\\evil.com',
      '/\t/evil.com',
      '/w/ws/p/page', // internal app path: not on the public prefix list
      '/api/pages/x',
    ]) {
      const out = clean(`<a href="${href.replace(/"/g, '&quot;')}">x</a>`)
      assert.equal(out, '<a>x</a>', href)
    }
    assert.equal(clean('<img src="data:image/svg+xml,<svg onload=alert(1)>">'), '<img>')
    assert.equal(clean('<video src="javascript:alert(1)" controls=""></video>'), '<video controls=""></video>')
    assert.equal(clean('<a href="mailto:a@b.c">m</a>'), '<a href="mailto:a@b.c">m</a>')
    assert.equal(clean('<img src="mailto:a@b.c">'), '<img>')
  })

  it('strips url()/expression()/javascript: from style and drops non-layout properties', () => {
    assert.equal(clean('<div style="background-image: url(https://evil.com/x)">t</div>'), '<div>t</div>')
    assert.equal(clean('<div style="width: expression(alert(1))">t</div>'), '<div>t</div>')
    assert.equal(clean('<div style="width: 10px; background: url(javascript:alert(1)); display: none">t</div>'), '<div style="width: 10px; display: none;">t</div>')
    assert.equal(clean('<div style="width: 1\\0px">t</div>'), '<div>t</div>')
  })

  it('keeps only the svg/path icon subset; drops foreignObject, use, script and svg links', () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8L9 2Z"></path></svg>'
    assert.equal(clean(icon), icon)
    const out = clean(
      '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject><use href="https://evil.com/#x"></use>' +
        '<script>alert(1)</script><a href="javascript:alert(1)"><path d="M0 0"></path></a><animate attributeName="href" to="javascript:alert(1)"></animate></svg>',
    )
    assert.equal(out, '<svg></svg>')
  })

  it('unwraps unknown harmless elements but keeps their text', () => {
    assert.equal(clean('<custom-el data-x="1"><b>bold</b> text</custom-el>'), '<b>bold</b> text')
  })

  it('forces inert form controls and safe link rel', () => {
    assert.equal(clean('<input type="checkbox" checked="">'), '<input type="checkbox" checked="" disabled="">')
    assert.equal(clean('<input type="text" value="x">'), '')
    assert.equal(clean('<button type="submit">b</button>'), '<button type="button">b</button>')
    assert.equal(clean('<a href="https://ex.com" target="_blank" rel="opener">x</a>'), '<a href="https://ex.com/" target="_blank" rel="noopener noreferrer nofollow">x</a>')
    assert.equal(clean('<a href="https://ex.com" target="other">x</a>'), '<a href="https://ex.com/">x</a>')
  })

  it('removes comments and is idempotent on mXSS-style inputs', () => {
    const inputs = [
      '<!-- x --><p>t</p>',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<a href="https://ex.com/&quot;onmouseover=&quot;alert(1)">x</a>',
    ]
    for (const html of inputs) {
      const once = clean(html)
      // No attribute named on* (a quote-broken URL stays inside the percent-encoded href value).
      assert.doesNotMatch(once, /\son[a-z]+=|<script|<style|<!--/i, html)
      assert.equal(clean(once), once, html)
    }
  })
})

describe('safeUrl (0852)', () => {
  it('media URLs: http(s) and public prefixes only', () => {
    assert.equal(safeUrl('https://ex.com/a.png', 'media', O), 'https://ex.com/a.png')
    assert.equal(safeUrl('/api/public/t/files/1', 'media', O), '/api/public/t/files/1')
    assert.equal(safeUrl('/files/1', 'media', O), '/files/1')
    assert.equal(safeUrl('data:image/png;base64,AAAA', 'media', O), null)
    assert.equal(safeUrl('javascript:alert(1)', 'media', O), null)
    assert.equal(safeUrl('/\\evil.com/a.png', 'media', O), null)
    assert.equal(safeUrl('', 'media', O), null)
  })
})
