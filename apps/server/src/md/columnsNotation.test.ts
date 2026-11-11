// Columns in Markdown (docs/adr/2422-*) and the section rule (docs/adr/2424-*). Pure — no database.
//
// A `columnList` is written as comment markers around each column's blocks in every notation mode,
// reads back into the same structure (types, widths, text), reads as ordinary Markdown in order for a
// tool that does not know the markers, and broken marker input keeps every block. Headings inside a
// column are not section boundaries; patch_section on the section that holds the group keeps it, also
// when it is given find_context's text of that section.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { findSection, splitSections } from '../context/chunker'
import { scanInjection } from '../context/injectionScan'
import { applyDocumentReplace, applySectionPatch, buildEchoIndex, readBlocks } from '../context/sectionPatch'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stateToBlocks } from './convert'
import type { AnyBlock } from './convert'
import { getServerEditor } from './editor'
import { renderSyncMarkdown } from './syncMd'
import type { NotationMode } from './notation'

const noTitles = () => null
const t = (text: string) => [{ type: 'text', text, styles: {} }]
const p = (text: string): AnyBlock => ({ type: 'paragraph', content: t(text) })
const h = (level: number, text: string): AnyBlock => ({ type: 'heading', props: { level }, content: t(text) })
const col = (children: AnyBlock[], width?: number): AnyBlock => ({ type: 'column', props: width ? { width } : {}, children })
const cols = (...columns: AnyBlock[]): AnyBlock => ({ type: 'columnList', props: {}, children: columns })

async function md(blocks: AnyBlock[], notation: NotationMode = 'agent'): Promise<string> {
  return (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation })).markdown.trim()
}

/** Structure only: type, width, text, children (ids and default props left out). */
function shape(blocks: AnyBlock[]): unknown[] {
  return blocks.map((b) => {
    const text = Array.isArray(b.content) ? b.content.map((i) => String((i as { text?: string }).text ?? '')).join('') : undefined
    const out: Record<string, unknown> = { type: b.type }
    if (b.type === 'column') out.width = Number(b.props?.width ?? 1)
    if (b.type === 'heading') out.level = Number(b.props?.level)
    if (text !== undefined) out.text = text
    if (b.type === 'checkListItem') out.checked = !!b.props?.checked
    if (b.children?.length) out.children = shape(b.children)
    return out
  })
}

/** Through the Yjs state, as a stored page is read. */
function stored(blocks: AnyBlock[]): AnyBlock[] {
  return stateToBlocks(new Uint8Array(blocksToStateBuffer(blocks)))
}

const PAGE = (): AnyBlock[] => [
  h(2, 'Intro'),
  p('before'),
  cols(
    col([h(3, 'Left heading'), p('left text'), { type: 'checkListItem', props: { checked: true }, content: t('done item') }], 1.2),
    col([{ type: 'image', props: { url: 'https://example.com/a.png', caption: 'shot' } }, p('right text')], 0.8),
  ),
  p('after'),
  h(2, 'Next'),
  p('next body'),
]

describe('columns in Markdown (2422)', () => {
  it('writes markers in every mode, widths only when the columns differ', async () => {
    for (const mode of ['agent', 'plain', 'file'] as const) {
      const out = await md(stored(PAGE()), mode)
      assert.match(out, /^<!-- inkling:columns \{"widths":\[60,40\]\} -->$/m, mode)
      assert.equal(out.match(/^<!-- inkling:column -->$/gm)?.length, 2, mode)
      assert.match(out, /^<!-- \/inkling:columns -->$/m, mode)
    }
    const equal = await md(stored([cols(col([p('a')]), col([p('b')]), col([p('c')]))]))
    assert.equal(equal, '<!-- inkling:columns -->\n\n<!-- inkling:column -->\n\na\n\n<!-- inkling:column -->\n\nb\n\n<!-- inkling:column -->\n\nc\n\n<!-- /inkling:columns -->')
  })

  it('round-trips the structure, widths and text (doc → Markdown → doc → Markdown)', async () => {
    const doc = stored(PAGE())
    const first = await md(doc)
    const back = stored(await markdownToBlocks(first, noTitles))
    assert.deepEqual(shape(back), shape(doc))
    assert.equal(await md(back), first)
    // plain (vault sync, templates, zip export) round-trips too
    const plain = await md(doc, 'plain')
    assert.deepEqual(shape(stored(await markdownToBlocks(plain, noTitles))), shape(doc))
  })

  it('reads in order as ordinary Markdown for a tool that does not know the markers', async () => {
    const out = await md(stored(PAGE()), 'plain')
    const visible = out.replace(/^<!--.*-->$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    const order = ['before', 'Left heading', 'left text', 'done item', 'shot', 'right text', 'after']
    let at = -1
    for (const w of order) {
      const i = visible.indexOf(w)
      assert.ok(i > at, `${w} after the previous one`)
      at = i
    }
    // a parser that drops the comments sees the same blocks, flattened
    const flat = await getServerEditor().tryParseMarkdownToBlocks(visible)
    assert.ok(flat.length >= 8)
  })

  it('vault sync writes the markers and its Markdown reads back as the same group', async () => {
    const doc = stored(PAGE())
    const md = await renderSyncMarkdown({ id: '6f1c2a10-1111-4c3b-9a55-0123456789ab', properties: {}, aliases: [] }, doc)
    assert.match(md, /<!-- inkling:columns \{"widths":\[60,40\]\} -->/)
    const body = md.replace(/^---[\s\S]*?---\n/, '')
    assert.deepEqual(shape(stored(await markdownToBlocks(body, noTitles))), shape(doc))
  })

  it('an empty column reads back with an empty paragraph', async () => {
    const back = await markdownToBlocks('<!-- inkling:columns -->\n<!-- inkling:column -->\nleft\n<!-- inkling:column -->\n<!-- /inkling:columns -->', noTitles)
    assert.deepEqual(shape(stored(back)), [{ type: 'columnList', children: [{ type: 'column', width: 1, children: [{ type: 'paragraph', text: 'left' }] }, { type: 'column', width: 1, children: [{ type: 'paragraph', text: '' }] }] }])
  })

  const BROKEN: [string, string][] = [
    ['no close', '<!-- inkling:columns -->\n<!-- inkling:column -->\na\n<!-- inkling:column -->\nb'],
    ['close only', 'a\n<!-- /inkling:columns -->\nb'],
    ['stray column markers', 'a\n<!-- inkling:column -->\nb\n<!-- inkling:column -->'],
    ['one column', '<!-- inkling:columns -->\n<!-- inkling:column -->\na\nb\n<!-- /inkling:columns -->'],
    ['five columns', `<!-- inkling:columns -->\n${['a', 'b', 'c', 'd', 'e'].map((x) => `<!-- inkling:column -->\n${x}`).join('\n')}\n<!-- /inkling:columns -->`],
    ['blocks before the first column', '<!-- inkling:columns -->\na\n<!-- inkling:column -->\nb\n<!-- inkling:column -->\nc\n<!-- /inkling:columns -->'],
    [
      'nested groups',
      '<!-- inkling:columns -->\n<!-- inkling:column -->\na\n<!-- inkling:columns -->\n<!-- inkling:column -->\nb\n<!-- inkling:column -->\nc\n<!-- /inkling:columns -->\n<!-- inkling:column -->\nd\n<!-- /inkling:columns -->',
    ],
    ['markers inside a list item', '- a\n  <!-- inkling:columns -->\n  <!-- inkling:column -->\n  b\n  <!-- inkling:column -->\n  c\n  <!-- /inkling:columns -->'],
    ['markers in a quote', '> <!-- inkling:columns -->\n> <!-- inkling:column -->\n> b\n> <!-- inkling:column -->\n> c\n> <!-- /inkling:columns -->'],
    ['close with props, column with props', '<!-- inkling:columns -->\n<!-- inkling:column {"x":1} -->\na\n<!-- inkling:column -->\nb\n<!-- /inkling:columns {"y":1} -->'],
  ]
  for (const [name, input] of BROKEN) {
    it(`broken markers keep every block and make no columns: ${name}`, async () => {
      const blocks = stored(await markdownToBlocks(input, noTitles))
      const json = JSON.stringify(blocks)
      assert.ok(!json.includes('"columnList"'), 'no group')
      const texts: string[] = []
      const collect = (bs: AnyBlock[]) => bs.forEach((b) => (Array.isArray(b.content) && texts.push(...b.content.map((i) => String((i as { text?: string }).text ?? ''))), collect(b.children ?? [])))
      collect(blocks)
      const all = texts.join('\n')
      for (const w of ['a', 'b', 'c', 'd', 'e']) if (new RegExp(`\\b${w}\\b`).test(input.replace(/<!--.*?-->/g, ''))) assert.match(all, new RegExp(`\\b${w}\\b`), `kept ${w}`)
      // no sentinel or marker text left in the blocks
      assert.ok(!/Nq[a-z]+B\d+Q|inkling:/.test(json), 'no marker left')
    })
  }

  it('widths that do not fit the columns are ignored (equal columns)', async () => {
    for (const json of ['{"widths":[70]}', '{"widths":[50,"x"]}', '{"widths":[0,100]}', '{"w":1}', 'not json']) {
      const back = stored(await markdownToBlocks(`<!-- inkling:columns ${json} -->\n<!-- inkling:column -->\na\n<!-- inkling:column -->\nb\n<!-- /inkling:columns -->`, noTitles))
      if (json === 'not json') {
        assert.ok(!JSON.stringify(back).includes('columnList'), json)
        continue
      }
      assert.deepEqual(
        back[0].children?.map((c) => Number(c.props?.width)),
        [1, 1],
        json,
      )
    }
  })
})

describe('headings inside columns are not sections (2424)', () => {
  it('splitSections sees only top-level headings; the group belongs to the section around it', async () => {
    const blocks = stored(PAGE())
    const sections = splitSections(blocks)
    assert.deepEqual(
      sections.map((s) => s.anchor),
      ['intro', 'next'],
    )
    assert.equal(findSection(sections, 'Left heading'), null)
    const intro = findSection(sections, 'intro')!
    assert.equal(blocks.slice(intro.start, intro.end).some((b) => b.type === 'columnList'), true)
  })

  // context/sectionPatch.ts takes a top-level group of columns as one unit: kept when the agent left it
  // alone, replaced whole when anything inside it changed (docs/adr/2424-*).
  it('patch_section on the section holding the group keeps the group (unchanged or edited inside)', async () => {
    const doc = getServerEditor().blocksToYDoc(stored(PAGE()) as never, 'document')
    const current = readBlocks(doc)
    const s = findSection(splitSections(current), 'intro')!
    const sectionMd = await md(current.slice(s.start, s.end))
    const echo = await buildEchoIndex(current.slice(s.start, s.end), noTitles, {})
    assert.throws(() => applySectionPatch(doc, 'intro', [], 'replace', undefined, echo), /markdown is empty/)
    // the section as read, given back: nothing changes, the group keeps its id
    const groupId = current.find((b) => b.type === 'columnList')!.id
    const same = applySectionPatch(doc, 'intro', await markdownToBlocks(sectionMd, noTitles), 'replace', undefined, echo)
    assert.equal(same.status, 'ok')
    assert.deepEqual(shape(readBlocks(doc)), shape(current))
    assert.equal(readBlocks(doc).find((b) => b.type === 'columnList')!.id, groupId)
    // text inside a column edited: the group is replaced whole, same structure and widths
    const out = applySectionPatch(doc, 'intro', await markdownToBlocks(sectionMd.replace('left text', 'left text edited'), noTitles), 'replace', undefined, echo)
    assert.equal(out.status, 'ok')
    const after = readBlocks(doc)
    assert.deepEqual(shape(after), shape(current).map((b) => (JSON.stringify(b).includes('left text') ? JSON.parse(JSON.stringify(b).replace('left text', 'left text edited')) : b)))
    assert.equal(after.filter((b) => b.type === 'columnList').length, 1)
  })

  it('an edit inside a column is applied when the echo index also sees the new blocks (the routes pass them)', async () => {
    const doc = getServerEditor().blocksToYDoc(stored(PAGE()) as never, 'document')
    const current = readBlocks(doc)
    const s = findSection(splitSections(current), 'intro')!
    const sectionMd = await md(current.slice(s.start, s.end))
    const incoming = await markdownToBlocks(sectionMd.replace('right text', 'right text edited'), noTitles)
    const echo = await buildEchoIndex(current.slice(s.start, s.end), noTitles, {}, incoming)
    assert.equal(applySectionPatch(doc, 'intro', incoming, 'replace', undefined, echo).status, 'ok')
    const group = readBlocks(doc).find((b) => b.type === 'columnList')!
    assert.match(JSON.stringify(group), /right text edited/)
    // the blocks around the group were left alone: same ids
    assert.deepEqual(readBlocks(doc).filter((b) => b.type !== 'columnList').map((b) => b.id), current.filter((b) => b.type !== 'columnList').map((b) => b.id))
  })

  it('an edit to a nested block inside a column is applied (the group key covers every depth)', async () => {
    const page: AnyBlock[] = [
      h(2, 'Intro'),
      cols(col([{ type: 'bulletListItem', content: t('parent item'), children: [{ type: 'bulletListItem', content: t('nested item') }] }]), col([p('right')])),
    ]
    const doc = getServerEditor().blocksToYDoc(stored(page) as never, 'document')
    const current = readBlocks(doc)
    const s = findSection(splitSections(current), 'intro')!
    const sectionMd = await md(current.slice(s.start, s.end))
    assert.match(sectionMd, /nested item/)
    const incoming = await markdownToBlocks(sectionMd.replace('nested item', 'nested item edited'), noTitles)
    const echo = await buildEchoIndex(current.slice(s.start, s.end), noTitles, {}, incoming)
    assert.equal(applySectionPatch(doc, 'intro', incoming, 'replace', undefined, echo).status, 'ok')
    assert.match(JSON.stringify(readBlocks(doc)), /nested item edited/)
  })

  it("find_context's section text given back to patch_section keeps the group (markers, no indent)", async () => {
    const doc = getServerEditor().blocksToYDoc(stored(PAGE()) as never, 'document')
    const current = readBlocks(doc)
    const intro = splitSections(current).find((x) => x.anchor === 'intro')!
    assert.match(intro.text, /^<!-- inkling:columns \{"widths":\[60,40\]\} -->$/m)
    assert.match(intro.text, /^<!-- inkling:column -->\n### Left heading$/m)
    assert.match(intro.text, /^left text$/m)
    assert.match(intro.text, /^<!-- \/inkling:columns -->$/m)
    assert.doesNotMatch(intro.text, /^ +\S/m)
    // the marker comments are not taken for hidden instructions (docs/adr/0977-*)
    assert.deepEqual(scanInjection(intro.text), [])
    const echo = await buildEchoIndex(current.slice(intro.start, intro.end), noTitles, {})
    const out = applySectionPatch(doc, 'intro', await markdownToBlocks(`## Intro\n\n${intro.text.replace('left text', 'left text 2')}`, noTitles), 'replace', undefined, echo)
    assert.equal(out.status, 'ok')
    const group = readBlocks(doc).find((b) => b.type === 'columnList')!
    assert.ok(group, 'group kept')
    assert.deepEqual(group.children!.map((c) => Number(c.props?.width)), [1.2, 0.8])
    assert.match(JSON.stringify(group), /left text 2/)
    assert.match(JSON.stringify(group), /Left heading/)
  })

  it('patch_section on a section next to the group keeps the group', async () => {
    const doc = getServerEditor().blocksToYDoc(stored(PAGE()) as never, 'document')
    const current = readBlocks(doc)
    const group = JSON.stringify(current.find((b) => b.type === 'columnList'))
    const s = findSection(splitSections(current), 'next')!
    const echo = await buildEchoIndex(current.slice(s.start, s.end), noTitles, {})
    const out = applySectionPatch(doc, 'next', await markdownToBlocks('## Next\n\nnext body edited', noTitles), 'replace', undefined, echo)
    assert.equal(out.status, 'ok')
    const after = readBlocks(doc)
    assert.equal(JSON.stringify(after.find((b) => b.type === 'columnList')), group)
    assert.match(JSON.stringify(after), /next body edited/)
  })

  it('the minimal update_page replace keeps a group and the blocks around it', async () => {
    const doc = getServerEditor().blocksToYDoc(stored(PAGE()) as never, 'document')
    const current = readBlocks(doc)
    const full = await md(current)
    const incoming = await markdownToBlocks(full.replace('right text', 'right text 2'), noTitles)
    assert.equal(incoming.filter((b) => b.type === 'columnList').length, 1)
    const keptIds = current.filter((b) => b.type !== 'columnList').map((b) => b.id)
    applyDocumentReplace(doc, incoming, null)
    const after = readBlocks(doc)
    assert.equal(after.filter((b) => b.type === 'columnList').length, 1)
    assert.match(JSON.stringify(after.find((b) => b.type === 'columnList')), /right text 2/)
    assert.deepEqual(after.filter((b) => b.type !== 'columnList').map((b) => b.id), keptIds)
  })

  it('Yjs: a page with columns reads back unchanged on the server', () => {
    const doc = new Y.Doc()
    getServerEditor().blocksToYXmlFragment(PAGE() as never, doc.getXmlFragment('document') as never)
    const before = doc.getXmlFragment('document').toString()
    readBlocks(doc)
    assert.equal(doc.getXmlFragment('document').toString(), before)
    assert.match(before, /<columnlist[^>]*><column[^>]*width="1.2"/)
  })
})
