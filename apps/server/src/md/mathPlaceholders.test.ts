// Markdown import: `$` where no math node can go (image alt text, hrefs, props) and `$` inside bare
// URLs (docs/adr/0996-*). Math is cut out as sentinels before BlockNote parses the body (md/math.ts);
// none may survive into the blocks, and a URL's `$` is never a delimiter. Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markdownToBlocks } from './convert'
import type { AnyBlock } from './convert'

const noTitles = () => null
const parse = (md: string) => markdownToBlocks(md, noTitles)
/** `Iq` + 12 letters a–p, kind, counter, `Q` (math.ts `newSentinels` / `sentinel`). */
const SENTINEL = /Iq[a-p]{12}[BID]\d+Q/
const strip = (blocks: AnyBlock[]): unknown => JSON.parse(JSON.stringify(blocks, (k, v) => (k === 'id' ? undefined : v)))
const inlines = (b: AnyBlock): unknown =>
  (b.content as { type: string; text?: string; props?: unknown; href?: string; content?: { text: string }[] }[]).map((c) =>
    c.type === 'text'
      ? c.text
      : c.type === 'link'
        ? { link: c.href, text: (c.content ?? []).map((x) => x.text).join('') }
        : { [c.type]: c.props },
  )

describe('math import: what already worked stays the same', () => {
  it('inline $…$, $$ blocks, prices, code, link text, fenced code and table cells', async () => {
    const [p] = await parse('Let $a_1 + b$ be')
    assert.deepEqual(inlines(p), ['Let ', { inlineMath: { latex: 'a_1 + b' } }, ' be'])

    const block = await parse('$$\n\\int_0^1 x\\,dx\n$$')
    assert.equal(block.length, 1)
    assert.equal(block[0].type, 'math')
    assert.equal(block[0].props?.latex, '\\int_0^1 x\\,dx')
    const one = await parse('$$E=mc^2$$')
    assert.equal(one[0].type, 'math')
    assert.equal(one[0].props?.latex, 'E=mc^2')

    assert.deepEqual(inlines((await parse('price $5 and $10'))[0]), ['price $5 and $10'])
    const [code] = await parse('`$x$` code')
    assert.deepEqual(strip([code]), strip([{ ...code, content: [{ type: 'text', text: '$x$', styles: { code: true } }, { type: 'text', text: ' code', styles: {} }] }]))

    // link text holds styled text only: math there comes back as its source
    assert.deepEqual(inlines((await parse('[$x$ text](https://a.com) $y$'))[0]), [
      { link: 'https://a.com', text: '$x$ text' },
      ' ',
      { inlineMath: { latex: 'y' } },
    ])

    const [fence] = await parse('```js\ncode $y$ \\$5\n```')
    assert.equal(fence.type, 'codeBlock')
    assert.deepEqual(inlines(fence), ['code $y$ \\$5'])

    const [table] = await parse('| a $x$ | b |\n| :--- | ---: |\n| $y$ | $5 and $10 |')
    const rows = (table.content as { rows: { cells: { content: AnyBlock['content'] }[] }[] }).rows
    const cell = (r: number, c: number) => inlines({ type: 'paragraph', content: rows[r].cells[c].content } as AnyBlock)
    assert.deepEqual(cell(0, 0), ['a ', { inlineMath: { latex: 'x' } }])
    assert.deepEqual(cell(1, 0), [{ inlineMath: { latex: 'y' } }])
    assert.deepEqual(cell(1, 1), ['$5 and $10'])
  })
})

describe('math import: no sentinel is left in the blocks', () => {
  it('image alt text keeps its $…$ as written', async () => {
    const [img] = await parse('![그림 $x$](https://example.com/i.png)')
    assert.equal(img.type, 'image')
    assert.equal(img.props?.name, '그림 $x$')
    const [linked] = await parse('[![img $x$ and \\$5](https://e.com/i.png)](https://e.com)')
    assert.equal(linked.props?.name, 'img $x$ and $5')
  })

  for (const [where, md] of [
    ['image alt', '![그림 $x$](https://example.com/i.png)'],
    ['image alt with display math', '![a $$x$$ b](https://example.com/i.png)'],
    ['linked image alt', '[![img $x$](https://e.com/i.png)](https://e.com)'],
    ['angle-bracket link destination', '[a](<https://a.com/$x$ y>) $z$'],
    ['single-quoted link title', "[a](https://a.com 't $y$') $z$"],
    ['double-quoted link title', '[a](https://a.com "t $y$") $z$'],
    ['code fence info string', '```js $x$\ncode $y$\n```'],
    ['table alignment row and cells', '| a $x$ | b |\n| :--- | ---: |\n| $y$ | \\$5 |'],
    ['callout type line', '> [!warning] $x$ title\n> body $y$'],
    ['file block token', '<!-- inkling:file {"url":"https://e.com/a.pdf","name":"a $x$.pdf"} -->\n\n$y$'],
    ['mention label', '@[Ann $x$](user:00000000-0000-0000-0000-000000000001) and $y$'],
    ['escaped dollar beside an image', '![\\$5 $x$](https://e.com/i.png)\n\nmore \\$5 and $y$'],
  ] as const) {
    it(where, async () => {
      const json = JSON.stringify(await parse(md))
      assert.doesNotMatch(json, SENTINEL, json)
    })
  }
})

describe('math import: `$` in URLs is not a delimiter', () => {
  it('bare URL with OData-style query keeps its text', async () => {
    const url = 'https://api.example.com/x?$filter=a&$select=b'
    assert.deepEqual(inlines((await parse(url))[0]), [url])
    assert.deepEqual(inlines((await parse('www.example.com/$a$b'))[0]), ['www.example.com/$a$b'])
  })

  it('<…> autolink keeps its text', async () => {
    const md = '<https://api.example.com/x?$filter=a&$select=b>'
    assert.doesNotMatch(JSON.stringify(inlines((await parse(md))[0])), /inlineMath/)
  })

  it('math elsewhere on the line is still math', async () => {
    assert.deepEqual(inlines((await parse('see https://a.com/?$x=1&$y=2 and $z$'))[0]), [
      'see https://a.com/?$x=1&$y=2 and ',
      { inlineMath: { latex: 'z' } },
    ])
  })
})
