// Large-page robustness (docs/adr/1040-1043): pure parts — no database, no server.
//   - page_texts keeps head + tail past its cap; the section index has no text cap
//   - outline rebuilt from index rows equals splitSections (anchors, heading paths, tokens, versions)
//   - a section read from a copy of its top-level range equals the slice of a whole-document read
//   - patch_section results are unchanged by the region-only dry run and read-back
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { chunkBlocks, MAX_CHUNK_TOKENS, PATH_SEP, splitSections } from './chunker'
import { blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { capPlainText, MAX_TEXT_BYTES, TEXT_CUT_MARK } from '../md/textIndex'
import { rangeBlocks, sectionsFromRows } from './sectionSource'
import { applySectionPatch, readBlocks } from './sectionPatch'
import { isLargePage, LARGE_PAGE_STATE_BYTES, LARGE_PAGE_TOKENS } from './largePage'

const editor = getServerEditor()
const t = (text: string) => [{ type: 'text', text, styles: {} }]
const p = (text: string): AnyBlock => ({ type: 'paragraph', content: t(text) as never })
const h = (text: string, level = 2): AnyBlock => ({ type: 'heading', props: { level }, content: t(text) as never })
const table = (rows: string[][]): AnyBlock => ({ type: 'table', content: { type: 'tableContent', rows: rows.map((r) => ({ cells: r.map((c) => t(c)) })) } as never })

/** A long log with nested headings, tables, a heading that contains the path separator and a giant line. */
function longLog(entries: number): AnyBlock[] {
  const out: AnyBlock[] = [p('intro of the log')]
  for (let i = 1; i <= entries; i++) {
    out.push(h(`Entry ${i}`, 2))
    out.push(p(`entry ${i} `.repeat(60) + '실험 결과 기록 '.repeat(30)))
    if (i % 3 === 0) out.push(table([['a', 'b', 'c'], [`x${i}`, 'y', 'z']]))
    if (i % 4 === 0) {
      out.push(h(`Details${PATH_SEP}of ${i}`, 3))
      out.push({ type: 'bulletListItem', content: t(`detail ${i}`) as never })
    }
    if (i % 25 === 0) out.push(p('w'.repeat(MAX_CHUNK_TOKENS * 6)))
  }
  out.push(h('Entry 1', 2)) // repeated path → ~2 anchor
  out.push(p('last words zetamarker'))
  return out
}

function readDoc(blocks: AnyBlock[]): { doc: Y.Doc; read: AnyBlock[] } {
  const doc = editor.blocksToYDoc(blocks as never, 'document')
  return { doc, read: readBlocks(doc) }
}

describe('page_texts head + tail', () => {
  it('keeps text under the cap as is', () => {
    const s = 'short text'
    assert.equal(capPlainText(s), s)
  })
  it('keeps the first and the last half past the cap, on character boundaries', () => {
    const s = `HEAD ${'가나다라 '.repeat(40_000)} TAIL-zetamarker`
    const out = capPlainText(s)
    assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_TEXT_BYTES)
    assert.ok(out.startsWith('HEAD '))
    assert.ok(out.endsWith('TAIL-zetamarker'))
    assert.ok(out.includes(TEXT_CUT_MARK))
    assert.ok(!out.includes('�'), 'no split characters')
  })
})

describe('section index covers the whole document', () => {
  it('indexes every section of a document far past 200 KB', () => {
    const { read } = readDoc(longLog(320))
    const sections = splitSections(read)
    const chunks = chunkBlocks(read)
    const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.text, 'utf8'), 0)
    assert.ok(bytes > 400 * 1024, `test document too small (${bytes})`)
    assert.deepEqual([...new Set(chunks.map((c) => c.anchor))], sections.map((s) => s.anchor))
    assert.ok(chunks[chunks.length - 1].text.includes('zetamarker'))
  })
})

describe('outline and section from the index', () => {
  it('rows rebuild the sections exactly (paths with the separator, repeated anchors, giant lines)', () => {
    const { read } = readDoc(longLog(60))
    const sections = splitSections(read)
    const rows = chunkBlocks(read).map((c) => ({ anchor: c.anchor, blockId: c.blockId, headingPath: c.headingPath, level: c.level, tokens: c.tokens, version: c.sectionHash }))
    const fromRows = sectionsFromRows(rows)!
    assert.equal(fromRows.length, sections.length)
    sections.forEach((s, i) => {
      const r = fromRows[i]
      assert.deepEqual(
        { anchor: r.anchor, blockId: r.blockId, headingPath: r.headingPath, level: r.level, tokens: r.tokens, version: r.version },
        { anchor: s.anchor, blockId: s.blockId, headingPath: s.headingPath, level: s.level, tokens: s.tokens, version: s.version },
        s.anchor,
      )
      assert.equal(r.nextBlockId, sections[i + 1]?.blockId ?? null)
    })
    assert.ok(sections.some((s) => s.headingPath[s.headingPath.length - 1]?.includes(PATH_SEP)))
    assert.ok(sections.some((s) => s.anchor.endsWith('~2')))
  })

  it('a section read from its top-level range equals the whole-document read', async () => {
    const { doc, read } = readDoc(longLog(30))
    const sections = splitSections(read)
    const rows = chunkBlocks(read).map((c) => ({ anchor: c.anchor, blockId: c.blockId, headingPath: c.headingPath, level: c.level, tokens: c.tokens, version: c.sectionHash }))
    const fromRows = sectionsFromRows(rows)!
    for (let i = 0; i < sections.length; i++) {
      const got = rangeBlocks(doc, fromRows[i].blockId, fromRows[i].nextBlockId)
      const want = read.slice(sections[i].start, sections[i].end)
      assert.deepEqual(got, want, sections[i].anchor)
      if (i % 7 === 0) {
        assert.equal(
          (await blocksToMarkdown(got!, { assetMode: 'absolute' })).markdown,
          (await blocksToMarkdown(want, { assetMode: 'absolute' })).markdown,
        )
      }
    }
  })

  it('rows at the index bound or out of shape are refused', () => {
    assert.equal(sectionsFromRows([{ anchor: 'a', blockId: null, headingPath: 'A', level: 2, tokens: 1, version: 'v' }]), null)
    assert.equal(
      sectionsFromRows([
        { anchor: 'a', blockId: 'x', headingPath: 'A', level: 1, tokens: 1, version: 'v' },
        { anchor: '_intro', blockId: null, headingPath: '', level: 0, tokens: 1, version: 'w' },
      ]),
      null,
    )
  })
})

describe('patch_section region-only work', () => {
  it('same blocks, sections and versions as a whole-document read after each mode', async () => {
    for (const mode of ['replace', 'append', 'prepend', 'insert_after', 'delete'] as const) {
      const doc = editor.blocksToYDoc(longLog(12) as never, 'document')
      const incoming = mode === 'delete' ? [] : await markdownToBlocks(mode === 'replace' ? 'new body for six\n\n- one\n- two' : 'added line', () => null)
      const res = applySectionPatch(doc, 'entry-6', incoming, mode, undefined)
      assert.equal(res.status, 'ok', mode)
      if (res.status !== 'ok') continue
      const full = splitSections(readBlocks(doc))
      assert.deepEqual(
        res.sections.map((s) => [s.anchor, s.version, s.start, s.end]),
        full.map((s) => [s.anchor, s.version, s.start, s.end]),
        mode,
      )
    }
  })
})

describe('large page threshold', () => {
  it('state bytes or indexed tokens', () => {
    assert.equal(isLargePage(LARGE_PAGE_STATE_BYTES - 1, LARGE_PAGE_TOKENS - 1), false)
    assert.equal(isLargePage(LARGE_PAGE_STATE_BYTES, 0), true)
    assert.equal(isLargePage(0, LARGE_PAGE_TOKENS), true)
    assert.equal(isLargePage(null, null), false)
  })
})
