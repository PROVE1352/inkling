// Run: cd apps/server && npx tsx --test src/linkPreview.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeHtml, extractHeadMeta } from './linkPreview'

describe('extractHeadMeta', () => {
  it('reads OG, twitter, title and icons', () => {
    const html = `<!doctype html><html><head>
      <!-- <meta property="og:title" content="commented out"> -->
      <title>Plain &amp; title</title>
      <meta property="og:title" content="OG &quot;title&quot;">
      <meta name=description content='Desc &#x41;&#66;'>
      <meta property="og:site_name" content="Site">
      <meta property="og:image" content="/img/a.png">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="//cdn.example.com/fav.ico">
      <script>var x = "<meta property='og:description' content='from script'>"</script>
      </head><body><meta property="og:description" content="after head"></body></html>`
    const m = extractHeadMeta(html, 'https://example.com/post/1')
    assert.equal(m.title, 'OG "title"')
    assert.equal(m.description, 'Desc AB')
    assert.equal(m.siteName, 'Site')
    assert.equal(m.image, 'https://example.com/img/a.png')
    assert.equal(m.favicon, 'https://cdn.example.com/fav.ico')
  })
  it('falls back to <title> and /favicon.ico; drops non-https images', () => {
    const m = extractHeadMeta('<title>  Hello\n world </title><meta property="og:image" content="http://x.com/a.png">', 'https://a.com/')
    assert.equal(m.title, 'Hello world')
    assert.equal(m.image, null)
    assert.equal(m.favicon, 'https://a.com/favicon.ico')
  })
  it('rejects javascript: and data: image URLs', () => {
    const m = extractHeadMeta('<meta property="og:image" content="javascript:alert(1)"><link rel=icon href="data:image/png;base64,AAAA">', 'https://a.com/')
    assert.equal(m.image, null)
    assert.equal(m.favicon, 'https://a.com/favicon.ico')
  })
  it('handles Unicode case-folding without index drift', () => {
    const m = extractHeadMeta('<TITLE>İİİ Ünïcode</TITLE><META PROPERTY="og:description" CONTENT="ok">', 'https://a.com/')
    assert.equal(m.title, 'İİİ Ünïcode')
    assert.equal(m.description, 'ok')
  })
  it('is linear on adversarial input (no ReDoS)', () => {
    const inputs = [
      '<meta '.repeat(40000),
      '<'.repeat(250000),
      '<meta content="' + 'a'.repeat(250000),
      '<!--' + '-'.repeat(250000),
      '<script>' + '<'.repeat(250000),
      '<a ' + 'b='.repeat(100000),
      '&#'.repeat(100000) + '&amp'.repeat(50000),
      ('<a ' + 'b '.repeat(65)).repeat(1900) + '>',
      ('<a b="' + 'x'.repeat(100)).repeat(2000) + '>',
    ]
    for (const s of inputs) {
      const t0 = performance.now()
      extractHeadMeta(s, 'https://a.com/')
      const ms = performance.now() - t0
      assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`)
    }
  })
})

describe('decodeHtml', () => {
  it('uses the header charset', () => {
    const euckr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]) // "한글" in EUC-KR
    assert.equal(decodeHtml(euckr, 'text/html; charset=euc-kr'), '한글')
  })
  it('sniffs <meta charset>', () => {
    const body = Buffer.concat([Buffer.from('<meta charset="euc-kr"><title>'), Buffer.from([0xc7, 0xd1]), Buffer.from('</title>')])
    assert.ok(decodeHtml(body, 'text/html').includes('한'))
  })
  it('falls back to utf-8 on unknown labels', () => {
    assert.equal(decodeHtml(Buffer.from('é'), 'text/html; charset=bogus-xyz'), 'é')
  })
})
