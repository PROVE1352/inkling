// PATCH /pages/:id/props must not tell someone outside the workspace that a row exists: the answer for
// a real row id equals the answer for an id that does not exist (docs/adr/1301-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] row props: no existence oracle for non-members', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const collab = await import('./collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('owner')
  const outsider = await h.makeUser('outsider')
  const ws = await h.makeWorkspace(owner)
  const [coll] = await db
    .insert(schema.pages)
    .values({ workspaceId: ws.id, createdBy: owner.id, kind: 'collection', title: 'Roadmap' })
    .returning()
  await db.insert(schema.collections).values({ pageId: coll.id, fields: [{ id: 'label', name: 'Label', type: 'text' }] })
  const [row] = await db
    .insert(schema.pages)
    .values({ workspaceId: ws.id, createdBy: owner.id, kind: 'doc', title: 'Row', parentId: coll.id, props: { label: 'a' } })
    .returning()

  const patch = (who: { cookie: string }, id: string) =>
    app.inject({ method: 'PATCH', url: `/api/pages/${id}/props`, headers: { cookie: who.cookie }, payload: { props: { label: 'x' } } })

  it('a real row and a missing id get the same 404', async () => {
    const real = await patch(outsider, row.id)
    const missing = await patch(outsider, randomUUID())
    assert.equal(real.statusCode, 404, real.body)
    assert.equal(missing.statusCode, 404, missing.body)
    assert.deepEqual(real.json(), missing.json())
    // nothing was written
    const res = await patch(owner, row.id)
    assert.equal(res.statusCode, 200, res.body)
  })
})
