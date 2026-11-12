// The edit budget of one replace (docs/adr/2550-*). Pure — no database, no server.
//
// Past the budget a changed block keeps its id but its content node is swapped whole. These tests
// pin down what that keeps (block ids, so comment anchors and block links; block colors; the result
// reads back as sent) and what it loses (concurrent typing and marks Markdown cannot express in the
// swapped blocks), and that ordinary edits never reach the budget, also on a large page.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import * as Y from 'yjs'
import { blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { splitSections } from './chunker'
import { applySectionBatch } from './sectionBatch'
import { applyDocumentReplace, buildEchoIndex, lastReplaceWork, readBlocks, REPLACE_BUDGET, setReplaceBudgetForTests } from './sectionPatch'

const editor = getServerEditor()
const noTitles = () => null

afterEach(() => setReplaceBudgetForTests(null))

const PAGE = [
  '# Notes',
  'Alpha paragraph one two three.',
  'Beta paragraph four five six.',
  'Gamma paragraph seven eight nine.',
  'Delta paragraph ten eleven twelve.',
].join('\n\n')

// Alpha: a pure insertion at the end (one Yjs insert); the others: one word rewritten.
const AGENT = [
  '# Notes',
  'Alpha paragraph one two three. More.',
  'Beta paragraph four FIVE six.',
  'Gamma paragraph seven EIGHT nine.',
  'Delta paragraph ten ELEVEN twelve.',
].join('\n\n')

function topContainers(doc: Y.Doc): Y.XmlElement[] {
  const g = doc.getXmlFragment('document').get(0) as Y.XmlElement
  return g.toArray().filter((c) => c instanceof Y.XmlElement && c.nodeName === 'blockContainer') as Y.XmlElement[]
}

const content = (c: Y.XmlElement) => c.get(0) as Y.XmlElement
const firstText = (c: Y.XmlElement) => content(c).toArray().find((x) => x instanceof Y.XmlText) as Y.XmlText
/** Plain text of a block (marks left out). */
const textOf = (c: Y.XmlElement) =>
  content(c)
    .toArray()
    .filter((x) => x instanceof Y.XmlText)
    .map((x) => ((x as Y.XmlText).toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join(''))
    .join('')

function countBlocks(blocks: AnyBlock[]): number {
  let n = 0
  for (const b of blocks) n += 1 + countBlocks(b.children ?? [])
  return n
}

async function docFromMarkdown(md: string): Promise<Y.Doc> {
  return editor.blocksToYDoc((await markdownToBlocks(md, noTitles)) as never, 'document')
}

/** update_page(replace) as the route runs it (echo up to 2,000 blocks). */
async function replace(doc: Y.Doc, md: string): Promise<AnyBlock[]> {
  const incoming = await markdownToBlocks(md, noTitles)
  const current = readBlocks(doc)
  const echo = countBlocks(current) <= 2_000 ? await buildEchoIndex(current, noTitles, {}, incoming) : null
  applyDocumentReplace(doc, incoming, echo)
  return incoming
}

/** A page with a colored, underlined paragraph and a client that types into two blocks before the replace. */
async function scene(): Promise<{ server: Y.Doc; typed: Uint8Array; ids: string[] }> {
  const server = await docFromMarkdown(PAGE)
  const [, alpha, beta, , delta] = topContainers(server)
  firstText(alpha).format(0, 5, { underline: {} })
  firstText(beta).format(0, 4, { underline: {} })
  content(delta).setAttribute('textColor', 'red')
  const ids = topContainers(server).map((c) => String(c.getAttribute('id')))
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const sv = Y.encodeStateVector(client)
  const [, ca, cb] = topContainers(client)
  firstText(ca).insert(firstText(ca).length, '[A]')
  firstText(cb).insert(0, '[B]')
  const typed = Y.encodeStateAsUpdate(client, sv)
  client.destroy()
  return { server, typed, ids }
}

describe('replace edit budget (docs/adr/2550-*)', () => {
  it('within the budget every changed block is edited in place (as before)', async () => {
    const { server, typed, ids } = await scene()
    await replace(server, AGENT)
    Y.applyUpdate(server, typed)
    assert.deepEqual(lastReplaceWork().swapped, 0)
    const top = topContainers(server)
    assert.deepEqual(top.map((c) => String(c.getAttribute('id'))), ids)
    // both edits survive, merged by position as concurrent edits do
    assert.equal(textOf(top[1]).replace('[A]', ''), 'Alpha paragraph one two three. More.')
    assert.match(textOf(top[1]), /\[A\]/)
    assert.equal(textOf(top[2]), '[B]Beta paragraph four FIVE six.')
  })

  it('past the budget the remaining changed blocks are swapped whole: ids and block colors stay, typing and underline in them are lost', async () => {
    // one Yjs operation: Alpha's insertion fits, the next changed block finds the budget spent
    setReplaceBudgetForTests({ textOps: 1 })
    const { server, typed, ids } = await scene()
    const incoming = await replace(server, AGENT)
    assert.deepEqual(lastReplaceWork(), { ...lastReplaceWork(), textOps: 1, swapped: 3 })
    Y.applyUpdate(server, typed)
    const top = topContainers(server)
    // block ids (comment anchors, block links) are the same
    assert.deepEqual(top.map((c) => String(c.getAttribute('id'))), ids)
    // the page reads back as the Markdown that was sent
    const sent = (await blocksToMarkdown(incoming, { assetMode: 'absolute' })).markdown.trim()
    const blocks = readBlocks(server)
    // Alpha (edited in place) kept the concurrent typing; Beta (swapped) lost it
    assert.equal(textOf(top[1]).replace('[A]', ''), 'Alpha paragraph one two three. More.')
    assert.match(textOf(top[1]), /\[A\]/)
    assert.equal(textOf(top[2]), 'Beta paragraph four FIVE six.')
    const withoutTyping = (await blocksToMarkdown(blocks, { assetMode: 'absolute' })).markdown.trim().replace('[A]', '')
    assert.equal(withoutTyping, sent)
    // underline: kept on the block edited in place, lost on the swapped one
    assert.deepEqual((blocks[1].content as unknown[])[0], { type: 'text', text: 'Alpha', styles: { underline: true } })
    assert.deepEqual((blocks[2].content as { styles: unknown }[]).map((c) => c.styles), [{}])
    // the block color of a swapped block stays
    assert.equal(blocks[4].props?.textColor, 'red')
  })

  it('past the budget a block the agent did not change is still left alone (no echo, every block paired)', async () => {
    setReplaceBudgetForTests({ textOps: 0, diffWork: 0 })
    const server = await docFromMarkdown(PAGE)
    const [, alpha] = topContainers(server)
    firstText(alpha).format(0, 5, { underline: {} })
    const ids = topContainers(server).map((c) => String(c.getAttribute('id')))
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    const sv = Y.encodeStateVector(client)
    firstText(topContainers(client)[1]).insert(0, '[A]')
    const typed = Y.encodeStateAsUpdate(client, sv)
    client.destroy()
    // Alpha unchanged, the other three paragraphs changed; no echo, so every block is a pair
    const body = AGENT.replace('Alpha paragraph one two three. More.', 'Alpha paragraph one two three.')
    applyDocumentReplace(server, await markdownToBlocks(body, noTitles), null)
    assert.deepEqual(lastReplaceWork(), { textOps: 0, diffWork: 0, swapped: 3 })
    Y.applyUpdate(server, typed)
    const top = topContainers(server)
    assert.deepEqual(top.map((c) => String(c.getAttribute('id'))), ids)
    assert.equal(textOf(top[1]), '[A]Alpha paragraph one two three.')
    assert.deepEqual((readBlocks(server)[1].content as unknown[])[1], { type: 'text', text: 'Alpha', styles: { underline: true } })
  })

  it('a large page with a few words changed is edited in place without touching the budget', async () => {
    const md = mixed(300_000, 7)
    const doc = await docFromMarkdown(md)
    assert.ok(countBlocks(readBlocks(doc)) > 2_000, 'large enough that the echo is skipped')
    // three words changed far apart
    const words = md.split(' ')
    for (const at of [100, Math.floor(words.length / 2), words.length - 50]) words[at] = `${words[at]}X`
    await replace(doc, words.join(' '))
    const used = lastReplaceWork()
    assert.equal(used.swapped, 0)
    assert.ok(used.textOps <= 10, `text operations: ${used.textOps}`)
    assert.ok(used.diffWork < REPLACE_BUDGET.diffWork / 4, `diff work ${used.diffWork} of ${REPLACE_BUDGET.diffWork}`)
  })

  it('patch_sections shares one budget across its edits (a dry run and the live run agree)', async () => {
    const md = '## One\n\nAlpha beta gamma.\n\n## Two\n\nDelta epsilon zeta.\n\n## Three\n\nEta theta iota.'
    const run = async (budget: number | null) => {
      setReplaceBudgetForTests(budget === null ? null : { textOps: budget })
      const doc = await docFromMarkdown(md)
      const sections = splitSections(readBlocks(doc))
      const edit = async (anchor: string, body: string) => ({
        blockId: sections.find((s) => s.anchor === anchor)!.blockId,
        anchor,
        incoming: await markdownToBlocks(body, noTitles),
        mode: 'replace' as const,
        echo: null,
      })
      const out = applySectionBatch(doc, [await edit('one', 'Alpha BETA gamma.'), await edit('two', 'Delta EPSILON zeta.'), await edit('three', 'Eta THETA iota.')])
      assert.equal(out.status, 'ok')
      assert.deepEqual(
        splitSections(readBlocks(doc)).map((s) => s.text.trim()),
        ['Alpha BETA gamma.', 'Delta EPSILON zeta.', 'Eta THETA iota.'],
      )
      return lastReplaceWork()
    }
    // the default budget: the last edit is a character edit like the others
    const free = await run(null)
    assert.equal(free.swapped, 0)
    assert.ok(free.textOps > 0)
    // a budget the first edit spends: the last edit finds nothing left and swaps its block
    const spent = await run(2)
    assert.equal(spent.textOps, 0)
    assert.equal(spent.swapped, 1)
  })

  it('rewriting a 300K body of random words stops at the budget', async () => {
    const doc = await docFromMarkdown(randomWords(300_000, 3))
    await replace(doc, randomWords(300_000, 4))
    const used = lastReplaceWork()
    assert.ok(used.swapped > 0)
    assert.ok(used.textOps <= REPLACE_BUDGET.textOps, `text operations: ${used.textOps}`)
  })
})

// ---- generators (seeded, so counts are exact) ----------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function wordsOf(r: () => number): () => string {
  return () => {
    const n = 2 + Math.floor(r() * 7)
    let w = ''
    for (let i = 0; i < n; i++) w += String.fromCharCode(97 + Math.floor(r() * 26))
    return w
  }
}

function randomWords(bytes: number, seed: number): string {
  const word = wordsOf(rng(seed))
  const paras: string[] = []
  let n = 0
  while (n < bytes) {
    const p = Array.from({ length: 80 }, word).join(' ')
    paras.push(p)
    n += p.length + 2
  }
  return paras.join('\n\n').slice(0, bytes)
}

function mixed(bytes: number, seed: number): string {
  const r = rng(seed)
  const word = wordsOf(r)
  const sentence = (n: number) => Array.from({ length: n }, word).join(' ')
  const parts: string[] = []
  let n = 0
  while (n < bytes) {
    const sec = [
      `## ${sentence(4)}`,
      sentence(40 + Math.floor(r() * 40)),
      Array.from({ length: 4 }, () => `- ${sentence(8)}`).join('\n'),
      sentence(30),
      Array.from({ length: 3 }, (_, i) => `${i + 1}. ${sentence(6)}`).join('\n'),
    ].join('\n\n')
    parts.push(sec)
    n += sec.length + 2
  }
  return parts.join('\n\n')
}

