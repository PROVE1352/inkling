/**
 * Section write benchmark (docs/adr/1500-*). Not part of CI. No database: the in-process core of
 *   - read_page(section)     section blocks read on a copy + agent-notation Markdown
 *   - patch_section(replace) parse the agent's Markdown, echo index, synchronous applySectionPatch
 *   - update_page(replace)   parse, then the old full rewrite (frag.delete + blocksToXmlFragment)
 *                            and the new minimal edit (echo + applyDocumentReplace), interleaved
 * on three synthetic pages (small 5 sections × 6 blocks; one 100-block section; 180 sections × 10
 * blocks with a 10×5 table every third section, ≈ 1.4 MB of Yjs state). The agent changes one word.
 * One warm-up iteration excluded; p50/p95 over N (env N, default 15 / 8).
 *
 *   cd apps/server && npx tsx scripts/section-write-bench.ts [label]
 *
 * To compare with an older tree, run the same script against each checkout, interleaved.
 */
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { blocksToMarkdown, blocksToStateBuffer, blocksToXmlFragment, markdownToBlocks } from '../src/md/convert'
import type { AnyBlock } from '../src/md/convert'
import { getServerEditor } from '../src/md/editor'
import { applyDocumentReplace, applySectionPatch, buildEchoIndex, readBlocks } from '../src/context/sectionPatch'
import { findSection, splitSections } from '../src/context/chunker'

const editor = getServerEditor()
const noTitles = () => null
const t = (text: string) => [{ type: 'text', text, styles: {} }]
const label = process.argv[2] ?? 'run'

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const W = ['run', 'loss', 'val', 'epoch', '실험', '결과', '학습', 'baseline', 'score', 'model']
const words = (r: () => number, n: number) => Array.from({ length: n }, () => W[Math.floor(r() * W.length)]).join(' ')

function build(sections: number, body: number, tables: boolean): AnyBlock[] {
  const r = rng(7)
  const out: AnyBlock[] = [{ type: 'paragraph', content: t('intro ' + words(r, 20)) as never }]
  for (let s = 1; s <= sections; s++) {
    out.push({ type: 'heading', props: { level: 2 }, content: t(`Sec ${s}`) as never })
    for (let b = 0; b < body; b++) {
      out.push({ type: b % 4 === 3 ? 'bulletListItem' : 'paragraph', content: t(words(r, b % 4 === 3 ? 12 : 40)) as never })
    }
    if (tables && s % 3 === 0) {
      const rows = Array.from({ length: 10 }, () => ({ cells: Array.from({ length: 5 }, () => t(words(r, 2))) }))
      out.push({ type: 'table', content: { type: 'tableContent', rows } as never })
    }
  }
  return out
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1)
}

const PAGES: [string, number, number, boolean][] = [
  ['small (5×6)', 5, 6, false],
  ['section-100 (3×100)', 3, 100, false],
  ['large (180×10+tables)', 180, 10, true],
]

for (const [name, secs, body, tables] of PAGES) {
  const base = editor.blocksToYDoc(build(secs, body, tables) as never, 'document')
  const state = Y.encodeStateAsUpdate(base)
  const ref = `sec-${Math.ceil(secs / 2)}`
  const N = Number(process.env.N || 15)
  const read: number[] = []
  const patch: number[] = []
  for (let i = 0; i < N + 1; i++) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    const r0 = performance.now()
    const blocks = readBlocks(doc)
    const s = findSection(splitSections(blocks), ref)!
    const md = (await blocksToMarkdown(blocks.slice(s.start, s.end), { assetMode: 'absolute', notation: 'agent' })).markdown.trim()
    const r1 = performance.now()
    const edited = md.replace(/^(?!#)(.*?)run/m, `$1RUN${i}`)
    const t0 = performance.now()
    const incoming = await markdownToBlocks(edited, noTitles)
    const cur = readBlocks(doc)
    const sec = findSection(splitSections(cur), ref)!
    const echo = await buildEchoIndex(cur.slice(sec.start, sec.end), noTitles, {}, incoming)
    const out = applySectionPatch(doc, ref, incoming, 'replace', undefined, echo)
    const t1 = performance.now()
    if (out.status !== 'ok') throw new Error('patch failed')
    if (i > 0) {
      read.push(r1 - r0)
      patch.push(t1 - t0)
    }
    doc.destroy()
  }
  const full = (await blocksToMarkdown(readBlocks(base), { assetMode: 'absolute', notation: 'agent' })).markdown
  const edited = full.replace(/^(?!#)(.*?)run/m, '$1RUN')
  const upd: Record<'rewrite' | 'minimal', number[]> = { rewrite: [], minimal: [] }
  const NU = Number(process.env.N || 8)
  for (let i = 0; i < NU + 1; i++) {
    for (const impl of ['rewrite', 'minimal'] as const) {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state)
      const t0 = performance.now()
      const incoming = await markdownToBlocks(edited, noTitles)
      blocksToStateBuffer(incoming)
      if (impl === 'rewrite') {
        const frag = doc.getXmlFragment('document')
        doc.transact(() => {
          frag.delete(0, frag.length)
          blocksToXmlFragment(incoming, frag)
        })
      } else {
        applyDocumentReplace(doc, incoming, await buildEchoIndex(readBlocks(doc), noTitles, {}, incoming))
      }
      if (i > 0) upd[impl].push(performance.now() - t0)
      doc.destroy()
    }
  }
  console.log(
    `${label}\t${name}\t${(state.length / 1024).toFixed(0)} KB\tread_page(section) p50 ${pct(read, 50)} p95 ${pct(read, 95)}\t` +
      `patch_section p50 ${pct(patch, 50)} p95 ${pct(patch, 95)}\tupdate_page rewrite p50 ${pct(upd.rewrite, 50)} / minimal p50 ${pct(upd.minimal, 50)} ms`,
  )
}
process.exit(0)
