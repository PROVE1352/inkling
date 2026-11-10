// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/clipQuery.test.ts
// /clip query normalization (share-sheet shapes), tags, and the bookmarklet (docs/adr/2263-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { BOOKMARKLET_MAX_URL, buildBookmarklet, cutText, normalizeClipQuery, parseClipTags } from './clipQuery'

const q = (o: Record<string, string>) => normalizeClipQuery(new URLSearchParams(o))

describe('normalizeClipQuery', () => {
  it('bookmarklet shape: title, url and text as given', () => {
    assert.deepEqual(q({ title: 'Budget  passes', url: 'https://news.example.com/a?b=1', text: 'A quote\n\nsecond' }), {
      title: 'Budget passes',
      url: 'https://news.example.com/a?b=1',
      text: 'A quote\n\nsecond',
    })
  })

  it('Android Chrome share: title + the URL in text, url empty', () => {
    assert.deepEqual(q({ title: 'Budget passes', text: 'https://news.example.com/a', url: '' }), {
      title: 'Budget passes',
      text: '',
      url: 'https://news.example.com/a',
    })
  })

  it('share without title: headline and link in text', () => {
    assert.deepEqual(q({ text: 'Budget passes https://news.example.com/a' }), { title: 'Budget passes', text: '', url: 'https://news.example.com/a' })
    // a link inside a sentence loses the punctuation after it
    assert.deepEqual(q({ text: 'Read this (https://x.example/p).' }).url, 'https://x.example/p')
    // the last link wins; earlier ones stay in the text
    const many = q({ title: 'T', text: 'see https://a.example/1 and\nhttps://b.example/2' })
    assert.equal(many.url, 'https://b.example/2')
    assert.equal(many.text, 'see https://a.example/1 and')
  })

  it('URL only, as url, as text or as title', () => {
    for (const o of [{ url: 'https://a.example/x' }, { text: 'https://a.example/x' }, { title: 'https://a.example/x' }]) {
      assert.deepEqual(q(o), { title: '', text: '', url: 'https://a.example/x' }, JSON.stringify(o))
    }
  })

  it('the URL or the title repeated in the text is dropped', () => {
    assert.equal(q({ title: 'T', url: 'https://a.example/', text: 'quote https://a.example' }).text, 'quote')
    assert.equal(q({ title: 'Same title', text: 'Same   title', url: 'https://a.example/' }).text, '')
  })

  it('only http(s): javascript:, data:, file: and credentials are dropped', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://u:p@a.example/']) {
      assert.equal(q({ url: bad, title: 't' }).url, '', bad)
    }
    assert.equal(q({ text: 'javascript:alert(1)' }).url, '')
  })

  it('caps and control characters; surrogate pairs are never split', () => {
    const r = q({ title: 'a\u0000b\u0007c'.padEnd(400, 'x'), text: '😀'.repeat(30_000), url: 'https://a.example/' + 'p'.repeat(3000) })
    assert.equal(r.title.length, 300)
    assert.ok(r.title.startsWith('abc'))
    assert.equal(Array.from(r.text).length, 20_000)
    assert.ok(!r.text.includes('�'))
    assert.equal(r.url, '')
    assert.equal(cutText('가😀나', 2), '가😀')
  })
})

describe('parseClipTags', () => {
  it('splits on spaces and commas, strips #, keeps letters/digits/_/-, dedupes, caps at 10', () => {
    assert.deepEqual(parseClipTags('#read, 나중에 read Read bad!tag x/y'), { tags: ['read', '나중에', 'x/y'], invalid: ['bad!tag'] })
    assert.equal(parseClipTags(Array.from({ length: 15 }, (_, i) => `t${i}`).join(' ')).tags.length, 10)
    assert.deepEqual(parseClipTags('   '), { tags: [], invalid: [] })
  })
})

describe('bookmarklet', () => {
  const run = (code: string, page: { title: string; href: string; selection: string; popupBlocked?: boolean }) => {
    const opened: string[] = []
    const loc = { href: page.href }
    const win = {
      getSelection: () => ({ toString: () => page.selection }),
      open: (u: string) => {
        opened.push(u)
        return page.popupBlocked ? null : { focus() {} }
      },
    }
    vm.runInNewContext(decodeURI(code.slice('javascript:'.length)), { window: win, document: { title: page.title }, location: loc, encodeURIComponent, Array, String, Math, JSON })
    return { opened, location: loc.href }
  }

  it('is a javascript: URL with the server address and no secret', () => {
    const b = buildBookmarklet('https://notes.example.com/')
    assert.ok(b.startsWith('javascript:'))
    assert.ok(b.includes('"https://notes.example.com/clip?"'))
    assert.ok(!/token|secret|cookie|Bearer/i.test(b))
    // no "%" a bookmark URL would decode, no line breaks
    assert.ok(!/[%\n]/.test(b))
  })

  it('opens /clip with title, url and selection', () => {
    const r = run(buildBookmarklet('https://notes.example.com'), { title: 'Hello & bye', href: 'https://site.example/a?b=1#c', selection: '  picked text  ' })
    assert.equal(r.opened.length, 1)
    const u = new URL(r.opened[0])
    assert.equal(u.origin + u.pathname, 'https://notes.example.com/clip')
    assert.equal(u.searchParams.get('title'), 'Hello & bye')
    assert.equal(u.searchParams.get('url'), 'https://site.example/a?b=1#c')
    assert.equal(u.searchParams.get('text'), 'picked text')
  })

  it('cuts a long selection so the address fits, without splitting characters', () => {
    const r = run(buildBookmarklet('https://notes.example.com'), { title: 't', href: 'https://site.example/', selection: '한글😀'.repeat(5000) })
    assert.ok(r.opened[0].length <= BOOKMARKLET_MAX_URL)
    const text = new URL(r.opened[0]).searchParams.get('text')
    assert.ok(text.length > 100)
    assert.ok(text.endsWith('…'))
    assert.ok(!text.includes('�'))
  })

  it('a blocked popup falls back to opening /clip in the tab', () => {
    const r = run(buildBookmarklet('https://notes.example.com'), { title: 't', href: 'https://site.example/', selection: '', popupBlocked: true })
    assert.ok(r.location.startsWith('https://notes.example.com/clip?title=t&url='))
    assert.ok(!r.location.includes('text='))
  })
})
