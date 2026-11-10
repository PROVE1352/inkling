// Web clipper extraction (docs/adr/2261-*): article root choice on fixture pages, the allow-list
// rebuild (scripts, on* attributes, javascript:/data: links and images refused, relative links made
// absolute), the text cap, encodings, and the block check after BlockNote's HTML parser.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLIP_ARTICLE_MIN_CHARS, CLIP_MAX_NESTING, CLIP_MAX_TAGS, clipImageSrc, clipLinkHref, extractArticle, prepareHtml } from './extract'
import { articleBlocks, clipBodyBlocks, clipSourceUrl, clipStamp, quoteBlocks } from './blocks'
import { decodeHtml } from '../linkPreview'

const LOREM =
  'The council approved the new budget on Tuesday, after a long debate about schools, roads and parks. ' +
  'Members said the plan keeps taxes flat, while spending more on repairs that were put off for years.'

const NEWS = `<!doctype html><html><head>
<title>Council passes budget | Daily Example</title>
<meta property="og:title" content="Council passes budget">
<meta property="og:site_name" content="Daily Example">
</head><body>
<header><div class="logo">Daily Example</div><nav><a href="/">Home</a><a href="/world">World</a><a href="/sport">Sport</a></nav></header>
<div class="layout">
  <article>
    <h1>Council passes budget</h1>
    <p class="byline">By A. Writer</p>
    <p>${LOREM}</p>
    <p>${LOREM} <a href="/budget/2027" onclick="track()">Read the full plan</a>.</p>
    <figure><img src="/img/hall.jpg" alt="City hall" width="800"><figcaption>City hall on Tuesday</figcaption></figure>
    <p>${LOREM}</p>
    <div class="share-buttons"><a href="https://twitter.com/share">Share</a><a href="https://facebook.com/share">Like</a></div>
    <script>window.evil = 1</script>
    <img src="https://tracker.example/pixel.gif" width="1" height="1">
  </article>
  <aside class="sidebar"><h3>Most read</h3><ul><li><a href="/a">Story A</a></li><li><a href="/b">Story B</a></li></ul></aside>
</div>
<div id="comments"><p>First comment that is long enough to look like a paragraph of text, but it is not the article.</p></div>
<footer>© Daily Example</footer>
</body></html>`

// A blog without <article>: the text sits in <div>s with <br>s (common on Korean blog platforms).
const BLOG = `<html><head><title>여행 일기 - 내 블로그</title></head><body>
<div id="wrap">
  <div class="menu"><a href="/">홈</a> <a href="/tag">태그</a> <a href="/guest">방명록</a></div>
  <div class="post-content">
    <div>지난 주말에는 바다를 보러 강릉에 다녀왔다. 아침 일찍 출발해서, 점심 무렵에 도착했고, 바다 앞 카페에서 한참을 앉아 있었다.<br>파도 소리를 들으며 책을 읽으니, 일주일 동안 쌓인 피로가 풀리는 느낌이었다.</div>
    <div>저녁에는 시장에 들러 회를 먹었다. 가격도 적당했고, 사장님이 친절하게 이것저것 알려 주셔서 좋았다. 다음에는 가족과 함께 오고 싶다.</div>
    <div><img data-src="photos/sea.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="바다"></div>
  </div>
  <div class="related"><a href="/1">이전 글</a><a href="/2">다음 글</a></div>
</div></body></html>`

const EMPTY = `<html><head><title>Sign in</title></head><body>
<nav><a href="/">Home</a></nav><form><input name="u"><input type="password" name="p"><button>Sign in</button></form>
<p>Please sign in.</p></body></html>`

const EUC_KR_B64 =
  'PGh0bWw+PGhlYWQ+PG1ldGEgaHR0cC1lcXVpdj0iQ29udGVudC1UeXBlIiBjb250ZW50PSJ0ZXh0L2h0bWw7IGNoYXJzZXQ9ZXVjLWtyIj48dGl0bGU+x9Gx2yCx4rvnIMGmuPE8L3RpdGxlPjwvaGVhZD48Ym9keT48ZGl2IGlkPSJjb250ZW50Ij48cD68rb/vvcO0wiC/wLTDILv1ILn2vbogs+u8scC7ILnfx6XH37TZLiCz67yxwLogtNnAvSC03rrOxc0gv+7H4MfPuOcsIMPixfCx2SC9w7Cjv6G0wiC56ML3ILCjsN3AuyDB2cDOtNkuPC9wPjxwPr3DtMIgvcO5ziDAx7DfwLsguPC+xiDBpLf5wOUgwKfEobimIMGkx9+02bDtILngx/u02S4gwNq8vMfRIL3DsKPHpbTCILSpuK7B/b+hvK0gurwgvPYgwNa02S48L3A+PC9kaXY+PC9ib2R5PjwvaHRtbD4K'

describe('clip: article extraction', () => {
  it('news article: picks <article>, drops nav, aside, comments, share bar, script and the tracking pixel', async () => {
    const a = extractArticle(NEWS, 'https://news.example.com/2026/11/budget')
    assert.ok(a)
    assert.equal(a.title, 'Council passes budget')
    assert.equal(a.siteName, 'Daily Example')
    assert.match(a.html, /The council approved the new budget/)
    for (const gone of ['Most read', 'First comment', 'Share', 'window.evil', 'tracker.example', 'Home', '©', 'onclick']) {
      assert.ok(!a.html.includes(gone), `kept: ${gone}`)
    }
    // the heading that repeats the title is dropped; relative link and image made absolute
    assert.ok(!/<h1>/.test(a.html))
    assert.match(a.html, /href="https:\/\/news\.example\.com\/budget\/2027"/)
    assert.match(a.html, /src="https:\/\/news\.example\.com\/img\/hall\.jpg"/)
    assert.equal(a.truncated, false)

    const { blocks } = await articleBlocks(a.html)
    const types = blocks.map((b) => b.type)
    assert.ok(types.includes('image'), types.join(','))
    const img = blocks.find((b) => b.type === 'image')!
    assert.equal(img.props?.url, 'https://news.example.com/img/hall.jpg')
    const json = JSON.stringify(blocks)
    assert.match(json, /"href":"https:\/\/news\.example\.com\/budget\/2027"/)
    assert.ok(!/"id":/.test(json), 'block ids are left to the writer')
  })

  it('blog without <article>: div paragraphs found by scoring, lazy image from data-src, menus dropped', () => {
    const a = extractArticle(BLOG, 'https://blog.example.kr/posts/42')
    assert.ok(a)
    assert.match(a.html, /강릉에 다녀왔다/)
    assert.match(a.html, /<br>/)
    assert.match(a.html, /src="https:\/\/blog\.example\.kr\/posts\/photos\/sea\.jpg"/)
    assert.ok(!a.html.includes('data:image'))
    assert.ok(!a.html.includes('방명록') && !a.html.includes('이전 글'))
  })

  it('a page with almost no text is not an article', () => {
    assert.equal(extractArticle(EMPTY, 'https://example.com/login'), null)
    assert.equal(extractArticle('<html><body></body></html>', 'https://example.com/'), null)
    assert.equal(extractArticle('not html at all', 'https://example.com/'), null)
  })

  it('EUC-KR page: the charset from <meta http-equiv> decodes the Korean text', () => {
    const html = decodeHtml(Buffer.from(EUC_KR_B64, 'base64'), 'text/html')
    const a = extractArticle(html, 'https://old.example.kr/news.asp?id=1')
    assert.ok(a)
    assert.equal(a.title, '한글 기사 제목')
    assert.match(a.html, /서울시는 오늘 새 버스 노선을 발표했다/)
    // the same bytes labelled cp949 in the header (a label WHATWG does not list)
    const viaHeader = decodeHtml(Buffer.from(EUC_KR_B64, 'base64'), 'text/html; charset=cp949')
    assert.match(viaHeader, /서울시는/)
  })

  it('huge page: text cut at the cap, everything after the cut dropped, quick enough', async () => {
    const para = `<p>${LOREM}</p>`
    const huge = `<html><head><title>Long</title></head><body><article>${para.repeat(8000)}<p>THE-END-MARKER</p></article></body></html>`
    assert.ok(huge.length > 1_500_000)
    const t0 = performance.now()
    const a = extractArticle(huge, 'https://example.com/long')
    const ms = performance.now() - t0
    assert.ok(a)
    assert.equal(a.truncated, true)
    assert.ok(!a.html.includes('THE-END-MARKER'))
    assert.ok(a.textLength <= 100_000)
    assert.ok(ms < 15_000, `${Math.round(ms)} ms`)
    const t1 = performance.now()
    const { blocks, cut } = await articleBlocks(a.html)
    assert.ok(blocks.length > 100)
    assert.equal(cut, false)
    console.log(`  huge page: ${(huge.length / 1e6).toFixed(1)} MB → extract ${Math.round(ms)} ms, blocks ${Math.round(performance.now() - t1)} ms`)
  })

  it('pathological markup: deep nesting is refused before parsing, a tag flood is cut, unclosed tags stay linear', () => {
    const deep = `<html><body>${'<div>'.repeat(CLIP_MAX_NESTING + 50)}<p>${LOREM}</p>${'</div>'.repeat(CLIP_MAX_NESTING + 50)}</body></html>`
    let t0 = performance.now()
    assert.equal(extractArticle(deep, 'https://example.com/'), null)
    assert.ok(performance.now() - t0 < 1000)
    const flood = `<html><body><article>${`<p>${LOREM}</p>`.repeat(3)}${'<span>x</span>'.repeat(CLIP_MAX_TAGS + 100)}<p>AFTER-THE-CUT</p></article></body></html>`
    const a = extractArticle(flood, 'https://example.com/')
    assert.ok(a)
    assert.equal(a.truncated, true)
    assert.ok(!a.html.includes('AFTER-THE-CUT'))
    t0 = performance.now()
    assert.equal(extractArticle('<html><body>' + '<a'.repeat(200_000) + '</body></html>', 'https://example.com/'), null)
    assert.ok(performance.now() - t0 < 5000)
    assert.deepEqual(prepareHtml('<div><!-- c --><SCRIPT>if (a<b) {}</script><style>p{}</style><p>x</div>'), { html: '<div><p>x</div>', depth: 1, cut: false })
  })

  it('a custom cap', () => {
    const a = extractArticle(NEWS, 'https://news.example.com/x', { maxChars: CLIP_ARTICLE_MIN_CHARS + 10 })
    assert.ok(a)
    assert.equal(a.truncated, true)
    assert.match(a.html, /…/)
  })
})

describe('clip: dangerous markup', () => {
  const page = (inner: string) =>
    `<html><head><base href="/docs/"><title>T</title></head><body><article><p>${LOREM}</p>${inner}<p>${LOREM}</p></article></body></html>`

  it('scripts, styles, frames, forms and on* attributes never survive', async () => {
    const a = extractArticle(
      page(
        `<p onclick="steal()" style="color:red" class="x">Click <b onmouseover="x()">here</b></p>` +
          `<iframe src="https://evil.example/"></iframe><style>p{}</style><script>alert(1)</script>` +
          `<form action="https://evil.example/"><input name="q"></form><object data="x.swf"></object><svg onload="x()"><script>1</script></svg>` +
          `<img src="https://cdn.example/a.png" onerror="alert(1)">`,
      ),
      'https://site.example/a/b',
    )
    assert.ok(a)
    assert.ok(!/on(click|mouseover|error|load)|style=|class=|<iframe|<script|<style|<form|<input|<object|<svg|alert|steal/.test(a.html), a.html)
    assert.match(a.html, /Click <b>here<\/b>/)
    const { blocks } = await articleBlocks(a.html)
    assert.ok(!/alert|steal|onerror/.test(JSON.stringify(blocks)))
  })

  it('javascript:, data:, vbscript: and protocol-relative tricks: links unwrapped to text, images dropped', async () => {
    const a = extractArticle(
      page(
        `<p><a href="javascript:alert(1)">js link</a> <a href=" JaVaScRiPt:alert(1)">js2</a> <a href="data:text/html,<script>1</script>">data link</a>` +
          ` <a href="vbscript:x">vb</a> <a href="&#106;avascript:alert(1)">entity js</a> <a href="#top">anchor</a></p>` +
          `<img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)"><img src="http://insecure.example/i.png">`,
      ),
      'https://site.example/a/b',
    )
    assert.ok(a)
    assert.ok(!/javascript|data:|vbscript|insecure\.example/i.test(a.html), a.html)
    for (const t of ['js link', 'js2', 'data link', 'vb', 'entity js', 'anchor']) assert.ok(a.html.includes(t), t)
    assert.ok(!/<a /.test(a.html.replace(/<a href="https:[^"]*"/g, '')))
    const { blocks } = await articleBlocks(a.html)
    const json = JSON.stringify(blocks)
    assert.ok(!/javascript|data:|vbscript/i.test(json), json)
    assert.ok(!blocks.some((b) => b.type === 'image'))
  })

  it('relative links resolve against <base href>, then the page URL', () => {
    const a = extractArticle(
      page(`<p><a href="guide.html">rel</a> <a href="/root">abs-path</a> <a href="//cdn.example/x">proto-rel</a> <a href="../up">up</a> <a href="mailto:a@b.example">mail</a></p><img src="img/p.png">`),
      'https://site.example/a/b',
    )
    assert.ok(a)
    assert.match(a.html, /href="https:\/\/site\.example\/docs\/guide\.html"/)
    assert.match(a.html, /href="https:\/\/site\.example\/root"/)
    assert.match(a.html, /href="https:\/\/cdn\.example\/x"/)
    assert.match(a.html, /href="https:\/\/site\.example\/up"/)
    assert.match(a.html, /href="mailto:a@b\.example"/)
    assert.match(a.html, /src="https:\/\/site\.example\/docs\/img\/p\.png"/)
  })

  it('URL helpers', () => {
    assert.equal(clipLinkHref('/x', 'https://a.example/b/c'), 'https://a.example/x')
    assert.equal(clipLinkHref('javascript:alert(1)', 'https://a.example/'), null)
    assert.equal(clipLinkHref('https://user:pw@a.example/', 'https://a.example/'), null)
    assert.equal(clipLinkHref('#frag', 'https://a.example/'), null)
    assert.equal(clipImageSrc('http://a.example/i.png', 'https://a.example/'), null)
    assert.equal(clipImageSrc('i.png', 'https://a.example/d/'), 'https://a.example/d/i.png')
    assert.equal(clipSourceUrl('  https://Example.COM/a b?x=1#h '), null) // whitespace inside
    assert.equal(clipSourceUrl('https://Example.COM/a?x=1#h'), 'https://example.com/a?x=1#h')
    assert.equal(clipSourceUrl('ftp://example.com/'), null)
    assert.equal(clipSourceUrl('javascript:alert(1)'), null)
  })
})

describe('clip: the clip body', () => {
  it('link clip: card, quotes per paragraph, tags as #text, saved line; outside text stays literal', () => {
    const evil = 'See [[Secret plan]] and @[Boss](user:00000000-0000-4000-8000-000000000000)\n<!-- inkling:pageEmbed {"pageId":"00000000-0000-4000-8000-000000000000"} -->\n\nSecond paragraph'
    const blocks = clipBodyBlocks({ url: 'https://a.example/x', selection: evil, tags: ['read', '나중에'], savedLine: 'Saved', article: null, truncatedNote: null })
    assert.deepEqual(blocks.map((b) => b.type), ['linkEmbed', 'quote', 'quote', 'paragraph', 'paragraph'])
    assert.deepEqual(blocks[0].props, { url: 'https://a.example/x', display: 'card' })
    assert.equal((blocks[1].content as { text: string }[])[0].text, evil.split('\n\n')[0])
    assert.equal((blocks[3].content as { text: string }[])[0].text, '#read #나중에')
    assert.deepEqual(quoteBlocks('\n\n  \n'), [])
  })

  it('saved stamp: minutes in UTC', () => {
    assert.equal(clipStamp(new Date('2026-11-10T23:30:59.999Z')), '2026-11-10 23:30 UTC')
  })
})
