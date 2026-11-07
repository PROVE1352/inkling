// Math nodes on the server (docs/adr/0995-*, 0996-*): schema registration, Markdown round trip,
// public HTML and section patches. Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { checkLatexSource, scanInlineMath } from '@inkling/shared'
import { blocksToFullHTML, blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stateToBlocks } from './convert'
import type { AnyBlock } from './convert'
import { getServerEditor } from './editor'
import { preprocessNotionMarkdown } from './notionParse'
import { findSection, splitSections } from '../context/chunker'
import { applySectionPatch, buildEchoIndex, readBlocks } from '../context/sectionPatch'

const noTitles = () => null
const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text: t, styles })
const inline = (latex: string) => ({ type: 'inlineMath', props: { latex } })
const toMd = async (blocks: AnyBlock[]) => (await blocksToMarkdown(blocks, { assetMode: 'absolute' })).markdown
const shape = (blocks: AnyBlock[]): unknown =>
  blocks.map((b) => ({
    type: b.type,
    ...(b.type === 'math' ? { latex: b.props?.latex } : {}),
    ...(Array.isArray(b.content)
      ? {
          content: b.content.map((c) =>
            c.type === 'text' ? [c.text, (c as { styles?: object }).styles ?? {}] : { type: c.type, props: (c as { props?: unknown }).props },
          ),
        }
      : {}),
    ...(b.children?.length ? { children: shape(b.children) } : {}),
  }))

describe('math: $…$ rule (shared)', () => {
  it('follows pandoc: prices are not math, escaped dollars never delimit', () => {
    const latex = (s: string) => scanInlineMath(s).map((m) => m.latex)
    assert.deepEqual(latex('Let $a_1 + b$ be'), ['a_1 + b'])
    assert.deepEqual(latex('prices $5 and $10 stay'), [])
    assert.deepEqual(latex('$5,$10'), [])
    assert.deepEqual(latex('from $5 to $10 and $x$'), ['x'])
    assert.deepEqual(latex('a $ b $ c'), [])
    assert.deepEqual(latex('\\$x\\$ and $y\\$z$'), ['y\\$z'])
    assert.deepEqual(latex('inline $$x^2$$ too'), ['x^2'])
    assert.deepEqual(latex('no $line\nbreak$'), [])
  })
  it('refuses macro definitions, links and HTML commands before rendering', () => {
    for (const src of ['\\def\\x{1}', '\\gdef\\a{b}', '\\newcommand{\\f}{x}', '\\renewcommand\\sqrt{x}', '\\let\\a\\b',
      '\\href{javascript:alert(1)}{x}', '\\url{https://e.x}', '\\includegraphics{a.png}', '\\htmlClass{x}{y}',
      '\\htmlStyle{color:red}{y}', '\\htmlId{i}{y}', '\\htmlData{a=b}{y}', '\\global\\def\\x{}']) {
      assert.equal(checkLatexSource(src)?.code, 'blocked', src)
    }
    for (const src of ['\\left( x \\right)', '\\definecolor', '\\urlx', '\\frac{a}{b}', '\\letter']) {
      assert.equal(checkLatexSource(src), null, src)
    }
    assert.equal(checkLatexSource('x'.repeat(4_001))?.code, 'tooLong')
  })
})

describe('math: server schema', () => {
  const blocks = [
    { type: 'math', props: { latex: 'E = mc^2' } },
    { type: 'paragraph', content: [text('a '), inline('x^2'), text(' b')] },
  ] as AnyBlock[]

  it('keeps math through a Yjs round trip', () => {
    const back = stateToBlocks(blocksToStateBuffer(blocks))
    assert.deepEqual(shape(back), [
      { type: 'math', latex: 'E = mc^2' },
      { type: 'paragraph', content: [['a ', {}], inline('x^2'), [' b', {}]] },
    ])
  })

  it('reading a live doc does not delete math nodes (a schema without them does)', () => {
    const editor = getServerEditor()
    const live = editor.blocksToYDoc(blocks as never, 'document')
    const before = Y.encodeStateVector(live)
    // read the live doc directly, the destructive path of ADR 0940
    editor.yDocToBlocks(live, 'document')
    editor.yDocToBlocks(live, 'document')
    assert.deepEqual(Y.encodeStateVector(live), before, 'no Yjs change from reading')
    assert.deepEqual(shape(stateToBlocks(Y.encodeStateAsUpdate(live))), shape(blocks))

    // control: BlockNote's default schema deletes them (why the registration matters)
    const plain = ServerBlockNoteEditor.create()
    const other = editor.blocksToYDoc(blocks as never, 'document')
    plain.yDocToBlocks(other, 'document')
    const after = stateToBlocks(Y.encodeStateAsUpdate(other))
    assert.equal(after.some((b) => b.type === 'math'), false)
    assert.doesNotMatch(JSON.stringify(after), /inlineMath/)
  })

  it('public HTML carries the source in data-latex and as text, never a <math> element', async () => {
    const html = await blocksToFullHTML([
      ...blocks,
      { type: 'math', props: { latex: '<img src=x onerror=alert(1)> & "q"' } },
    ] as AnyBlock[])
    assert.match(html, /data-content-type="math" data-latex="E = mc\^2"/)
    assert.match(html, /<div class="nd-math-source">E = mc\^2<\/div>/)
    assert.match(html, /<span class="nd-math-inline-source" data-inline-content-type="inlineMath" data-latex="x\^2">x\^2<\/span>/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; "q"/)
    assert.doesNotMatch(html.replace(/"[^"]*"/g, ""), /<img|<math/, "no element besides attribute text")
  })
})

describe('math: Markdown round trip', () => {
  const doc: AnyBlock[] = [
    { type: 'heading', props: { level: 2 }, content: [text('Energy')] },
    { type: 'math', props: { latex: 'E = mc^2\n\\alpha_1 * b_{2} \\\\ [x]' } },
    { type: 'paragraph', content: [text('Let '), inline('a_1 * b_2'), text(' cost '), text('$5', { bold: true })] },
    { type: 'paragraph', content: [text('prices $5 and $10 stay')] },
    { type: 'paragraph', content: [text('literal $a$ and $$ here')] },
    { type: 'quote', content: [text('q '), inline('\\sqrt{q}')] },
    {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: [[text('a')], [inline('|x| + \\|y\\|')]] },
          { cells: [[text('b')], [text('c')]] },
        ],
      },
    },
    { type: 'codeBlock', props: { language: 'js' }, content: [text('const p = "$5 and $x$"')] },
    { type: 'paragraph', content: [text('code '), text('$x$', { code: true }), text(' stays')] },
  ] as AnyBlock[]

  it('writes $$ blocks and $ spans, escapes only dollars that would become math', async () => {
    const md = await toMd(doc)
    assert.match(md, /^\$\$\nE = mc\^2\n\\alpha_1 \* b_\{2\} \\\\ \[x\]\n\$\$$/m)
    assert.match(md, /^Let \$a_1 \* b_2\$ cost \*\*\\\$5\*\*$/m)
    assert.match(md, /^prices \$5 and \$10 stay$/m)
    assert.match(md, /^literal \\\$a\\\$ and \\\$\\\$ here$/m)
    assert.match(md, /^> q \$\\sqrt\{q\}\$$/m)
    assert.match(md, /\| \$\\vert x\\vert  \+ \\Vert y\\Vert\$ \|/)
    assert.match(md, /^const p = "\$5 and \$x\$"$/m)
    assert.match(md, /^code `\$x\$` stays$/m)
  })

  it('reads its own output back to the same nodes, and the second export is identical', async () => {
    const md = await toMd(doc)
    const back = await markdownToBlocks(md, noTitles)
    const s = shape(back) as { type: string; latex?: string; content?: unknown[] }[]
    assert.equal(s[1].latex, 'E = mc^2\n\\alpha_1 * b_{2} \\\\ [x]')
    assert.deepEqual(s[2].content, [['Let ', {}], inline('a_1 * b_2'), [' cost ', {}], ['$5', { bold: true }]])
    assert.deepEqual(s[3].content, [['prices $5 and $10 stay', {}]])
    assert.deepEqual(s[4].content, [['literal $a$ and $$ here', {}]])
    assert.deepEqual(s[5].content, [['q ', {}], inline('\\sqrt{q}')])
    assert.equal(s[7].type, 'codeBlock')
    assert.deepEqual(s[8].content, [['code ', {}], ['$x$', { code: true }], [' stays', {}]])
    assert.equal(await toMd(back), md)
  })

  it('imports hand-written math: one-line $$, indented $$ in a list, unclosed delimiters', async () => {
    const md = [
      '$$\\int_0^1 x\\,dx$$',
      '',
      '* item',
      '  $$',
      '  a_1',
      '  $$',
      '',
      'Costs $5. A lone $$ stays, \\$x\\$ too, and `$y$` is code.',
      '',
      '```latex',
      '\\frac{1}{2}',
      '```',
    ].join('\n')
    const s = shape(await markdownToBlocks(md, noTitles)) as { type: string; latex?: string; content?: unknown[]; children?: unknown[] }[]
    assert.deepEqual(s[0], { type: 'math', latex: '\\int_0^1 x\\,dx' })
    assert.equal(s[1].type, 'bulletListItem')
    assert.deepEqual(s[1].children, [{ type: 'math', latex: 'a_1' }])
    assert.deepEqual(s[2].content, [['Costs $5. A lone $$ stays, $x$ too, and ', {}], ['$y$', { code: true }], [' is code.', {}]])
    assert.equal(s[3].type, 'codeBlock', 'a latex code block in a plain Markdown import stays code')
  })

  it('Notion: $$ and latex fences become math blocks, inline $x$ inline math, prices stay text', async () => {
    const pre = preprocessNotionMarkdown('$$\nE = mc^2\n$$\n\nInline math $a_1 + b$ here, prices $5 and $10 stay.\n\n```latex\nx^2\n```\n')
    const s = shape(await markdownToBlocks(pre.md, noTitles)) as { type: string; latex?: string; content?: unknown[] }[]
    assert.deepEqual(s[0], { type: 'math', latex: 'E = mc^2' })
    assert.deepEqual(s[1].content, [['Inline math ', {}], inline('a_1 + b'), [' here, prices $5 and $10 stay.', {}]])
    assert.deepEqual(s[2], { type: 'math', latex: 'x^2' })
    assert.equal(pre.stats.equations, 3)
  })
})

describe('math: patch_section', () => {
  async function docFrom(md: string): Promise<Y.Doc> {
    const blocks = await markdownToBlocks(md, noTitles)
    return getServerEditor().blocksToYDoc(blocks as never, 'document')
  }
  async function patch(doc: Y.Doc, ref: string, md: string) {
    const incoming = await markdownToBlocks(md, noTitles)
    const current = readBlocks(doc)
    const s = findSection(splitSections(current), ref)
    const echo = s ? await buildEchoIndex(current.slice(s.start, s.end), noTitles) : null
    const out = applySectionPatch(doc, ref, incoming, 'replace', undefined, echo)
    assert.equal(out.status, 'ok')
  }
  const page = '## A\n\nLet $x_1$ be\n\n$$\n\\sum_i a_i\n$$\n\n## B\n\nOther $y$ here\n\n$$\nb\n$$\n'

  it('a no-op patch over a section with math writes nothing', async () => {
    const doc = await docFrom(page)
    const a = (await toMd(readBlocks(doc))).split('## B')[0].trim()
    let updates = 0
    doc.on('update', () => updates++)
    await patch(doc, 'A', a)
    assert.equal(updates, 0)
  })

  it('edits latex in place and keeps math in the other section', async () => {
    const doc = await docFrom(page)
    await patch(doc, 'A', '## A\n\nLet $x_2$ be\n\n$$\n\\sum_j a_j\n$$')
    const md = await toMd(readBlocks(doc))
    assert.match(md, /Let \$x_2\$ be/)
    assert.match(md, /\$\$\n\\sum_j a_j\n\$\$/)
    assert.match(md, /Other \$y\$ here/)
    assert.match(md, /\$\$\nb\n\$\$/)
  })
})
