// Derived indexes left behind by a crash are rebuilt at boot (docs/adr/1924-*), against a real
// database: a store committed a new state, the process died before the queued (debounced) index
// pass ran, so page_texts / page_chunks still describe the old state. The boot pass finds the page
// by page_chunk_index.doc_updated_at ≠ page_docs.updated_at and indexes it again; current pages and
// pages with a pass queued in this process are left alone.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-staleindex-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] boot re-index of pages a crash left stale', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { blocksToStateBuffer } = await import('./md/convert')
  const { flushDocIndexes, scheduleDocIndex } = await import('./docIndexer')
  const { reindexStalePages } = await import('./staleIndex')

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  let alice: U
  let wsId: string

  before(async () => {
    alice = await h.makeUser('Alice')
    wsId = (await h.makeWorkspace(alice)).id
  })
  after(async () => {
    await flushDocIndexes()
    await closeDb()
  })

  /** A page stored and indexed the way the collab store hook does it (stamp = page_docs.updated_at). */
  async function indexedPage(title: string, text: string): Promise<string> {
    const page = await h.makeDocPage(wsId, alice.id, title, [para(text)] as never)
    const [row] = (await db.execute(sql`SELECT state, updated_at::text AS stamp FROM page_docs WHERE page_id = ${page.id}`)) as unknown as { state: Buffer; stamp: string }[]
    await scheduleDocIndex(page.id, row.state, true, row.stamp)
    return page.id
  }

  /** What the store hook writes, then the crash: no index pass for the new state. */
  async function storeWithoutIndex(pageId: string, text: string): Promise<void> {
    await db.execute(sql`UPDATE page_docs SET state = ${blocksToStateBuffer([para(text)] as never)}, updated_at = now() WHERE page_id = ${pageId}`)
  }

  const bodyText = async (pageId: string) =>
    (await db.select({ text: schema.pageTexts.text }).from(schema.pageTexts).where(eq(schema.pageTexts.pageId, pageId)))[0]?.text ?? ''
  const chunkText = async (pageId: string) =>
    (await db.select({ text: schema.pageChunks.text }).from(schema.pageChunks).where(eq(schema.pageChunks.pageId, pageId))).map((c) => c.text).join('\n')

  it('a page whose stored state moved past its index is re-indexed; a current one is not', async () => {
    const stale = await indexedPage('Crashed', 'before the crash')
    const current = await indexedPage('Fine', 'nothing pending')
    await storeWithoutIndex(stale, 'after the crash')
    assert.match(await bodyText(stale), /before the crash/, 'precondition: the index is stale')

    const n = await reindexStalePages(() => {}, { pageIds: [stale, current], pauseMs: 0 })
    assert.equal(n, 1, 'only the stale page')
    assert.match(await bodyText(stale), /after the crash/)
    assert.match(await chunkText(stale), /after the crash/)
    assert.doesNotMatch(await chunkText(stale), /before the crash/)
    // the pass recorded the state it indexed: the next boot finds nothing
    assert.equal(await reindexStalePages(() => {}, { pageIds: [stale, current], pauseMs: 0 }), 0)
  })

  it('a page with an index pass already queued in this process is left to that pass', async () => {
    const id = await indexedPage('Queued', 'old text')
    await storeWithoutIndex(id, 'new text')
    const [row] = (await db.execute(sql`SELECT state, updated_at::text AS stamp FROM page_docs WHERE page_id = ${id}`)) as unknown as { state: Buffer; stamp: string }[]
    void scheduleDocIndex(id, row.state, false, row.stamp) // debounced: still pending
    assert.equal(await reindexStalePages(() => {}, { pageIds: [id], pauseMs: 0 }), 0)
    await flushDocIndexes()
    assert.match(await bodyText(id), /new text/)
  })
})
