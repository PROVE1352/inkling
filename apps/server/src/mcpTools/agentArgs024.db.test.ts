// Agent arguments as the tools print them (0.24.1): option names in view filters, `v=` versions,
// cursors and ids pasted from another tool's output, and the errors that say what to pass instead.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/agentArgs024.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent arguments as printed (0.24.1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const ws = await h.makeWorkspace(alice)
  const mcp = await h.connectMcp(app, alice, await h.mintToken(alice))
  after(async () => {
    await mcp.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })
  type U = typeof alice
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })

  it('create_view: select / multiSelect filter values by option name are stored as ids; unknown names list the options', async () => {
    const res = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Bugs' })
    assert.equal(res.statusCode, 200, res.body)
    const coll = res.json().page.id as string
    const put = await as(alice, 'PUT', `/pages/${coll}/collection/fields`, {
      fields: [
        { id: 'area', name: 'Area', type: 'select', options: [{ id: 'a1', name: 'Web', color: 'gray' }, { id: 'a3', name: 'QA', color: 'blue' }] },
        { id: 'tg', name: 'Tags', type: 'multiSelect', options: [{ id: 't1', name: 'UI', color: 'red' }, { id: 't2', name: 'API', color: 'blue' }] },
      ],
    })
    assert.equal(put.statusCode, 200, put.body)
    await db.insert(schema.pages).values(
      [
        { title: 'one', props: { area: 'a3', tg: ['t1'] } },
        { title: 'two', props: { area: 'a3', tg: ['t2'] } },
        { title: 'three', props: { area: 'a1', tg: ['t1', 't2'] } },
      ].map((r, i) => ({ workspaceId: ws.id, parentId: coll, title: r.title, createdBy: alice.id, kind: 'doc' as const, props: r.props, sortOrder: i })),
    )
    const viewsOf = async () =>
      (await as(alice, 'GET', `/pages/${coll}/collection?rows=0`)).json().collection.views as { id: string; name: string; config: Record<string, unknown> }[]
    const rowsOf = async (viewId: string) => {
      const view = (await viewsOf()).find((v) => v.id === viewId)!
      const r = await as(alice, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: { type: 'collection', collectionId: coll, viewId: view.id }, groupBy: { field: 'area' } })
      assert.equal(r.statusCode, 200, r.body)
      return r.json().rowCount as number
    }
    const idOf = (t: string) => /created: id (\S+)\./.exec(t)![1]

    // by name (case-insensitive), flat list
    const qa = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'QA', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'qa' }] } })
    assert.equal(qa.isError, false, qa.text)
    const qaView = (await viewsOf()).find((v) => v.id === idOf(qa.text))!
    assert.deepEqual(qaView.config.filters, [{ fieldId: 'area', op: 'eq', value: 'a3' }])
    assert.equal(await rowsOf(qaView.id), 2)
    // multiSelect contains, in the tree form with a group
    const tree = await mcp.tool('create_view', {
      collectionId: coll,
      type: 'table',
      name: 'UI or Web',
      config: { filter: { mode: 'or', items: [{ fieldId: 'Tags', op: 'contains', value: 'UI' }, { mode: 'and', items: [{ fieldId: 'Area', op: 'ne', value: 'QA' }] }] } },
    })
    assert.equal(tree.isError, false, tree.text)
    const treeView = (await viewsOf()).find((v) => v.id === idOf(tree.text))!
    assert.deepEqual(treeView.config.filter, { mode: 'or', items: [{ fieldId: 'tg', op: 'contains', value: 't1' }, { mode: 'and', items: [{ fieldId: 'area', op: 'ne', value: 'a3' }] }] })
    assert.equal(await rowsOf(treeView.id), 2)
    // ids as the web app stores them: unchanged
    const byId = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'Web', config: { filters: [{ fieldId: 'area', op: 'eq', value: 'a1' }] } })
    assert.equal(byId.isError, false, byId.text)
    const webView = (await viewsOf()).find((v) => v.id === idOf(byId.text))!
    assert.deepEqual(webView.config.filters, [{ fieldId: 'area', op: 'eq', value: 'a1' }])
    assert.equal(await rowsOf(webView.id), 1)
    // an unknown name: refused with the options, nothing written
    const before = (await viewsOf()).length
    const bad = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'Nope', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'Ops' }] } })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /filters: "Area" has no option "Ops"\. Options: "Web", "QA"\. Nothing was written\./)
    assert.equal((await viewsOf()).length, before)

    // a chart through a view whose filter keeps nothing says why it is empty
    const empty = await mcp.tool('create_view', { collectionId: coll, type: 'chart', name: 'Web UI', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'Web' }, { fieldId: 'Tags', op: 'eq', value: 'API' }, { fieldId: 'Tags', op: 'ne', value: 'API' }] }, chart: { kind: 'bar', groupBy: 'Area' } })
    assert.equal(empty.isError, false, empty.text)
    assert.match(empty.text, /no data \(0 rows\)/)
    assert.match(empty.text, /\nnote: no rows match the view's filter \(3 rows without it\)/)
    const doc = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Report', markdown: '## Charts\n\nbelow' })
    assert.equal(doc.isError, false, doc.text)
    const docId = /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(doc.text)![1]
    const chart = await mcp.tool('create_chart', { pageId: docId, collectionId: coll, view: 'Web UI', kind: 'bar', groupBy: 'Area' })
    assert.equal(chart.isError, false, chart.text)
    assert.match(chart.text, /\nnote: no rows match the view's filter \(3 rows without it\)\n/)
    // a view with rows: no note
    const full = await mcp.tool('create_chart', { pageId: docId, collectionId: coll, view: 'QA', kind: 'bar', groupBy: 'Area' })
    assert.equal(full.isError, false, full.text)
    assert.doesNotMatch(full.text, /note: no rows match/)
    // query_rows already takes option names in its filter
    const q = await mcp.tool('query_rows', { collectionId: coll, filter: 'Area = QA' })
    assert.equal(q.isError, false, q.text)
    assert.match(q.text, /one/)
    assert.match(q.text, /two/)
    assert.doesNotMatch(q.text, /three/)
  })
})
