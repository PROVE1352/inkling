// Round trip of everything Markdown cannot say on its own (docs/adr/1500-*): read_page's Markdown
// carries a notation for callouts, page/link embeds, plugin blocks and mentions, and patch_section /
// update_page turn it back into the original nodes. Pure — no database, no server.
//
// Every element kind × (sent back as read / text around it edited / its notation deleted / its host
// block retyped / update_page replace with the page as read / element in another section) is checked
// on the Yjs document itself: the element's XML (node name + attributes) must be there afterwards, or
// gone after a delete. `CENSUS=1` prints the table without asserting (used for the before column).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { findSection, splitSections } from './chunker'
import { blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { applyDocumentReplace, applySectionPatch, buildEchoIndex, readBlocks } from './sectionPatch'

const editor = getServerEditor()
const noTitles = () => null
const CENSUS = process.env.CENSUS === '1'

const PAGE_ID = '6f1c2a10-1111-4c3b-9a55-0123456789ab'
const USER_ID = '0b9d8e7f-2222-4a1b-8c3d-abcdef012345'
const GRANT_ID = '7a6b5c4d-3333-4e2f-9a1b-fedcba987654'

/** What patch_section / update_page pass: the mention chips already in the page may be written back. */
function parseOpts(doc: Y.Doc) {
  return { mentions: existingMentions(doc) }
}

function existingMentions(doc: Y.Doc): Set<string> {
  const out = new Set<string>()
  const walk = (n: Y.XmlElement | Y.XmlFragment) => {
    for (const c of n.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'mention') out.add(`${String(c.getAttribute('kind') ?? 'user')}:${String(c.getAttribute('id') ?? '')}`)
      walk(c)
    }
  }
  walk(doc.getXmlFragment('document'))
  return out
}

const agentMd = async (blocks: AnyBlock[]) =>
  (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation: 'agent' })).markdown.trim()

async function docFromMarkdown(md: string): Promise<Y.Doc> {
  return editor.blocksToYDoc((await markdownToBlocks(md, noTitles)) as never, 'document')
}

function topGroup(doc: Y.Doc): Y.XmlElement {
  return doc.getXmlFragment('document').get(0) as Y.XmlElement
}

function containerByText(doc: Y.Doc, needle: string): Y.XmlElement {
  for (const c of topGroup(doc).toArray()) {
    if (c instanceof Y.XmlElement && c.toString().includes(needle)) return c
  }
  throw new Error(`no container with ${needle}`)
}

const xml = (doc: Y.Doc) => doc.getXmlFragment('document').toString()

// ---------------------------------------------------------------------------
// elements, built the way the web editor stores them
// ---------------------------------------------------------------------------

type Place = 'block' | 'inline' | 'heading'
interface Element {
  name: string
  place: Place
  /** Adds the element to the container (block: after it; inline: inside its paragraph). */
  add(doc: Y.Doc, container: Y.XmlElement): void
  /** Proof in the document XML that the element is there with its attributes. */
  sig: RegExp
  /** The element's notation in read_page Markdown (to delete it; null = Markdown shows nothing of it). */
  token: RegExp | null
}

function blockFromYjs(doc: Y.Doc, after: Y.XmlElement, node: Y.XmlElement): void {
  const bc = new Y.XmlElement('blockContainer')
  bc.setAttribute('id', `el-${Math.random().toString(36).slice(2, 10)}`)
  bc.insert(0, [node])
  topGroup(doc).insertAfter(after, [bc])
}

/** A web-only block (hand-built like y-prosemirror writes it). */
function webBlock(nodeName: string, attrs: Record<string, string>, text?: string) {
  return (doc: Y.Doc, after: Y.XmlElement) => {
    const el = new Y.XmlElement(nodeName)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    if (text !== undefined) {
      const t = new Y.XmlText()
      el.insert(0, [t])
      t.insert(0, text)
    }
    blockFromYjs(doc, after, el)
  }
}

/** A block the server schema knows, built by BlockNote (all attributes as the editor writes them). */
function knownBlock(block: Record<string, unknown>) {
  return (doc: Y.Doc, after: Y.XmlElement) => {
    const tmp = editor.blocksToYDoc([block] as never, 'document')
    const c = (topGroup(tmp).get(0) as Y.XmlElement).clone()
    topGroup(doc).insertAfter(after, [c])
    tmp.destroy()
  }
}

/** Inline element in the middle of the container's first text run ("Beta |text here."). */
function inlineEl(nodeName: string, attrs: Record<string, string>) {
  return (_doc: Y.Doc, container: Y.XmlElement) => {
    const content = container.get(0) as Y.XmlElement
    const seg = content.get(0) as Y.XmlText
    const at = 5
    // split the run at `at`, keeping the formatting of the tail
    const tail: { insert: string; attributes?: Record<string, unknown> }[] = []
    let pos = 0
    for (const d of seg.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]) {
      const from = Math.max(0, at - pos)
      if (from < d.insert.length) tail.push({ ...d, insert: d.insert.slice(from) })
      pos += d.insert.length
    }
    seg.delete(at, seg.length - at)
    const el = new Y.XmlElement(nodeName)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    const t = new Y.XmlText()
    content.insertAfter(seg, [el, t])
    t.applyDelta(tail)
  }
}

function mark(attrs: Record<string, unknown>) {
  return (_doc: Y.Doc, container: Y.XmlElement) => {
    const seg = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText
    seg.format(5, 4, attrs)
  }
}

function blockProp(attrs: Record<string, string>) {
  return (_doc: Y.Doc, container: Y.XmlElement) => {
    for (const [k, v] of Object.entries(attrs)) (container.get(0) as Y.XmlElement).setAttribute(k, v)
  }
}

const ELEMENTS: Element[] = [
  {
    name: 'callout',
    place: 'block',
    add: webBlock('callout', { type: 'warning' }, 'Careful here'),
    sig: /<callout type="warning">Careful here<\/callout>/i,
    token: /^> \[!warning\].*$/m,
  },
  {
    name: 'page embed',
    place: 'block',
    add: webBlock('pageEmbed', { pageId: PAGE_ID }),
    sig: new RegExp(`<pageEmbed pageId="${PAGE_ID}">`, 'i'),
    token: /^<!-- inkling:pageEmbed .* -->$/m,
  },
  {
    name: 'link embed',
    place: 'block',
    add: webBlock('linkEmbed', { url: 'https://www.youtube.com/watch?v=abc', display: 'card' }),
    sig: /<linkEmbed display="card" url="https:\/\/www.youtube.com\/watch\?v=abc">/i,
    token: /^<!-- inkling:linkEmbed .* -->$/m,
  },
  {
    name: 'plugin block',
    place: 'block',
    add: webBlock('pluginBlock', { pluginId: 'kanban', blockType: 'board', data: '{"cols":["a","b--c"],"x":"-->"}' }),
    sig: /<pluginBlock blockType="board" data="[^\n]*b--c[^\n]*" pluginId="kanban">/i,
    token: /^<!-- inkling:pluginBlock .* -->$/m,
  },
  {
    name: 'chart block',
    place: 'block',
    add: webBlock('chart', {
      config: JSON.stringify({
        groupBy: { field: 'f1' },
        kind: 'bar',
        source: { collectionId: PAGE_ID, type: 'collection' },
        title: 'By status -- open',
      }),
    }),
    sig: /<chart config="[^\n]*groupBy[^\n]*By status -- open[^\n]*">/i,
    token: /^<!-- inkling:chart \{.*\} -->$/m,
  },
  {
    name: 'math block',
    place: 'block',
    add: knownBlock({ type: 'math', props: { latex: 'E = mc^2' } }),
    sig: /<math latex="E = mc\^2">/i,
    token: /^\$\$\n[^]*?\n\$\$$/m,
  },
  {
    name: 'toggle list item',
    place: 'block',
    add: knownBlock({ type: 'toggleListItem', content: 'Toggle item' }),
    sig: /<toggleListItem[^>]*>Toggle item</i,
    token: /^\* Toggle item$/m,
  },
  {
    name: 'toggle heading',
    place: 'heading',
    add: blockProp({ isToggleable: 'true' }),
    sig: /<heading [^>]*isToggleable="true"[^>]*>[ST]</i,
    token: null,
  },
  {
    name: 'query block (```dataview)',
    place: 'block',
    add: knownBlock({ type: 'codeBlock', props: { language: 'dataview' }, content: 'LIST FROM #x' }),
    sig: /<codeBlock language="dataview">LIST FROM #x</i,
    token: /^```dataview\n[^]*?\n```$/m,
  },
  {
    name: 'image caption/width/preview',
    place: 'block',
    add: knownBlock({ type: 'image', props: { url: 'https://x.test/a.png', name: 'a.png', caption: 'Cap one', previewWidth: 320, showPreview: true } }),
    sig: /<image [^>]*caption="Cap one"[^>]*previewWidth="320"/i,
    token: /^(<figure><img [^\n]*<\/figure>|!\[[^\]]*\]\(https:\/\/x\.test\/a\.png\)|<!-- inkling:image .* -->)$/m,
  },
  {
    name: 'file name/caption',
    place: 'block',
    add: knownBlock({ type: 'file', props: { url: '/files/0b9d8e7f-3333-4a1b-8c3d-abcdef012345', name: 'report.pdf', caption: 'Q3 report' } }),
    sig: /<file [^>]*caption="Q3 report"[^>]*name="report.pdf"/i,
    token: /^(\[report\.pdf\]\(\/files\/[^)]*\)(\n\nQ3 report)?|<!-- inkling:file .* -->)$/m,
  },
  {
    name: 'audio name/caption',
    place: 'block',
    add: knownBlock({ type: 'audio', props: { url: 'https://x.test/a.mp3', name: 'talk.mp3', caption: 'Talk' } }),
    sig: /<audio [^>]*caption="Talk"[^>]*name="talk.mp3"/i,
    token: /^(<figure><audio [^\n]*<\/figure>|<!-- inkling:audio .* -->)$/m,
  },
  {
    name: 'checkbox checked + date',
    place: 'block',
    add: knownBlock({ type: 'checkListItem', props: { checked: true }, content: 'Ship it 📅 2026-11-20' }),
    sig: /<checkListItem [^>]*checked="true"[^>]*>Ship it 📅 2026-11-20</i,
    token: /^\* \[x\] Ship it.*$/m,
  },
  {
    name: 'table cell color/alignment',
    place: 'block',
    add: knownBlock({
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: [{ type: 'tableCell', props: { backgroundColor: 'red', textAlignment: 'right' }, content: [{ type: 'text', text: 'cell', styles: {} }] }] }] },
    }),
    sig: /<tableCell backgroundColor="red"[^>]*textAlignment="right"/i,
    token: /^\|[^]*?\| cell +\|$/m,
  },
  {
    name: 'numbered list start=5',
    place: 'block',
    add: knownBlock({ type: 'numberedListItem', props: { start: 5 }, content: 'Fifth' }),
    sig: /<numberedListItem [^>]*start="5"[^>]*>Fifth</i,
    token: /^5\. Fifth$/m,
  },
  {
    name: 'block color/alignment',
    place: 'inline',
    add: blockProp({ textColor: 'red', backgroundColor: 'yellow', textAlignment: 'center' }),
    sig: /<(paragraph|bulletListItem) backgroundColor="yellow" textAlignment="center" textColor="red">Beta/i,
    token: null,
  },
  {
    name: 'mention',
    place: 'inline',
    add: inlineEl('mention', { kind: 'user', id: USER_ID, label: 'Kim' }),
    sig: new RegExp(`<mention id="${USER_ID}" kind="user" label="Kim">`, 'i'),
    token: /@\[Kim\]\(user:[^)]*\)/,
  },
  {
    // a person's agent connection (docs/adr/1861-*): same chip, kind 'agent', id `<person>/grant:<id>`
    name: 'agent mention',
    place: 'inline',
    add: inlineEl('mention', { kind: 'agent', id: `${USER_ID}/grant:${GRANT_ID}`, label: 'Kim · Claude Code' }),
    sig: new RegExp(`<mention id="${USER_ID}/grant:${GRANT_ID}" kind="agent" label="Kim · Claude Code">`, 'i'),
    token: new RegExp(`@\\[Kim · Claude Code\\]\\(agent:${USER_ID}/grant:${GRANT_ID}\\)`),
  },
  {
    name: 'inline math',
    place: 'inline',
    add: inlineEl('inlineMath', { latex: 'a_1' }),
    sig: /<inlineMath latex="a_1">/i,
    token: /\$a_1\$/,
  },
  {
    name: 'underline',
    place: 'inline',
    add: mark({ underline: {} }),
    sig: /<underline>text<\/underline>/i,
    token: null,
  },
  {
    name: 'text color',
    place: 'inline',
    add: mark({ textColor: { stringValue: 'blue' } }),
    sig: /<textColor stringValue="blue">text<\/textColor>/i,
    token: null,
  },
  {
    name: 'highlight (background color)',
    place: 'inline',
    add: mark({ backgroundColor: { stringValue: 'yellow' } }),
    sig: /<backgroundColor stringValue="yellow">text<\/backgroundColor>/i,
    token: null,
  },
]

const BASE = `Intro.

## S

Alpha anchor.

Beta text here.

## T

Beta text yonder.
`

/** Page with the element in section S (or, `other`, in section T). */
async function pageWith(el: Element, other = false): Promise<Y.Doc> {
  const doc = await docFromMarkdown(BASE)
  if (el.place === 'heading') {
    // the section heading itself (## S, or ## T for the other section)
    el.add(doc, topGroup(doc).get(other ? 4 : 1) as Y.XmlElement)
    return doc
  }
  const host = el.place === 'block' ? (other ? 'Beta text yonder' : 'Alpha anchor') : other ? 'Beta text yonder' : 'Beta text here'
  el.add(doc, containerByText(doc, host))
  return doc
}

/** The route's patch: what the agent saw (echo), then the synchronous patch. */
async function patch(doc: Y.Doc, ref: string, md: string): Promise<void> {
  const incoming = await markdownToBlocks(md, noTitles, undefined, parseOpts(doc))
  const current = readBlocks(doc)
  const s = findSection(splitSections(current), ref)!
  const echo = await buildEchoIndex(current.slice(s.start, s.end), noTitles, parseOpts(doc))
  const out = applySectionPatch(doc, ref, incoming, 'replace', undefined, echo)
  assert.equal(out.status, 'ok')
}

async function sectionMd(doc: Y.Doc, ref: string): Promise<string> {
  const blocks = readBlocks(doc)
  const s = findSection(splitSections(blocks), ref)!
  return agentMd(blocks.slice(s.start, s.end))
}

type Result = 'kept' | 'LOST' | 'deleted' | 'STUCK' | 'n/a'
interface Row {
  name: string
  visible: boolean
  asRead: Result
  edited: Result
  deleted: Result
  retyped: Result
  updatePage: Result
  otherSection: Result
}

async function measure(el: Element): Promise<Row> {
  const kept = (doc: Y.Doc): Result => (el.sig.test(xml(doc)) ? 'kept' : 'LOST')
  // as read
  let doc = await pageWith(el)
  assert.ok(el.sig.test(xml(doc)), `${el.name}: built element not found in ${xml(doc)}`)
  const md = await sectionMd(doc, 's')
  const visible = el.token ? el.token.test(md) : false
  await patch(doc, 's', md)
  const asRead = kept(doc)
  // text around it edited (inline elements: another word of the same paragraph)
  doc = await pageWith(el)
  const md2 = await sectionMd(doc, 's')
  const edited2 = el.place === 'block' ? md2.replace('Beta text here.', 'Beta text was edited.') : md2.replace('Alpha anchor.', 'Alpha anchor edited.').replace(/here\.$/m, 'there.')
  assert.notEqual(edited2, md2, `${el.name}: edit did not apply to ${md2}`)
  await patch(doc, 's', edited2)
  const edited = kept(doc)
  // its notation deleted
  let deleted: Result = 'n/a'
  if (el.token && visible) {
    doc = await pageWith(el)
    const md3 = await sectionMd(doc, 's')
    const without = md3.replace(el.token, '').replace(/\n{3,}/g, '\n\n')
    await patch(doc, 's', without)
    deleted = el.sig.test(xml(doc)) ? 'STUCK' : 'deleted'
  }
  // host block retyped (paragraph → bullet), inline elements only
  let retyped: Result = 'n/a'
  if (el.place === 'inline') {
    doc = await pageWith(el)
    const md4 = await sectionMd(doc, 's')
    const lines = md4.split('\n')
    const i = lines.findIndex((l) => l.startsWith('Beta'))
    lines[i] = `* ${lines[i]}`
    await patch(doc, 's', lines.join('\n'))
    retyped = kept(doc)
  }
  // update_page replace with the whole page as read (the route: echo of the current blocks, then
  // the minimal edit of the whole document)
  doc = await pageWith(el)
  const full = await agentMd(readBlocks(doc))
  const incoming = await markdownToBlocks(full, noTitles, undefined, parseOpts(doc))
  applyDocumentReplace(doc, incoming, await buildEchoIndex(readBlocks(doc), noTitles, parseOpts(doc)))
  const updatePage = kept(doc)
  // element in the other section while S is edited
  doc = await pageWith(el, true)
  const md5 = await sectionMd(doc, 's')
  await patch(doc, 's', md5.replace('Beta text here.', 'Beta text was edited.'))
  const otherSection = kept(doc)
  return { name: el.name, visible, asRead, edited, deleted, retyped, updatePage, otherSection }
}

describe('notation round trip (read_page Markdown ↔ patch_section / update_page)', () => {
  it('every element kind × as read / edited around / deleted / retyped / update_page / other section', async () => {
    const rows: Row[] = []
    for (const el of ELEMENTS) rows.push(await measure(el))
    console.log('[census] element                      | shown | as read | edit around | delete  | retype | update_page | other section')
    for (const r of rows) {
      console.log(
        `[census] ${r.name.padEnd(28)} | ${(r.visible ? 'yes' : 'no').padEnd(5)} | ${r.asRead.padEnd(7)} | ${r.edited.padEnd(11)} | ${r.deleted.padEnd(7)} | ${r.retyped.padEnd(6)} | ${r.updatePage.padEnd(11)} | ${r.otherSection}`,
      )
    }
    if (CENSUS) return
    for (const r of rows) {
      assert.equal(r.asRead, 'kept', `${r.name}: as read`)
      assert.equal(r.edited, 'kept', `${r.name}: edited around`)
      assert.equal(r.updatePage, 'kept', `${r.name}: update_page replace`)
      assert.equal(r.otherSection, 'kept', `${r.name}: other section`)
      assert.notEqual(r.deleted, 'STUCK', `${r.name}: delete`)
      assert.notEqual(r.retyped, 'LOST', `${r.name}: retype`)
    }
    // everything Markdown has no syntax for is visible, except props/marks the minimal edit keeps
    const hidden = rows.filter((r) => !r.visible).map((r) => r.name)
    assert.deepEqual(hidden, ['toggle heading', 'block color/alignment', 'underline', 'text color', 'highlight (background color)'])
  })

  it('a page holding every element: patch_section and update_page sent back as read write nothing', async () => {
    const doc = await docFromMarkdown(BASE)
    const beta = containerByText(doc, 'Beta text here')
    // marks and block props first, then the inline nodes (they split the text run)
    const order = [...ELEMENTS].sort((a, b) => Number(a.sig.source.includes('mention') || a.sig.source.includes('inlineMath')) - Number(b.sig.source.includes('mention') || b.sig.source.includes('inlineMath')))
    for (const el of order) {
      if (el.place === 'heading') el.add(doc, topGroup(doc).get(1) as Y.XmlElement)
      else if (el.place === 'inline') el.add(doc, beta)
      else el.add(doc, containerByText(doc, 'Alpha anchor'))
    }
    const md = await sectionMd(doc, 's')
    const sv = Y.encodeStateVector(doc)
    await patch(doc, 's', md)
    assert.deepEqual(Y.encodeStateVector(doc), sv, 'patch_section as read wrote something')
    const full = await agentMd(readBlocks(doc))
    const stats = applyDocumentReplace(doc, await markdownToBlocks(full, noTitles, undefined, parseOpts(doc)), await buildEchoIndex(readBlocks(doc), noTitles, parseOpts(doc)))
    assert.deepEqual([stats.edited, stats.inserted, stats.deleted], [0, 0, 0], JSON.stringify(stats))
    assert.deepEqual(Y.encodeStateVector(doc), sv, 'update_page as read wrote something')
    for (const el of ELEMENTS) if (el.place !== 'inline' || el.token) assert.match(xml(doc), el.sig, el.name)
  })

  it('changing a notation changes the node; new ones are created (mentions only for chips already in the page)', async () => {
    const doc = await docFromMarkdown(BASE)
    for (const name of ['callout', 'page embed', 'link embed', 'file name/caption', 'mention']) {
      const el = ELEMENTS.find((e) => e.name === name)!
      el.add(doc, containerByText(doc, el.place === 'inline' ? 'Beta text here' : 'Alpha anchor'))
    }
    const callout = containerByText(doc, 'Careful here')
    const calloutId = callout.getAttribute('id')
    const md = await sectionMd(doc, 's')
    const OTHER_PAGE = '7a2b3c4d-5555-4e6f-8a9b-0c1d2e3f4a5b'
    const STRANGER = '9e8d7c6b-6666-4a5b-9c8d-7e6f5a4b3c2d'
    const edited = md
      .replace('> [!warning] Careful here', '> [!tip] Careful **here**, really')
      .replace(PAGE_ID, OTHER_PAGE)
      .replace('"display":"card"', '"display":"embed"')
      .replace('"caption":"Q3 report"', '"caption":"Q4 report"')
      .concat(`\n\n> [!danger] Brand new callout\n\n<!-- inkling:pageEmbed {"pageId":"${PAGE_ID}"} -->\n\nAsk @[Kim](user:${USER_ID}) and @[Lee](user:${STRANGER}).`)
    await patch(doc, 's', edited)
    const x = xml(doc)
    // edited in place: same block id, new type, text diffed
    const c2 = containerByText(doc, 'really')
    assert.equal(c2.getAttribute('id'), calloutId)
    assert.match(x, /<callout type="tip">Careful <bold>here<\/bold>, really<\/callout>/i)
    assert.match(x, new RegExp(`<pageEmbed pageId="${OTHER_PAGE}">`, 'i'))
    assert.match(x, /<linkEmbed display="embed" url=/i)
    assert.match(x, /<file [^>]*caption="Q4 report"/i)
    // created
    assert.match(x, /<callout type="danger">Brand new callout<\/callout>/i)
    assert.match(x, new RegExp(`<pageEmbed pageId="${PAGE_ID}">`, 'i'))
    // a chip already in the page may be written again; an unknown person stays text
    assert.equal((x.match(new RegExp(`<mention id="${USER_ID}"`, 'gi')) ?? []).length, 2)
    assert.doesNotMatch(x, new RegExp(STRANGER))
    assert.match(x, /and @Lee\./)
  })

  it('nested under a list item, embeds / callouts / files are shown flat and kept (moved to the top level)', async () => {
    // BlockNote's Markdown writes non-list children of a block at the top level (ADR 0940 trade-off),
    // so a patch over the section re-creates them there: the nodes and their props survive, their
    // nesting and ids do not.
    const doc = editor.blocksToYDoc(
      [
        { type: 'heading', props: { level: 2 }, content: 'S' },
        {
          type: 'bulletListItem',
          content: 'parent',
          children: [
            { type: 'pageEmbed', props: { pageId: PAGE_ID } },
            { type: 'callout', props: { type: 'tip' }, content: 'nested callout' },
            { type: 'file', props: { url: '/files/0b9d8e7f-3333-4a1b-8c3d-abcdef012345', name: 'r.pdf' } },
          ],
        },
      ] as never,
      'document',
    )
    const md = await sectionMd(doc, 's')
    assert.match(md, /^<!-- inkling:pageEmbed .* -->$/m)
    assert.match(md, /^> \[!tip\] nested callout$/m)
    assert.match(md, /^<!-- inkling:file .* -->$/m)
    await patch(doc, 's', md.replace(/^## S\n\n/, ''))
    const x = xml(doc)
    assert.match(x, new RegExp(`<pageEmbed pageId="${PAGE_ID}">`, 'i'))
    assert.match(x, /<callout type="tip">nested callout<\/callout>/i)
    assert.match(x, /<file [^>]*name="r.pdf"/i)
    assert.equal(await sectionMd(doc, 's'), md, 'reads back the same')
  })

  it('tokens are inert where they are not notation: code, invalid JSON, unsafe URLs', async () => {
    const md = [
      '`<!-- inkling:pageEmbed {"pageId":"' + PAGE_ID + '"} -->` and `@[Kim](user:' + USER_ID + ')`',
      '',
      '```',
      '<!-- inkling:pageEmbed {"pageId":"' + PAGE_ID + '"} -->',
      '@[Kim](user:' + USER_ID + ')',
      '```',
      '',
      '<!-- inkling:linkEmbed {"url":"javascript:alert(1)"} -->',
      '',
      '<!-- inkling:pageEmbed {"pageId":"not-a-uuid"} -->',
      '',
      '<!-- inkling:pageEmbed {not json} -->',
      '',
      '<!-- inkling:file {"url":"https://files.example/x.pdf","name":"x"} -->',
    ].join('\n')
    const blocks = await markdownToBlocks(md, noTitles, undefined, { mentions: 'all' })
    const types = blocks.map((b) => b.type)
    assert.deepEqual(types, ['paragraph', 'codeBlock', 'file'])
    const text = JSON.stringify(blocks)
    assert.match(text, /`?<!-- inkling:pageEmbed/)
    assert.match(text, new RegExp(`@\\[Kim\\]\\(user:${USER_ID}\\)`))
    assert.doesNotMatch(text, /"type":"mention"/)
  })

  it('plain Markdown (export, vault sync) shows callouts and @names, never tokens', async () => {
    const doc = await docFromMarkdown(BASE)
    for (const el of ELEMENTS) {
      if (el.place === 'block') el.add(doc, containerByText(doc, 'Alpha anchor'))
      if (el.name === 'mention') el.add(doc, containerByText(doc, 'Beta text here'))
    }
    const plain = (await blocksToMarkdown(readBlocks(doc), { assetMode: 'absolute' })).markdown
    assert.match(plain, /^> \[!warning\] Careful here$/m)
    assert.match(plain, /Beta @Kimtext here\./)
    assert.doesNotMatch(plain, /inkling:|@\[/)
    assert.doesNotMatch(plain, new RegExp(PAGE_ID))
    // an Obsidian / GitHub callout imports as a callout
    const back = await markdownToBlocks('> [!NOTE] From the vault\n\n> plain quote', noTitles)
    assert.deepEqual(back.map((b) => [b.type, b.props?.type ?? null]), [['callout', 'note'], ['quote', null]])
  })
})
