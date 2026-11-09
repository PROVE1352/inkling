// patch_section minimal Yjs edit (docs/adr/0940-*). Pure — no database, no server.
//
// A "server" Y.Doc and a "client" Y.Doc that has not received the patch yet: the client types into
// blocks of the patched section, the agent's patch is applied on the server first, then the client's
// update arrives. Measured against the previous implementation (block splice, kept below as
// `legacyPatch`) on the same scenarios.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { findSection, splitSections } from './chunker'
import { blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { mentionKeysInDoc } from '../md/notation'
import { applySectionPatch, buildEchoIndex, MARKDOWN_MARKS, NON_MARKDOWN_PROPS, readBlocks } from './sectionPatch'
import type { PatchMode, PatchStats } from './sectionPatch'

const editor = getServerEditor()
const noTitles = () => null

async function docFromMarkdown(md: string): Promise<Y.Doc> {
  const blocks = await markdownToBlocks(md, noTitles)
  return editor.blocksToYDoc(blocks as never, 'document')
}

function topGroup(doc: Y.Doc): Y.XmlElement {
  return doc.getXmlFragment('document').get(0) as Y.XmlElement
}

function findContainer(doc: Y.Doc, pred: (text: string, el: Y.XmlElement) => boolean): Y.XmlElement {
  const walk = (g: Y.XmlElement): Y.XmlElement | null => {
    for (const c of g.toArray()) {
      if (!(c instanceof Y.XmlElement) || c.nodeName !== 'blockContainer') continue
      const content = c.get(0) as Y.XmlElement
      const text = content
        .toArray()
        .filter((x) => x instanceof Y.XmlText)
        .map((x) => (x as Y.XmlText).toString())
        .join('')
      if (pred(text, c)) return c
      const kids = c.toArray().find((x) => x instanceof Y.XmlElement && x.nodeName === 'blockGroup') as Y.XmlElement | undefined
      if (kids) {
        const r = walk(kids)
        if (r) return r
      }
    }
    return null
  }
  const r = walk(topGroup(doc))
  if (!r) throw new Error('container not found')
  return r
}

const byText = (doc: Y.Doc, needle: string) => findContainer(doc, (t) => t.includes(needle))
const firstText = (container: Y.XmlElement) => (container.get(0) as Y.XmlElement).toArray().find((x) => x instanceof Y.XmlText) as Y.XmlText

/** Patch with the echo index the route computes (what the agent saw; chips in the page may stay). */
async function patch(doc: Y.Doc, ref: string, md: string, mode: PatchMode = 'replace', strategy?: 'merge' | 'splice') {
  const notation = { mentions: mentionKeysInDoc(doc) }
  const incoming = await markdownToBlocks(md, noTitles, undefined, notation)
  const current = readBlocks(doc)
  const s = findSection(splitSections(current), ref)
  const echo = s ? await buildEchoIndex(current.slice(s.start, s.end), noTitles, notation) : null
  const out = applySectionPatch(doc, ref, incoming, mode, undefined, echo, strategy ? { strategy } : {})
  assert.equal(out.status, 'ok')
  return out as Extract<typeof out, { status: 'ok' }>
}

async function sectionMd(doc: Y.Doc, ref: string, notation: 'plain' | 'agent' = 'plain'): Promise<string> {
  const blocks = readBlocks(doc)
  const s = findSection(splitSections(blocks), ref)!
  return (await blocksToMarkdown(blocks.slice(s.start, s.end), { assetMode: 'absolute', notation })).markdown.trim()
}

/** Markdown of the blocks from the heading `from` up to (not including) the heading `to`. */
async function rangeMd(doc: Y.Doc, from: string, to: string): Promise<string> {
  const blocks = readBlocks(doc)
  const at = (t: string) => blocks.findIndex((b) => b.type === 'heading' && JSON.stringify(b.content).includes(`"text":"${t}"`))
  return (await blocksToMarkdown(blocks.slice(at(from), at(to)), { assetMode: 'absolute' })).markdown.trim()
}

/** Markdown as the server writes it back (parse + export), for comparisons. */
async function normalMd(md: string): Promise<string> {
  return (await blocksToMarkdown(await markdownToBlocks(md, noTitles), { assetMode: 'absolute' })).markdown.trim()
}

function allText(doc: Y.Doc): string {
  return JSON.stringify(readBlocks(doc))
}

// ---------------------------------------------------------------------------
// The previous implementation (docs/adr/0930-*), kept verbatim for the before/after measurement.
// ---------------------------------------------------------------------------
function legacyPatch(doc: Y.Doc, ref: string, incoming: AnyBlock[]): void {
  const blocks = editor.yDocToBlocks(doc, 'document') as unknown as AnyBlock[] // reads the live doc
  const sections = splitSections(blocks)
  const sec = findSection(sections, ref)!
  const group = topGroup(doc)
  const isIntro = sec.level === 0
  const bodyStart = isIntro ? sec.start : sec.start + 1
  const replacesHeading = !isIntro && incoming[0]?.type === 'heading'
  const removeFrom = replacesHeading ? sec.start : bodyStart
  const removeCount = sec.end - removeFrom
  const tmp = editor.blocksToYDoc(incoming as never, 'document')
  const clones = (tmp.getXmlFragment('document').get(0) as Y.XmlElement).toArray().map((c) => (c as Y.XmlElement).clone())
  tmp.destroy()
  doc.transact(() => {
    if (removeCount > 0) group.delete(removeFrom, removeCount)
    group.insert(removeFrom, clones)
  })
}

/** Web-schema nodes the server schema does not know, built the way y-prosemirror stores them. */
function insertCallout(doc: Y.Doc, afterText: string, text: string): Y.XmlElement {
  const group = topGroup(doc)
  const after = byText(doc, afterText)
  const bc = new Y.XmlElement('blockContainer')
  bc.setAttribute('id', `callout-${text.length}-${Math.random().toString(36).slice(2, 8)}`)
  const co = new Y.XmlElement('callout')
  co.setAttribute('type', 'warning')
  bc.insert(0, [co])
  group.insertAfter(after, [bc])
  const t = new Y.XmlText()
  co.insert(0, [t])
  t.insert(0, text)
  return bc
}

function insertMention(container: Y.XmlElement, at: number, label: string): Y.XmlElement {
  const content = container.get(0) as Y.XmlElement
  const seg = content.get(0) as Y.XmlText
  const tail = seg.toString().slice(at)
  seg.delete(at, seg.length - at)
  const m = new Y.XmlElement('mention')
  m.setAttribute('kind', 'user')
  m.setAttribute('id', 'u-1')
  m.setAttribute('label', label)
  const rest = new Y.XmlText()
  content.insertAfter(seg, [m, rest])
  rest.insert(0, tail)
  return m
}

function isAlive(t: Y.AbstractType<any>): boolean {
  for (let x: Y.AbstractType<any> | null = t; x; x = x.parent) {
    if (x._item?.deleted) return false
  }
  return true
}

// ---------------------------------------------------------------------------

const PAGE = `# Plan page

Intro line.

## Plan

Alpha paragraph stays the same.

Beta paragraph will be edited by the agent here.

Gamma paragraph is the anchor before an insert.

Delta paragraph after the insert point.

## Other

Other section text.
`

const AGENT = `Alpha paragraph stays the same.

Beta paragraph was edited by the agent here.

Gamma paragraph is the anchor before an insert.

NEW paragraph inserted by the agent.

Delta paragraph after the insert point.`

type Typing = { label: string; block: string; at: (len: number, text: string) => number; marker: string }
const TYPINGS: Typing[] = [
  { label: '(a) unchanged block', block: 'Alpha paragraph', at: () => 5, marker: '[A]' },
  { label: '(b) changed block, other position', block: 'Beta paragraph', at: (len) => len, marker: '[B]' },
  { label: '(b) changed block, start', block: 'Beta paragraph', at: () => 0, marker: '[B0]' },
  { label: '(c) block before the insert point', block: 'Gamma paragraph', at: (len) => len, marker: '[C]' },
  { label: '(c) block after the insert point', block: 'Delta paragraph', at: () => 0, marker: '[D]' },
  { label: '(d) other section', block: 'Other section', at: () => 0, marker: '[O]' },
]

/** Client types `t` before receiving the patch; returns the update the server gets afterwards. */
function clientTyping(server: Y.Doc, typings: Typing[]): Uint8Array {
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const sv = Y.encodeStateVector(client)
  for (const t of typings) {
    const text = firstText(byText(client, t.block))
    text.insert(t.at(text.length, text.toString()), t.marker)
  }
  const u = Y.encodeStateAsUpdate(client, sv)
  client.destroy()
  return u
}

describe('patch_section: minimal Yjs edit', () => {
  it('concurrent typing in the patched section survives (before/after table)', async () => {
    const rows: string[] = []
    let keptBefore = 0
    let keptAfter = 0
    for (const t of TYPINGS) {
      const res: boolean[] = []
      for (const impl of ['legacy', 'merge'] as const) {
        const server = await docFromMarkdown(PAGE)
        const update = clientTyping(server, [t])
        if (impl === 'legacy') legacyPatch(server, 'plan', await markdownToBlocks(AGENT, noTitles))
        else await patch(server, 'plan', AGENT)
        Y.applyUpdate(server, update)
        const all = allText(server)
        assert.match(all, /Beta paragraph was edited by the agent here/)
        assert.match(all, /NEW paragraph inserted by the agent/)
        res.push(all.includes(t.marker))
      }
      if (res[0]) keptBefore++
      if (res[1]) keptAfter++
      rows.push(`${t.label.padEnd(36)} | ${res[0] ? 'kept' : 'LOST'} | ${res[1] ? 'kept' : 'LOST'}`)
      assert.ok(res[1], `${t.label}: typed text lost`)
    }
    console.log('[eval] concurrent typing   | before | after')
    for (const r of rows) console.log(`[eval] ${r}`)
    console.log(`[eval] preserved before ${keptBefore}/${TYPINGS.length}, after ${keptAfter}/${TYPINGS.length}`)
  })

  it('typing inside the very range the agent rewrites follows CRDT semantics', async () => {
    const server = await docFromMarkdown(PAGE)
    // client types inside "will be", the words the agent replaces by "was"
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    const sv = Y.encodeStateVector(client)
    const text = firstText(byText(client, 'Beta paragraph'))
    text.insert(text.toString().indexOf('will') + 2, 'XY')
    const update = Y.encodeStateAsUpdate(client, sv)
    await patch(server, 'plan', AGENT)
    Y.applyUpdate(server, update)
    const beta = firstText(byText(server, 'Beta paragraph')).toString()
    // inserted characters are never deleted by a concurrent delete of their neighbours; they end up
    // among the agent's characters (here "w|XY|as"): both edits survive, interleaved by position
    assert.match(beta, /XY/)
    assert.doesNotMatch(beta, /will/)
    assert.equal(beta.replace('XY', ''), 'Beta paragraph was edited by the agent here.')
  })

  it('untouched blocks keep their Yjs items; ids kept for edited blocks', async () => {
    const server = await docFromMarkdown(PAGE)
    const before = readBlocks(server)
    const s = findSection(splitSections(before), 'plan')!
    const oldIds = before.slice(s.start + 1, s.end).map((b) => b.id)
    const alphaText = firstText(byText(server, 'Alpha paragraph'))
    const out = await patch(server, 'plan', AGENT)
    assert.equal(out.stats.strategy, 'merge')
    assert.deepEqual([out.stats.kept, out.stats.edited, out.stats.inserted, out.stats.deleted], [3, 1, 1, 0])
    const after = readBlocks(server)
    const ids = new Set(after.map((b) => b.id))
    const keptIds = oldIds.filter((id) => ids.has(id)).length
    // legacy: none of the section's blocks keep their id
    const legacy = await docFromMarkdown(PAGE)
    const lBefore = readBlocks(legacy)
    legacyPatch(legacy, 'plan', await markdownToBlocks(AGENT, noTitles))
    const lIds = new Set(readBlocks(legacy).map((b) => b.id))
    const lKept = lBefore.slice(s.start + 1, s.end).filter((b) => lIds.has(b.id)).length
    console.log(`[eval] block ids kept in the patched section: before ${lKept}/${oldIds.length}, after ${keptIds}/${oldIds.length}`)
    assert.equal(keptIds, oldIds.length)
    assert.ok(isAlive(alphaText), 'the unchanged block keeps its Y.XmlText')
    assert.equal(await sectionMd(server, 'plan'), `## Plan\n\n${AGENT}`)
  })

  it('a no-op patch (the section sent back as read) changes nothing', async () => {
    const md = `## Kitchen sink

Plain **bold** *italic* ~~strike~~ \`code\` and [a link](https://example.com/x) end.

Line one\\
line two

* bullet one
  * nested bullet
* bullet two

1. first
2. second

* [ ] open task
* [x] done task

> a quote

\`\`\`ts
const a = 1
\`\`\`

| h1 | h2 |
| -- | -- |
| c1 | c2 |

### Sub heading

Tail paragraph.
`
    const server = await docFromMarkdown(`# Page\n\n${md}\n## After\n\nx\n`)
    // things Markdown cannot show: a colored paragraph, an underlined word, a toggle item
    const tail = byText(server, 'Tail paragraph')
    ;(tail.get(0) as Y.XmlElement).setAttribute('textColor', 'red')
    firstText(tail).format(0, 4, { underline: {} })
    const bullet = byText(server, 'bullet two')
    const toggle = new Y.XmlElement('toggleListItem')
    for (const [k, v] of Object.entries((bullet.get(0) as Y.XmlElement).getAttributes())) toggle.setAttribute(k, v as never)
    bullet.insert(0, [toggle])
    bullet.delete(1, 1)
    const tt = new Y.XmlText()
    toggle.insert(0, [tt])
    tt.insert(0, 'bullet two')
    const seen = await sectionMd(server, 'kitchen-sink')
    const sv = Y.encodeStateVector(server)
    const state = Y.encodeStateAsUpdate(server)
    const out = await patch(server, 'kitchen-sink', seen)
    assert.deepEqual([out.stats.edited, out.stats.inserted, out.stats.deleted], [0, 0, 0], JSON.stringify(out.stats))
    assert.deepEqual(Y.encodeStateVector(server), sv, 'no Yjs change at all')
    assert.deepEqual(Y.encodeStateAsUpdate(server), state)
  })

  it('edits keep what Markdown cannot express (colors, underline, toggles)', async () => {
    const server = await docFromMarkdown('## S\n\nRed sentence with some words.\n\n* toggle text\n')
    const red = byText(server, 'Red sentence')
    ;(red.get(0) as Y.XmlElement).setAttribute('textColor', 'red')
    firstText(red).format(0, 3, { underline: {} })
    const item = byText(server, 'toggle text')
    const toggle = new Y.XmlElement('toggleListItem')
    item.insert(0, [toggle])
    item.delete(1, 1)
    const tt = new Y.XmlText()
    toggle.insert(0, [tt])
    tt.insert(0, 'toggle text')
    await patch(server, 's', 'Red sentence with **many** words.\n\n* toggle text edited')
    const blocks = readBlocks(server)
    const p = blocks.find((b) => JSON.stringify(b.content).includes('Red'))!
    assert.equal(p.props?.textColor, 'red')
    assert.deepEqual(p.content, [
      { type: 'text', text: 'Red', styles: { underline: true } },
      { type: 'text', text: ' sentence with ', styles: {} },
      { type: 'text', text: 'many', styles: { bold: true } },
      { type: 'text', text: ' words.', styles: {} },
    ])
    const t = blocks.find((b) => JSON.stringify(b.content).includes('toggle'))!
    assert.equal(t.type, 'toggleListItem')
    assert.equal((t.content as { text: string }[])[0].text, 'toggle text edited')
  })

  it('callouts and mentions survive (also in other sections, unlike before)', async () => {
    const rows: string[] = []
    for (const impl of ['legacy', 'merge'] as const) {
      const server = await docFromMarkdown(PAGE)
      const calloutIn = insertCallout(server, 'Beta paragraph', 'Careful inside the section')
      const calloutOut = insertCallout(server, 'Other section', 'Careful in another section')
      const mention = insertMention(byText(server, 'Gamma paragraph'), 6, 'Kim')
      // the agent edits the section as read_page shows it (callout and mention in their notation, ADR 1500)
      const seen = (await sectionMd(server, 'plan', 'agent')).replace(/^## Plan\n\n/, '')
      const md = seen
        .replace('Beta paragraph will be edited', 'Beta paragraph was edited')
        .replace('Gamma @[Kim](user:u-1)paragraph is the anchor', 'Gamma @[Kim](user:u-1)paragraph is the moved anchor')
      assert.notEqual(md, seen)
      if (impl === 'legacy') legacyPatch(server, 'plan', await markdownToBlocks(md, noTitles))
      else await patch(server, 'plan', md)
      const r = [isAlive(calloutIn), isAlive(calloutOut), isAlive(mention)]
      rows.push(`${impl.padEnd(6)} | callout in section ${r[0] ? 'kept' : 'LOST'} | callout elsewhere ${r[1] ? 'kept' : 'LOST'} | mention in edited block ${r[2] ? 'kept' : 'LOST'}`)
      if (impl === 'merge') {
        assert.deepEqual(r, [true, true, true])
        // the callout keeps its text, the mention its place in the edited paragraph
        assert.equal(((calloutIn.get(0) as Y.XmlElement).get(0) as Y.XmlText).toString(), 'Careful inside the section')
        const gamma = byText(server, 'Gamma paragraph')
        const parts = (gamma.get(0) as Y.XmlElement).toArray().map((x) => (x instanceof Y.XmlText ? x.toString() : `@${(x as Y.XmlElement).getAttribute('label')}`))
        assert.equal(parts.join(''), 'Gamma @Kimparagraph is the moved anchor before an insert.')
        assert.equal(await sectionMd(server, 'plan', 'agent'), `## Plan\n\n${md}`)
      }
    }
    for (const r of rows) console.log(`[eval] ${r}`)
  })

  it('hard breaks, nested lists, tables, type changes and deletions read back as sent', async () => {
    const server = await docFromMarkdown(`## S

Para one\\
second line

* item a
  * child a1
* item b

| a | b |
| - | - |
| 1 | 2 |

Will become a heading

Gone paragraph.

## End
`)
    const tableId = readBlocks(server).find((b) => b.type === 'table')!.id
    const next = `Para one changed\\
second\\
third line

* item a
  * child a1 edited
  * child a2
* item b
  * child b1

| a | b |
| - | - |
| 1 | 3 |

### Will become a heading`
    const out = await patch(server, 's', next)
    assert.equal(out.stats.strategy, 'merge')
    assert.equal(await rangeMd(server, 'S', 'End'), await normalMd(`## S\n\n${next}`))
    assert.ok(readBlocks(server).some((b) => b.id === tableId), 'table edited in place keeps its id')
  })

  it('fuzz: random sections and random agent edits read back exactly as sent', async () => {
    let seed = 0x5eed
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
    const WORDS = ['alpha', 'beta', 'gamma', 'delta', '배포', '롤백', 'emoji 🎉', 'x', 'release', 'on-call']
    const sentence = () => {
      const n = 2 + Math.floor(rnd() * 6)
      const w: string[] = []
      for (let i = 0; i < n; i++) {
        const word = pick(WORDS)
        const r = rnd()
        w.push(r < 0.1 ? `**${word}**` : r < 0.15 ? `*${word}*` : r < 0.18 ? `[${word}](https://e.com/${i})` : word)
      }
      return w.join(' ')
    }
    const block = (heading = false): string => {
      const r = rnd()
      if (r < 0.45) return sentence()
      if (r < 0.6) return `* ${sentence()}${rnd() < 0.3 ? `\n  * ${sentence()}` : ''}`
      if (r < 0.7) return `1. ${sentence()}`
      if (r < 0.78) return `* [${rnd() < 0.5 ? 'x' : ' '}] ${sentence()}`
      if (r < 0.85) return `> ${sentence()}`
      if (r < 0.92) return heading ? `### ${sentence()}` : sentence()
      return '```\n' + sentence() + '\n' + sentence() + '\n```'
    }
    const mutate = (b: string): string => {
      const words = b.split(' ')
      const i = Math.floor(rnd() * words.length)
      const r = rnd()
      if (r < 0.4) words[i] = pick(WORDS)
      else if (r < 0.7) words.splice(i, 0, pick(WORDS))
      else if (words.length > 2) words.splice(i, 1)
      else words.push('more')
      return words.join(' ')
    }
    let merged = 0
    let typedKept = 0
    let typedTotal = 0
    let typedLegacy = 0
    for (let iter = 0; iter < 60; iter++) {
      const old = Array.from({ length: 2 + Math.floor(rnd() * 6) }, block)
      const neu: string[] = []
      for (const b of old) {
        const r = rnd()
        if (r < 0.1) continue
        neu.push(r < 0.4 ? mutate(b) : b)
        if (rnd() < 0.15) neu.push(block(true))
      }
      if (neu.length === 0) neu.push(block(true))
      const page = `# P\n\n## Target\n\n${old.join('\n\n')}\n\n## Next\n\nnext text\n`
      const agentMd = neu.join('\n\n')
      const server = await docFromMarkdown(page)
      // a client types a marker into every block of the section
      const client = new Y.Doc()
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
      const sv = Y.encodeStateVector(client)
      const sec = findSection(splitSections(readBlocks(client)), 'target')!
      const markers: { marker: string; id: string }[] = []
      const targetIds = readBlocks(client).slice(sec.start + 1, sec.end).map((b) => String(b.id))
      targetIds.forEach((id, n) => {
        const el = findContainer(client, (_t, c) => c.getAttribute('id') === id)
        const text = firstText(el)
        if (!text) return
        const marker = `⟦${iter}.${n}⟧`
        text.insert(Math.floor(rnd() * (text.length + 1)), marker)
        markers.push({ marker, id })
      })
      const update = Y.encodeStateAsUpdate(client, sv)
      client.destroy()
      const legacy = new Y.Doc()
      Y.applyUpdate(legacy, Y.encodeStateAsUpdate(server))
      const legacyTypes = readBlocks(server)

      const out = await patch(server, 'target', agentMd)
      if (out.stats.strategy === 'merge') merged++
      assert.equal(await rangeMd(server, 'Target', 'Next'), await normalMd(`## Target\n\n${agentMd}`), `iteration ${iter}`)

      // concurrency: markers typed into blocks that still exist after the patch must survive
      Y.applyUpdate(server, update)
      legacyPatch(legacy, 'target', await markdownToBlocks(agentMd, noTitles))
      Y.applyUpdate(legacy, update)
      const after = allText(server)
      const afterLegacy = allText(legacy)
      // A retyped block (paired by ADR 1500) gets a new content node: like a deleted block, typing
      // that reaches the server after the patch is not merged into it.
      const typeBefore = new Map<string, string>()
      const collectTypes = (bs: AnyBlock[]) => bs.forEach((b) => (typeBefore.set(String(b.id), String(b.type)), collectTypes(b.children ?? [])))
      collectTypes(legacyTypes)
      const liveIds = new Set<string>()
      const collect = (bs: AnyBlock[]) =>
        bs.forEach((b) => (typeBefore.get(String(b.id)) === String(b.type) && liveIds.add(String(b.id)), collect(b.children ?? [])))
      collect(readBlocks(server))
      for (const m of markers) {
        if (!liveIds.has(m.id)) continue // the agent deleted that block
        typedTotal++
        if (after.includes(m.marker)) typedKept++
        if (afterLegacy.includes(m.marker)) typedLegacy++
      }
    }
    console.log(`[eval] fuzz: 60 patches, ${merged} minimal (no fallback); typed markers in surviving blocks kept: before ${typedLegacy}/${typedTotal}, after ${typedKept}/${typedTotal}`)
    assert.equal(merged, 60)
    assert.equal(typedKept, typedTotal)
  })

  it('append / prepend / insert_after / delete keep unknown blocks and never read the live doc', async () => {
    const server = await docFromMarkdown(PAGE)
    const callout = insertCallout(server, 'Other section', 'Elsewhere')
    for (const [mode, md] of [
      ['append', 'Appended.'],
      ['prepend', 'Prepended.'],
      ['insert_after', '## Inserted\n\nBody.'],
    ] as const) {
      const out = await patch(server, 'plan', md, mode)
      assert.equal(out.stats.strategy, 'insert')
    }
    assert.ok(isAlive(callout))
    const s = await sectionMd(server, 'plan')
    assert.match(s, /^## Plan\n\nPrepended\.\n\nAlpha/)
    assert.match(s, /Delta paragraph after the insert point\.\n\nAppended\.$/)
    const out = applySectionPatch(server, 'inserted', [], 'delete', undefined)
    assert.equal(out.status, 'ok')
    assert.ok(isAlive(callout))
    assert.doesNotMatch(allText(server), /Inserted/)
  })

  it('patches write as the document’s own client (the state vector does not grow per patch)', async () => {
    const server = await docFromMarkdown(PAGE)
    const id = server.clientID
    const entries = () => Y.decodeStateVector(Y.encodeStateVector(server)).size
    const before = entries()
    for (let i = 0; i < 20; i++) await patch(server, 'plan', AGENT.replace('was edited', `was edited ${i} times`))
    assert.equal(entries(), before)
    assert.equal(server.clientID, id)
  })

  it('the splice fallback still works and rebuilds the callouts it was sent', async () => {
    const server = await docFromMarkdown(PAGE)
    insertCallout(server, 'Beta paragraph', 'Inside')
    const md = AGENT.replace('NEW paragraph', '> [!warning] Inside\n\nNEW paragraph')
    const out = await patch(server, 'plan', md, 'replace', 'splice')
    const stats: PatchStats = out.stats
    assert.equal(stats.strategy, 'splice')
    assert.match(server.getXmlFragment('document').toString(), /<callout type="warning">Inside<\/callout>/)
    assert.equal(await sectionMd(server, 'plan', 'agent'), `## Plan\n\n${md}`)
  })

  it('MARKDOWN_MARKS / NON_MARKDOWN_PROPS match BlockNote’s Markdown round trip', async () => {
    const styles = ['bold', 'italic', 'strike', 'code', 'underline', 'textColor', 'backgroundColor']
    for (const st of styles) {
      const value = st === 'textColor' || st === 'backgroundColor' ? 'red' : true
      const md = await editor.blocksToMarkdownLossy([{ type: 'paragraph', content: [{ type: 'text', text: 'x', styles: { [st]: value } }] }] as never)
      const back = (await editor.tryParseMarkdownToBlocks(md)) as unknown as AnyBlock[]
      const kept = JSON.stringify(back[0].content).includes(`"${st}"`)
      assert.equal(kept, MARKDOWN_MARKS.has(st), `style ${st}: kept=${kept}`)
    }
    const probes: [AnyBlock, string, unknown][] = [
      [{ type: 'paragraph', props: { textColor: 'red' }, content: 'x' } as never, 'textColor', 'red'],
      [{ type: 'paragraph', props: { backgroundColor: 'red' }, content: 'x' } as never, 'backgroundColor', 'red'],
      [{ type: 'paragraph', props: { textAlignment: 'center' }, content: 'x' } as never, 'textAlignment', 'center'],
      [{ type: 'heading', props: { level: 2, isToggleable: true }, content: 'x' } as never, 'isToggleable', true],
      [{ type: 'image', props: { url: 'https://e.com/a.png', previewWidth: 300 } } as never, 'previewWidth', 300],
      [{ type: 'heading', props: { level: 3 }, content: 'x' } as never, 'level', 3],
      [{ type: 'checkListItem', props: { checked: true }, content: 'x' } as never, 'checked', true],
      [{ type: 'codeBlock', props: { language: 'python' }, content: 'x' } as never, 'language', 'python'],
      [{ type: 'numberedListItem', props: { start: 5 }, content: 'x' } as never, 'start', 5],
      [{ type: 'image', props: { url: 'https://e.com/a.png', caption: 'cap' } } as never, 'caption', 'cap'],
    ]
    for (const [b, prop, value] of probes) {
      const md = await editor.blocksToMarkdownLossy([b] as never)
      const back = (await editor.tryParseMarkdownToBlocks(md)) as unknown as AnyBlock[]
      const kept = back[0]?.props?.[prop] === value
      assert.equal(!kept, NON_MARKDOWN_PROPS.has(prop), `prop ${prop}: kept=${kept}`)
    }
  })
})
