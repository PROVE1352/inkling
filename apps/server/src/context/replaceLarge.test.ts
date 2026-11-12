// update_page(replace) on large bodies (docs/adr/2550-*). Pure — no database, no server.
//
// The whole-body replace is a minimal edit (docs/adr/1500-*): changed blocks of the same type are
// edited character by character. Rewriting a large body with different text used to pair every old
// paragraph with a new one and apply hundreds of character edits to each, cutting the document into
// hundreds of thousands of Yjs items (a ~1 MB body twice ran a 512 MB heap out of memory). These tests
// judge by counts, not by the clock: the document's Yjs structs after the replaces against the same
// body built fresh.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { blocksToMarkdown, blocksToXmlFragment, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { applyDocumentReplace, buildEchoIndex, readBlocks } from './sectionPatch'

const editor = getServerEditor()
const noTitles = () => null

/** Deterministic PRNG (mulberry32), so every count below is the same on every run. */
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

/** Paragraphs of 80 random words until `bytes` (the shape of the w221 reproduction). */
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

/** Ordinary mixed Markdown: headings, paragraphs, lists, a table and code, with random words. */
function mixed(bytes: number, seed: number): string {
  const r = rng(seed)
  const word = wordsOf(r)
  const sentence = (n: number) => Array.from({ length: n }, word).join(' ')
  const parts: string[] = []
  let n = 0
  for (let s = 0; n < bytes; s++) {
    const sec = [
      `## ${sentence(4)}`,
      sentence(40 + Math.floor(r() * 40)),
      Array.from({ length: 4 }, () => `- ${sentence(8)}`).join('\n'),
      `| a | b |\n| --- | --- |\n| ${word()} | ${word()} |\n| ${word()} | ${word()} |`,
      sentence(30),
      '```\n' + sentence(12) + '\n```',
      Array.from({ length: 3 }, (_, i) => `${i + 1}. ${sentence(6)}`).join('\n'),
    ].join('\n\n')
    parts.push(sec)
    n += sec.length + 2
  }
  return parts.join('\n\n')
}

function countBlocks(blocks: AnyBlock[]): number {
  let n = 0
  for (const b of blocks) n += 1 + countBlocks(b.children ?? [])
  return n
}

/** Yjs structs (items and GC ranges) the document holds: what its memory follows (docs/adr/2540-*). */
function structs(doc: Y.Doc): number {
  let n = 0
  for (const s of doc.store.clients.values()) n += s.length
  return n
}

/** A new page: one empty paragraph. */
function newPage(): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => blocksToXmlFragment([{ type: 'paragraph', content: [] }], doc.getXmlFragment('document')))
  return doc
}

/** update_page(replace) as the route runs it: the echo of the current page up to 2,000 blocks, then the edit. */
async function replace(doc: Y.Doc, md: string): Promise<AnyBlock[]> {
  const incoming = await markdownToBlocks(md, noTitles)
  const current = readBlocks(doc)
  const echo = countBlocks(current) <= 2_000 ? await buildEchoIndex(current, noTitles, {}, incoming) : null
  applyDocumentReplace(doc, incoming, echo)
  return incoming
}

/** Structs of the same blocks written into a new document (the floor for this content). */
function freshStructs(blocks: AnyBlock[]): number {
  const doc = editor.blocksToYDoc(blocks as never, 'document')
  try {
    return structs(doc)
  } finally {
    doc.destroy()
  }
}

async function plain(doc: Y.Doc): Promise<string> {
  return (await blocksToMarkdown(readBlocks(doc), { assetMode: 'absolute' })).markdown.trim()
}

describe('update_page(replace) of a large body (docs/adr/2550-*)', () => {
  it('two replaces of a 300K body of random words keep the document near the size of the body built fresh', async () => {
    const doc = newPage()
    await replace(doc, randomWords(300_000, 1))
    const second = await replace(doc, randomWords(300_000, 2))
    const fresh = freshStructs(second)
    const got = structs(doc)
    assert.ok(got <= 3 * fresh, `structs after two replaces: ${got}, the same body built fresh: ${fresh}`)
    // and the page reads back as the body that was sent
    const want = (await blocksToMarkdown(second, { assetMode: 'absolute' })).markdown.trim()
    assert.equal(await plain(doc), want)
  })

  it('six replaces of a 100K body of random words: each replace adds at most about the body, never more and more', async () => {
    const doc = newPage()
    const after: number[] = []
    let last: AnyBlock[] = []
    for (let i = 1; i <= 6; i++) {
      last = await replace(doc, randomWords(100_000, 10 + i))
      after.push(structs(doc))
    }
    const fresh = freshStructs(last)
    // A replace leaves tombstones (a deleted item stays where a live block still points at it), so a
    // page grows with every rewrite; what must not happen is a rewrite costing many times the body.
    const perReplace = (after[5] - after[1]) / 4
    assert.ok(perReplace <= 2 * fresh, `structs added per replace: ${perReplace}, the body built fresh: ${fresh} (after each: ${after.join(', ')})`)
    assert.ok(after[5] - after[4] <= 2 * fresh, `the last replace added ${after[5] - after[4]}`)
  })

  it('two replaces of a 200K body of mixed Markdown (headings, lists, tables, code) stay near the fresh size', async () => {
    const doc = newPage()
    await replace(doc, mixed(200_000, 21))
    const second = await replace(doc, mixed(200_000, 22))
    const fresh = freshStructs(second)
    const got = structs(doc)
    assert.ok(got <= 3 * fresh, `structs after two replaces: ${got}, the same body built fresh: ${fresh}`)
    const want = (await blocksToMarkdown(second, { assetMode: 'absolute' })).markdown.trim()
    assert.equal(await plain(doc), want)
  })
})
