// Table column widths are part of the view config (docs/adr/1351-*): saved and read back through
// PATCH /collection-views/:id, bounded by the table's column minimums, replaced with the config.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] collection view column widths', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
  const collab = await import('./collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('owner')
  const ws = await h.makeWorkspace(owner)
  const req = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: owner.cookie }, payload: payload as object })

  const created = await req('POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Widths' })
  assert.equal(created.statusCode, 200, created.body)
  const collId = created.json().page.id as string
  const fields = await req('PUT', `/pages/${collId}/collection/fields`, {
    fields: [
      { id: 'status', name: 'Status', type: 'text' },
      { id: 'owner', name: 'Owner', type: 'person' },
    ],
  })
  assert.equal(fields.statusCode, 200, fields.body)
  const viewId = (await req('GET', `/pages/${collId}/collection`)).json().collection.views[0].id as string
  const patch = (config: unknown) => req('PATCH', `/collection-views/${viewId}`, { config })
  const stored = async () =>
    (await req('GET', `/pages/${collId}/collection`)).json().collection.views.find((v: { id: string }) => v.id === viewId).config

  it('stores field widths and the title width with the rest of the config', async () => {
    const config = { sorts: [{ fieldId: 'status', dir: 'asc' }], columnWidths: { status: 320, owner: 150 }, titleWidth: 400 }
    const res = await patch(config)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().view.config, config)
    assert.deepEqual(await stored(), config)
  })

  it('refuses widths under the column minimums or over the maximum', async () => {
    for (const bad of [
      { columnWidths: { status: 149 } },
      { columnWidths: { status: 1601 } },
      { columnWidths: { status: 200.5 } },
      { titleWidth: 239 },
      { columnWidths: { '': 200 } },
      { columnWidths: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, 200])) },
    ]) {
      const res = await patch(bad)
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad).slice(0, 60)} → ${res.statusCode}`)
    }
    // nothing was written by the refused requests
    assert.equal((await stored()).titleWidth, 400)
  })

  it('a config without widths replaces them (the config is replaced as a whole, as before)', async () => {
    const res = await patch({ sorts: [] })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(await stored(), { sorts: [] })
  })
})
