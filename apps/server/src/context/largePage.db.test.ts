// Large-page robustness end to end (docs/adr/1040-1043): the section index covers the end of a long
// page, outline/section answer from the index only while it reflects the document (stored or live),
// unchanged stores are skipped, and the MCP tools add the large-page hint.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-largepage-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

/** A long experiment log in Markdown: `n` sections with a paragraph, a table and a list each. */
function logMarkdown(n: number, marker: string): string {
  const out = ['Experiment log for the large page test.', '']
  for (let i = 1; i <= n; i++) {
    out.push(`## Run ${String(i).padStart(3, '0')}`, '')
    out.push(`run ${i} ${'loss val epoch baseline 실험 결과 검증 '.repeat(40)}`, '')
    out.push('| metric | value | note |', '| --- | --- | --- |')
    for (let r = 0; r < 6; r++) out.push(`| m${r} | ${(i * 7 + r) % 100}.${r} | 비교 기준 ${r} |`)
    out.push('', `- item ${i} a`, `- item ${i} b`, '')
  }
  out.push('## Final check', '', `closing note ${marker}`, '')
  return out.join('\n')
}

describe('[db] large pages', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { liveDoc } = await import('../liveConnections')
  const { sectionSourceStats } = await import('./sectionSource')
  const { getServerEditor } = await import('../md/editor')
  const { LARGE_PAGE_HINT } = await import('./largePage')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const MARKER = 'zetamarker 최종검증표식'
  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  let bigId = ''
  let smallId = ''

  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.tool(name, args)
    assert.equal(r.isError, false, r.text)
    return r.text
  }
  const stats = () => ({ ...sectionSourceStats })
  const delta = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]).filter(([, v]) => v !== 0))

  before(async () => {
    owner = await h.makeUser('owner')
    ws = await h.makeWorkspace(owner, [])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    bigId = (JSON.parse(await tool('create_page', { workspaceId: ws.id, title: 'Big log', markdown: logMarkdown(140, MARKER) })) as { id: string }).id
    smallId = (JSON.parse(await tool('create_page', { workspaceId: ws.id, title: 'Small note', markdown: '## One\n\nshort body' })) as { id: string }).id
  })

  it('the section index covers the end of a page far past 200 KB; page_texts keeps head + tail', async () => {
    const [c] = (await db.execute(sql`
      SELECT count(DISTINCT anchor)::int AS anchors, sum(octet_length(text))::int AS bytes FROM page_chunks WHERE page_id = ${bigId}
    `)) as unknown as { anchors: number; bytes: number }[]
    assert.ok(c.bytes > 250 * 1024, `indexed ${c.bytes} bytes (the old cap was 200 KB)`)
    assert.equal(c.anchors, 142) // _intro + 140 runs + final check
    const [t] = (await db.execute(sql`SELECT text FROM page_texts WHERE page_id = ${bigId}`)) as unknown as { text: string }[]
    assert.ok(t.text.startsWith('Experiment log'))
    assert.ok(t.text.includes(MARKER), 'tail of the body is searchable')

    const fc = await tool('find_context', { query: 'zetamarker', workspaceId: ws.id })
    assert.match(fc, /§final-check/)
    // the plain search route finds the tail too
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/search?q=zetamarker`, headers: { cookie: owner.cookie } })
    assert.ok((res.json() as { pages: { id: string }[] }).pages.some((p) => p.id === bigId))
  })

  it('outline/section: decode once after a restart-like state, then from the index with identical output', async () => {
    // Created by the importer (indexed directly, no freshness record yet): the first read decodes
    // and adopts the index after comparing chunk hashes.
    const s0 = stats()
    const o1 = await tool('read_page', { pageId: bigId, outline: true })
    const s1 = stats()
    assert.deepEqual(delta(s0, s1), { outlineDecode: 1, adopted: 1 })
    const o2 = await tool('read_page', { pageId: bigId, outline: true })
    assert.deepEqual(delta(s1, stats()), { outlineIndex: 1 })
    assert.equal(o2, o1, 'same bytes from the index and from a decode')
    assert.match(o1, /§run-140 /)
    assert.match(o1, /§final-check /)

    const s2 = stats()
    const a = await tool('read_page', { pageId: bigId, section: 'run-070' })
    const b = await tool('read_page', { pageId: bigId, section: 'run-070' })
    assert.deepEqual(delta(s2, stats()), { sectionIndex: 1, cacheHits: 1 })
    assert.equal(a, b)
    assert.match(a, /\|\s*m5\s*\|\s*95\.5\s*\|/) // the table row of run 70 (70*7+5 = 495 → 95)
    // a section not in the index: same 404 text as before (anchor list)
    const miss = await mcp.tool('read_page', { pageId: bigId, section: 'no-such-section' })
    assert.equal(miss.isError, true)
    assert.match(miss.text, /Available anchors: _intro, run-001/)
  })

  it('a server-side write is in the index when it returns; the next outline needs no decode', async () => {
    await tool('update_page', { pageId: bigId, mode: 'append', markdown: '## Run 141\n\nappended entry' })
    const s0 = stats()
    const o = await tool('read_page', { pageId: bigId, outline: true })
    assert.deepEqual(delta(s0, stats()), { outlineIndex: 1 })
    assert.match(o, /§run-141 /)
    const sec = await tool('read_page', { pageId: bigId, section: 'run-141' })
    assert.match(sec, /appended entry/)

    await tool('patch_section', { pageId: bigId, section: 'run-002', mode: 'append', markdown: 'patched line' })
    const s1 = stats()
    const p = await tool('read_page', { pageId: bigId, section: 'run-002' })
    assert.deepEqual(delta(s1, stats()), { sectionIndex: 1 })
    assert.match(p, /patched line/)
  })

  it('an open document with unsaved edits is read from memory, never from the trailing index', async () => {
    const conn = await collab.hocuspocus.openDirectConnection(bigId)
    try {
      // Opening it changes nothing: still answered from the index.
      let s0 = stats()
      await tool('read_page', { pageId: bigId, outline: true })
      assert.deepEqual(delta(s0, stats()), { outlineIndex: 1 })

      // A person types (an update on the live doc; the store is debounced, the index trails).
      const live = liveDoc(bigId)!
      const editor = getServerEditor()
      const tmp = editor.blocksToYDoc(
        [
          { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Typed live', styles: {} }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'unsaved words', styles: {} }] },
        ] as never,
        'document',
      )
      const els = (tmp.getXmlFragment('document').get(0) as Y.XmlElement).toArray().map((c) => (c as Y.XmlElement).clone())
      const group = live.getXmlFragment('document').get(0) as Y.XmlElement
      live.transact(() => group.insert(group.length, els))
      tmp.destroy()

      s0 = stats()
      const o = await tool('read_page', { pageId: bigId, outline: true })
      assert.match(o, /§typed-live /)
      const sec = await tool('read_page', { pageId: bigId, section: 'typed-live' })
      assert.match(sec, /unsaved words/)
      assert.deepEqual(delta(s0, stats()), { outlineDecode: 1, sectionDecode: 1 })
      // an edit inside an existing section, after its Markdown was cached
      await tool('read_page', { pageId: bigId, section: 'run-003' })
      const target = group.toArray().find((el) => (el as Y.XmlElement).toString().includes('run 3 loss')) as Y.XmlElement
      const text = (target.get(0) as Y.XmlElement).get(0) as Y.XmlText
      live.transact(() => text.insert(0, 'EDITED '))
      assert.match(await tool('read_page', { pageId: bigId, section: 'run-003' }), /EDITED run 3/)
    } finally {
      await conn.disconnect()
    }
    // After the store and its index pass, the index reflects the edits again.
    await collab.flushDocIndexes()
    const s0 = stats()
    const o = await tool('read_page', { pageId: bigId, outline: true })
    assert.match(o, /§typed-live /)
    assert.match(await tool('read_page', { pageId: bigId, section: 'run-003' }), /EDITED run 3/)
    assert.equal(stats().outlineIndex - s0.outlineIndex, 1)
  })

  it('a store of an unchanged document writes nothing and keeps updated_at', async () => {
    const before = (await db.execute(sql`SELECT updated_at::text AS u FROM page_docs WHERE page_id = ${bigId}`)) as unknown as { u: string }[]
    const st0 = { ...collab.storeStats }
    const conn = await collab.hocuspocus.openDirectConnection(bigId)
    await conn.transact(() => {})
    await conn.disconnect()
    const after = (await db.execute(sql`SELECT updated_at::text AS u FROM page_docs WHERE page_id = ${bigId}`)) as unknown as { u: string }[]
    assert.equal(after[0].u, before[0].u)
    assert.equal(collab.storeStats.written - st0.written, 0)
    assert.ok(collab.storeStats.skipped - st0.skipped >= 2)
    // update_page append: one write (the disconnect store is skipped)
    const st1 = { ...collab.storeStats }
    await tool('update_page', { pageId: bigId, mode: 'append', markdown: 'one more line' })
    assert.equal(collab.storeStats.written - st1.written, 1)
  })

  it('large-page hint on read_page, find_context, update_page and patch_section; not on small pages', async () => {
    const outline = await tool('read_page', { pageId: bigId, outline: true })
    assert.ok(outline.includes(LARGE_PAGE_HINT))
    assert.ok((await tool('read_page', { pageId: bigId, section: 'run-010' })).includes(LARGE_PAGE_HINT))
    assert.ok((await tool('read_page', { pageId: bigId, maxChars: 500 })).includes(`- ${LARGE_PAGE_HINT}`))
    const upd = await tool('update_page', { pageId: bigId, mode: 'append', markdown: 'hint check' })
    assert.equal(upd, `Appended to the end of the body.\n${LARGE_PAGE_HINT}`)
    assert.ok((await tool('patch_section', { pageId: bigId, section: 'run-011', mode: 'append', markdown: 'x' })).endsWith(LARGE_PAGE_HINT))
    const fc = await tool('find_context', { query: 'zetamarker', workspaceId: ws.id })
    assert.match(fc, /; large page\)/)
    assert.match(fc, /Pages marked "large page": read it by section/)

    assert.ok(!(await tool('read_page', { pageId: smallId, outline: true })).includes('large page'))
    assert.equal(await tool('update_page', { pageId: smallId, mode: 'append', markdown: 'more' }), 'Appended to the end of the body.')
    // deterministic: same call, same bytes
    assert.equal(await tool('read_page', { pageId: bigId, outline: true }), await tool('read_page', { pageId: bigId, outline: true }))
  })
})
