// Live typing attribution (CF-2, docs/adr/1625-*) against a real database: an index pass logs the
// typing of its window as the one person who typed, or nobody's when several did; a server edit
// (an agent's patch) first logs the typing not indexed yet, so the agent's change row holds only
// the agent's change.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] typing attribution in the change log', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { asc, eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('./chunkIndex')
  const { drainChangeLog } = await import('./changeLog')
  const { hasPendingTyping, noteLiveEdit } = await import('./attribution')
  const { scheduleDocIndex } = await import('../docIndexer')
  const { blocksToStateBuffer } = await import('../md/convert')
  const { applySectionPatch } = await import('./sectionPatch')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  let alice: U, bob: U
  let wsId: string

  async function newPage(title: string, blocks: unknown[]) {
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const rows = async (pageId: string) =>
    (await db.select().from(schema.pageChanges).where(eq(schema.pageChanges.pageId, pageId)).orderBy(asc(schema.pageChanges.seq))).filter(
      (r) => r.kind !== 'page_added',
    )

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(alice, [bob])).id
  })
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('one typist in the window → their row; two → nobody', async () => {
    const blocks = [heading('A'), para('a'), heading('B'), para('b')]
    const P = await newPage('Typing one', blocks)
    noteLiveEdit(P, bob.id)
    await scheduleDocIndex(P, blocksToStateBuffer([heading('A'), para('a typed'), heading('B'), para('b')] as never), true)
    await drainChangeLog()
    let r = await rows(P)
    assert.equal(r.length, 1)
    assert.equal(r[0].actorId, bob.id)
    assert.equal(r[0].viaClient, null)

    noteLiveEdit(P, bob.id)
    noteLiveEdit(P, alice.id)
    await scheduleDocIndex(P, blocksToStateBuffer([heading('A'), para('a typed'), heading('B'), para('b typed')] as never), true)
    await drainChangeLog()
    r = await rows(P)
    assert.equal(r.length, 2)
    assert.equal(r[1].anchor, 'b')
    assert.equal(r[1].actorId, null, 'two people typed: not attributed')
  })

  it("an agent's write logs the pending typing first, as the typist's", async () => {
    const P = await newPage('Typing before agent', [heading('Mine'), para('person text'), heading('Agent'), para('agent text')])
    const agent = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Claude'))
    // keep the document open and type into it without a store or an index pass
    const conn = await collab.hocuspocus.openDirectConnection(P)
    try {
      const doc = collab.hocuspocus.documents.get(P)!
      const typed = await import('../md/convert').then((m) => m.markdownToBlocks('person typed more', () => null))
      doc.transact(() => {
        applySectionPatch(doc, 'mine', typed, 'append', undefined)
      })
      noteLiveEdit(P, bob.id)
      assert.equal(hasPendingTyping(P), true)
      const r = await agent.tool('patch_section', { pageId: P, section: 'agent', mode: 'append', markdown: 'agent added' })
      assert.equal(r.isError, false, r.text)
    } finally {
      await conn.disconnect()
      await agent.close()
    }
    await drainChangeLog()
    const r = await rows(P)
    const mine = r.find((x) => x.anchor === 'mine')!
    const ag = r.find((x) => x.anchor === 'agent')!
    assert.ok(mine && ag, JSON.stringify(r))
    assert.equal(mine.actorId, bob.id, 'the typing is the typist\'s')
    assert.equal(mine.viaClient, null)
    assert.equal(ag.viaClient, 'Claude')
    assert.doesNotMatch(ag.afterText ?? '', /person typed more/)
    assert.equal(r.filter((x) => x.viaClient === 'Claude').length, 1, 'the agent row holds only the agent edit')
  })
})
