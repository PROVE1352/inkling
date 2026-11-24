// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Math and callout notation in pasted Markdown (lib/paste/markdownNotation.ts): which `$` become
// math (the server's rule, apps/server/src/md/math.ts), how sentinels come back as nodes, and the
// `> [!type]` quote that becomes a callout. BlockNote's parser is stood in for by hand-made blocks.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareMarkdownPaste } from './markdownNotation'

const P = (text, styles = {}) => ({ id: 'p', type: 'paragraph', props: {}, content: text ? [{ type: 'text', text, styles }] : [], children: [] })

/** Sentinels in the prepared Markdown → what BlockNote would have parsed: one paragraph per line. */
function roundTrip(md) {
  const prep = prepareMarkdownPaste(md)
  if (!prep) return null
  const blocks = prep.markdown
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => P(l.trim()))
  return prep.restore(blocks)
}

describe('paste: which dollars are math (server rule)', () => {
  const literal = [
    '가격은 $5 and $10 입니다',
    '$ npm install',
    '닫는 기호가 없는 $x 줄',
    '$ x $',
    '\\$x\\$',
    '인라인 코드 `$x$` 입니다',
    '[링크](https://example.com/$a$)',
    // bare URLs are masked on paste (the server's import does not mask them)
    'https://api.example.com/x?$filter=a&$select=b',
    '주소는 www.example.com/$a$b 입니다',
  ]
  for (const md of literal) {
    it(`stays text: ${md}`, () => {
      assert.equal(prepareMarkdownPaste(md), null)
    })
  }

  it('fenced code keeps $a$ and $$x$$ as written', () => {
    const md = '```\n$a$\n$$x$$\n$$\ny\n$$\n```'
    assert.equal(prepareMarkdownPaste(md), null)
    const tilde = '~~~sh\necho $a$\n~~~'
    assert.equal(prepareMarkdownPaste(tilde), null)
  })

  it('a table cell with $5 stays text', () => {
    assert.equal(prepareMarkdownPaste('| 항목 | 값 |\n| --- | --- |\n| 커피 | $5 |'), null)
  })

  it('echo $HOME/$USER is a span by the server rule (closing $ after "/", before a letter)', () => {
    const out = roundTrip('echo $HOME/$USER')
    assert.deepEqual(out[0].content, [
      { type: 'text', text: 'echo ', styles: {} },
      { type: 'inlineMath', props: { latex: 'HOME/' } },
      { type: 'text', text: 'USER', styles: {} },
    ])
  })
})

describe('paste: math nodes', () => {
  it('$$ … $$ on its own lines becomes a math block', () => {
    const prep = prepareMarkdownPaste('앞\n\n$$\nE = mc^2\n$$\n\n뒤')
    assert.ok(prep)
    assert.ok(!prep.markdown.includes('$'))
    const lines = prep.markdown.split('\n').filter((l) => l.trim())
    const out = prep.restore(lines.map((l) => P(l)))
    assert.deepEqual(out.map((b) => b.type), ['paragraph', 'math', 'paragraph'])
    assert.deepEqual(out[1].props, { latex: 'E = mc^2' })
    assert.equal(out[1].content, undefined)
  })

  it('$$x$$ as a whole line becomes a math block; multi-line source is kept verbatim', () => {
    assert.deepEqual(roundTrip('$$x^2$$').map((b) => [b.type, b.props]), [['math', { latex: 'x^2' }]])
    const out = roundTrip('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$')
    assert.equal(out[0].type, 'math')
    assert.equal(out[0].props.latex, '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}')
  })

  it('$…$ in a line becomes inlineMath between the text runs, styles kept', () => {
    const prep = prepareMarkdownPaste('줄 안 수식 $a^2 + b^2 = c^2$ 입니다.')
    const key = prep.markdown.slice('줄 안 수식 '.length, prep.markdown.length - ' 입니다.'.length)
    const out = prep.restore([P(`줄 안 수식 ${key} 입니다.`, { bold: true })])
    assert.deepEqual(out[0].content, [
      { type: 'text', text: '줄 안 수식 ', styles: { bold: true } },
      { type: 'inlineMath', props: { latex: 'a^2 + b^2 = c^2' } },
      { type: 'text', text: ' 입니다.', styles: { bold: true } },
    ])
  })

  it('a sentinel in code, a code block or a link comes back as its source', () => {
    const prep = prepareMarkdownPaste('a $x_1$ b')
    const key = prep.markdown.slice(2, -2)
    const out = prep.restore([
      { id: 'c', type: 'paragraph', content: [{ type: 'text', text: key, styles: { code: true } }], children: [] },
      { id: 'k', type: 'codeBlock', props: { language: 'text' }, content: [{ type: 'text', text: `    ${key}`, styles: {} }], children: [] },
      { id: 'l', type: 'paragraph', content: [{ type: 'link', href: 'https://e.x', content: [{ type: 'text', text: key, styles: {} }] }], children: [] },
    ])
    assert.equal(out[0].content[0].text, '$x_1$')
    assert.equal(out[1].content[0].text, '    $x_1$')
    assert.equal(out[2].content[0].content[0].text, '$x_1$')
  })

  it('table cells and nested children are restored', () => {
    const prep = prepareMarkdownPaste('| a |\n| --- |\n| $x$ |')
    const key = /Iq[a-z]+I\d+Q/.exec(prep.markdown)[0]
    const table = {
      id: 't',
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: [{ type: 'tableCell', props: {}, content: [{ type: 'text', text: key, styles: {} }] }] }] },
      children: [],
    }
    const item = { id: 'li', type: 'bulletListItem', content: [{ type: 'text', text: 'x', styles: {} }], children: [P(key)] }
    const out = prep.restore([table, item])
    assert.deepEqual(out[0].content.rows[0].cells[0].content, [{ type: 'inlineMath', props: { latex: 'x' } }])
    assert.deepEqual(out[1].children[0].content, [{ type: 'inlineMath', props: { latex: 'x' } }])
  })

  it('a sentinel anywhere else (autolink href, image props) comes back as its source', () => {
    const md = 'a $u$ b\n\n![그림 $x$](https://e.x/i.png)'
    const prep = prepareMarkdownPaste(md)
    const [k1, k2] = prep.markdown.match(/Iq[a-z]{12}I\d+Q/g)
    const nonce = k1.slice(0, 14)
    const href = `https://e.x/?q=${k1}`
    const out = prep.restore([
      { id: 'a', type: 'paragraph', content: [{ type: 'link', href, content: [{ type: 'text', text: href, styles: {} }] }], children: [] },
      { id: 'i', type: 'image', props: { url: 'https://e.x/i.png', caption: '', name: `그림 ${k2}` }, children: [] },
    ])
    assert.ok(!JSON.stringify(out).includes(nonce))
    assert.equal(out[0].content[0].href, 'https://e.x/?q=$u$')
    assert.equal(out[0].content[0].content[0].text, 'https://e.x/?q=$u$')
    assert.equal(out[1].props.name, '그림 $x$')
  })

  it('the sentinel never collides with the pasted text', () => {
    const prep = prepareMarkdownPaste('$a$ Iqabc')
    assert.ok(!/Iq[a-z]{12}/.test('$a$ Iqabc'))
    assert.match(prep.markdown, /^Iq[a-z]{12}I0Q Iqabc$/)
  })
})

describe('paste: callouts', () => {
  const quote = (content) => ({ id: 'q', type: 'quote', props: { textColor: 'default', backgroundColor: 'default' }, content, children: [] })

  it('> [!note] alone on its line: callout without an empty first line', () => {
    const prep = prepareMarkdownPaste('> [!note]\n> 콜아웃 본문입니다.')
    assert.ok(prep)
    const out = prep.restore([quote([{ type: 'text', text: '[!note]\n콜아웃 본문입니다.', styles: {} }])])
    assert.deepEqual(out[0], { id: 'q', type: 'callout', props: { type: 'note' }, content: [{ type: 'text', text: '콜아웃 본문입니다.', styles: {} }], children: [] })
  })

  it('> [!WARNING] title keeps the rest of the line; type is lower-cased', () => {
    const prep = prepareMarkdownPaste('> [!WARNING] 조심\n> 본문')
    const out = prep.restore([quote([{ type: 'text', text: '[!WARNING] 조심\n본문', styles: {} }])])
    assert.equal(out[0].type, 'callout')
    assert.equal(out[0].props.type, 'warning')
    assert.equal(out[0].content[0].text, '조심\n본문')
  })

  it('unknown types, styled markers and plain quotes stay quotes', () => {
    assert.equal(prepareMarkdownPaste('> [!question] 무엇?'), null)
    const prep = prepareMarkdownPaste('> [!tip] a')
    const styled = prep.restore([quote([{ type: 'text', text: '[!tip] a', styles: { bold: true } }])])
    assert.equal(styled[0].type, 'quote')
    const plain = prep.restore([quote([{ type: 'text', text: '그냥 인용', styles: {} }])])
    assert.equal(plain[0].type, 'quote')
  })

  it('a callout body with inline math gets both', () => {
    const prep = prepareMarkdownPaste('> [!info]\n> 값은 $x$')
    const key = /Iq[a-z]+I\d+Q/.exec(prep.markdown)[0]
    const out = prep.restore([quote([{ type: 'text', text: `[!info]\n값은 ${key}`, styles: {} }])])
    assert.equal(out[0].type, 'callout')
    assert.deepEqual(out[0].content, [
      { type: 'text', text: '값은 ', styles: {} },
      { type: 'inlineMath', props: { latex: 'x' } },
    ])
  })
})
