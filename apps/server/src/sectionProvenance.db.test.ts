// Section marks (docs/adr/1627-*) against a real database: GET /pages/:id/section-provenance gives
// the newest logged change of each current section: an agent's patch (agent, via, the outline's
// heading block id), a person's later edit on top of it, nothing for removed sections or a new
// page, the new anchor after a heading rename, the same revert facts as GET /pages/:id/changes, the
// revert itself as the newest change, an accepted example suggestion as the accepting person's
// change; private pages 404 for other members, guests 403, locked pages still readable.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db --test-name-pattern="section provenance"
// run-tests: db-exclusive
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { SectionProvenanceDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] section provenance', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const collab = await import('./collab')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { drainChangeLog } = await import('./context/changeLog')
  const { readOutline } = await import('./context/sectionSource')
  const { bumpAcl } = await import('./aclVersion')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })

  let alice: U, bob: U, guest: U, stranger: U
  let wsId: string
  let A: Awaited<ReturnType<typeof h.connectMcp>> // alice's agent "Claude"

  async function newPage(title: string, blocks: unknown[], extra: Record<string, unknown> = {}) {
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never, extra)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const versionOf = async (pageId: string, anchor: string) =>
    ((await req(alice, 'GET', `/pages/${pageId}/outline`)).json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === anchor)!.version
  const agentPatch = async (pageId: string, section: string, mode: string, markdown: string) => {
    const baseVersion = mode === 'replace' || mode === 'delete' ? await versionOf(pageId, section) : undefined
    const r = await A.tool('patch_section', { pageId, section, mode, markdown, ...(baseVersion ? { baseVersion } : {}) })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
  }
  const personPatch = async (pageId: string, ref: string, mode: string, markdown: string, u: U = alice) => {
    const r = await req(u, 'POST', `/pages/${pageId}/section`, { ref, mode, markdown })
    assert.equal(r.statusCode, 200, r.body)
    await drainChangeLog()
  }
  const marks = async (pageId: string, u: U = alice) => {
    const r = await req(u, 'GET', `/pages/${pageId}/section-provenance`)
    assert.equal(r.statusCode, 200, r.body)
    return r.json().sections as SectionProvenanceDTO[]
  }
  const markOf = async (pageId: string, anchor: string) => (await marks(pageId)).find((m) => m.anchor === anchor)

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    guest = await h.makeUser('Guest')
    stranger = await h.makeUser('Stranger')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    A = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Claude'))
  })
  after(async () => {
    await A.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('a new page has no marks; a page that is not a document answers an empty list', async () => {
    const P = await newPage('Fresh', [heading('One'), para('a'), heading('Two'), para('b')])
    assert.deepEqual(await marks(P), [])
    const F = await newPage('Folder', [], { kind: 'folder' })
    assert.deepEqual(await marks(F), [])
  })

  it("an agent's patch marks its section with the client and the outline's heading block", async () => {
    const P = await newPage('Agent mark', [heading('Notes'), para('one'), heading('Other'), para('x')])
    await agentPatch(P, 'notes', 'append', 'agent line')
    const list = await marks(P)
    assert.deepEqual(list.map((m) => m.anchor), ['notes'], JSON.stringify(list))
    const m = list[0]
    assert.equal(m.agent, true)
    assert.equal(m.via, 'Claude')
    assert.equal(m.actor?.name, 'Alice')
    assert.equal(m.kind, 'modified')
    assert.equal(m.headingPath, 'Notes')
    const outline = await readOutline(P)
    assert.equal(m.blockId, outline.find((s) => s.anchor === 'notes')!.blockId)
    assert.ok(m.blockId)
    assert.ok(!Number.isNaN(Date.parse(m.changedAt)))
  })

  it('a person editing the same section afterwards is the newest mark', async () => {
    const P = await newPage('Person after agent', [heading('Notes'), para('one')])
    await agentPatch(P, 'notes', 'append', 'agent line')
    await personPatch(P, 'notes', 'append', 'bob line', bob)
    const m = (await markOf(P, 'notes'))!
    assert.equal(m.agent, false)
    assert.equal(m.via, null)
    assert.equal(m.actor?.name, 'Bob')
  })

  it('a removed section has no mark; a renamed heading is marked under its new anchor', async () => {
    const P = await newPage('Remove rename', [heading('Keep'), para('k'), heading('Gone'), para('g'), heading('Old name'), para('o')])
    await agentPatch(P, 'gone', 'delete', '')
    await personPatch(P, 'old-name', 'replace', '## New name\n\no')
    const list = await marks(P)
    const anchors = list.map((m) => m.anchor)
    assert.ok(!anchors.includes('gone'), JSON.stringify(list))
    assert.ok(!anchors.includes('old-name'), JSON.stringify(list))
    const renamed = list.find((m) => m.anchor === 'new-name')
    assert.ok(renamed, JSON.stringify(list))
    assert.equal(renamed.actor?.name, 'Alice')
    assert.equal(renamed.agent, false)
    const outline = await readOutline(P)
    assert.equal(renamed.blockId, outline.find((s) => s.anchor === 'new-name')!.blockId)
  })

  it('revert facts equal GET /pages/:id/changes; after a revert the revert is the newest change', async () => {
    const P = await newPage('Revert facts', [heading('Notes'), para('one'), para('two'), heading('Other'), para('x')])
    await agentPatch(P, 'notes', 'replace', 'one\n\nTWO by agent')
    await agentPatch(P, 'other', 'append', 'agent line')
    const before1 = await marks(P)
    const changes = (await req(alice, 'GET', `/pages/${P}/changes`)).json().items as { seq: string; revert: SectionProvenanceDTO }[]
    for (const m of before1) {
      const c = changes.find((x) => x.seq === m.seq)
      assert.ok(c, `seq ${m.seq} is in /changes`)
      assert.equal(m.revertable, c.revert.revertable)
      assert.deepEqual(m.revertedBy, c.revert.revertedBy)
      assert.equal(m.isRevert, c.revert.isRevert)
    }
    const notes = before1.find((m) => m.anchor === 'notes')!
    assert.equal(notes.revertable, true)
    assert.equal(notes.revertedBy, null)

    // the mark's seq is what "Revert this change" sends
    const run = await req(alice, 'POST', `/changes/${notes.seq}/revert`, {})
    assert.equal(run.statusCode, 200, run.body)
    assert.equal(run.json().pages[0].written, true)
    await drainChangeLog()
    const after1 = (await markOf(P, 'notes'))!
    assert.notEqual(after1.seq, notes.seq)
    assert.equal(after1.isRevert, true)
    assert.equal(after1.agent, false)
    assert.equal(after1.actor?.name, 'Alice')
    // the reverted change is still in the page's change list, marked reverted
    const all = (await req(alice, 'GET', `/pages/${P}/changes`)).json().items as { seq: string; revert: SectionProvenanceDTO }[]
    assert.equal(all.find((x) => x.seq === notes.seq)?.revert.revertedBy?.name, 'Alice')
    // the other section keeps the agent's mark
    assert.equal((await markOf(P, 'other'))?.via, 'Claude')
  })

  it("reverting a person's own fresh change keeps both rows: the revert is the newest mark", async () => {
    const P = await newPage('Own revert', [heading('Notes'), para('one')])
    await agentPatch(P, 'notes', 'append', 'agent line')
    await personPatch(P, 'notes', 'append', 'alice line')
    const m = (await markOf(P, 'notes'))!
    assert.equal(m.agent, false)
    assert.equal(m.revertable, true)
    const run = await req(alice, 'POST', `/changes/${m.seq}/revert`, {})
    assert.equal(run.statusCode, 200, run.body)
    await drainChangeLog()
    const after1 = (await markOf(P, 'notes'))!
    assert.notEqual(after1.seq, m.seq, 'the revert is not folded into the reverted row')
    assert.equal(after1.isRevert, true)
  })

  it('an accepted example suggestion is the accepting person, via null', async () => {
    const P = await newPage('Example accept', [heading('Diagrams'), para('d')])
    const outline = await readOutline(P)
    const sec = outline.find((s) => s.anchor === 'diagrams')!
    const [row] = await db
      .insert(schema.sectionSuggestions)
      .values({
        workspaceId: wsId,
        pageId: P,
        anchor: sec.anchor,
        blockId: sec.blockId,
        headingPath: 'Diagrams',
        baseVersion: sec.version,
        markdown: 'From the example agent.',
        mode: 'append',
        origin: 'asked',
        authorId: alice.id,
        via: 'Example agent',
        connection: 'example',
      })
      .returning()
    const acc = await req(alice, 'POST', `/suggestions/${row.id}/accept`, {})
    assert.equal(acc.statusCode, 200, acc.body)
    await drainChangeLog()
    const m = (await markOf(P, 'diagrams'))!
    assert.ok(m, 'the accepted suggestion left a mark')
    assert.equal(m.actor?.name, 'Alice')
    assert.equal(m.via, null)
    assert.equal(m.agent, false)
  })

  it('who may read: private pages 404 for other members and outsiders, guests 403, locked pages stay readable', async () => {
    const Priv = await newPage('Private', [heading('S'), para('a')], { scope: 'private' })
    await personPatch(Priv, 's', 'append', 'mine')
    assert.equal((await marks(Priv)).length, 1)
    assert.equal((await req(bob, 'GET', `/pages/${Priv}/section-provenance`)).statusCode, 404)
    assert.equal((await req(stranger, 'GET', `/pages/${Priv}/section-provenance`)).statusCode, 404)

    const Shared = await newPage('Shared', [heading('S'), para('a')])
    await agentPatch(Shared, 's', 'append', 'agent')
    assert.equal((await req(stranger, 'GET', `/pages/${Shared}/section-provenance`)).statusCode, 404)
    // a guest with edit access to the page (as PUT /pages/:id/access stores it)
    await db.insert(schema.pageGrants).values({ pageId: Shared, userId: guest.id, level: 'edit', createdBy: alice.id })
    await bumpAcl(db, wsId)
    assert.equal((await req(guest, 'GET', `/pages/${Shared}/lock`)).statusCode, 200, 'the guest can see the page')
    assert.equal((await req(guest, 'GET', `/pages/${Shared}/section-provenance`)).statusCode, 403)

    const lock = await req(alice, 'PUT', `/pages/${Shared}/lock`, { locked: true })
    assert.equal(lock.statusCode, 200, lock.body)
    const asBob = await marks(Shared, bob)
    assert.equal(asBob.length, 1)
    assert.equal(asBob[0].via, 'Claude')
  })
})
