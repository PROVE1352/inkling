// Smaller sync and permission edges of 0.15.1 (docs/adr/1923-*), against a real database:
//  - an ownership transfer is an access change: it bumps the workspace access version, so lock
//    chains and agent contexts cached under the old version are not served afterwards;
//  - duplicating a page copies what is on screen: an open document whose last edits are not
//    stored yet is stored (and indexed) first, so the copy does not lose up to ten seconds.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-syncedges-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] ownership transfer and duplicate of a live page', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Y = await import('yjs')
  const collab = await import('./collab')
  const { transferOwnership } = await import('./workspaceDeletion')
  const { docFromStoredState } = await import('./yState')
  const { stateToBlocks } = await import('./md/convert')
  const { blocksToPlainText } = await import('./md/textIndex')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  let O: U, M: U
  let wsId: string

  before(async () => {
    O = await h.makeUser('Owner')
    M = await h.makeUser('Member')
    wsId = (await h.makeWorkspace(O, [M])).id
  })

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const aclVersion = async (ws: string) =>
    Number(((await db.execute(sql`SELECT version FROM workspace_acl_versions WHERE workspace_id = ${ws}`)) as unknown as { version: number }[])[0]?.version ?? 0)

  it('transferring ownership bumps the workspace access version', async () => {
    const ws = (await h.makeWorkspace(O, [M])).id
    const before = await aclVersion(ws)
    await transferOwnership({ id: O.id, name: O.name }, ws, M.id)
    const [role] = await db.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers).where(sql`workspace_id = ${ws} AND user_id = ${M.id}`)
    assert.equal(role.role, 'owner')
    assert.ok((await aclVersion(ws)) > before, `access version moved (${before} → ${await aclVersion(ws)})`)
  })

  it('duplicating an open page copies its unsaved last edits, body text included', async () => {
    const page = await h.makeDocPage(wsId, O.id, 'Live original', [para('stored line')] as never)
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      // An edit applied to the live document without a store (as a client's edit inside the store
      // debounce): Hocuspocus schedules stores only for updates that came through a connection.
      const live = collab.hocuspocus.documents.get(page.id)!
      const fresh = new Y.Doc()
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(live))
      const group = fresh.getXmlFragment('document').get(0) as InstanceType<typeof Y.XmlElement>
      const container = new Y.XmlElement('blockContainer')
      container.setAttribute('id', 'unsaved-1')
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, 'typed seconds ago')
      p.insert(0, [t])
      container.insert(0, [p])
      group.insert(group.length, [container])
      Y.applyUpdate(live, Y.encodeStateAsUpdate(fresh, Y.encodeStateVector(live)))
      const [stored] = await db.select({ state: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, page.id))
      assert.doesNotMatch(blocksToPlainText(stateToBlocks(stored.state)), /typed seconds ago/, 'precondition: not stored yet')

      const r = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/duplicate`, headers: { cookie: O.cookie } })
      assert.equal(r.statusCode, 200, r.body)
      const copyId = (r.json() as { pages: { id: string }[] }).pages[0].id
      const [copy] = await db.select({ state: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, copyId))
      assert.match(blocksToPlainText(stateToBlocks(copy.state)), /typed seconds ago/, 'the copy has the unsaved edit')
      assert.ok(docFromStoredState(copy.state))
      const [text] = await db.select({ text: schema.pageTexts.text }).from(schema.pageTexts).where(eq(schema.pageTexts.pageId, copyId))
      assert.match(text?.text ?? '', /typed seconds ago/, 'and its search text')
      const chunks = await db.select({ text: schema.pageChunks.text }).from(schema.pageChunks).where(eq(schema.pageChunks.pageId, copyId))
      assert.ok(chunks.some((c) => c.text.includes('typed seconds ago')), 'and its section index')
    } finally {
      await conn.disconnect()
    }
  })
})
