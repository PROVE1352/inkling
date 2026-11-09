// Collection structure tools and create_row links against a real database (docs/adr/1523-*,
// 1524-*): create_collection / update_fields map name-based specs onto the shared field schema and
// write through PUT /collection/fields (relation targets, hidden targets, two-way pairing, edit
// lock, write gate); create_row writes relation links in the row's own transaction (AGENT-C2).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] collection structure tools and create_row links', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNull, sql } = await import('drizzle-orm')
  type CollectionField = import('@inkling/shared').CollectionField

  const app = await h.buildTestApp()
  const owner = await h.makeUser('Olivia')
  const mia = await h.makeUser('Mia')
  const leo = await h.makeUser('Leo')
  const ws = await h.makeWorkspace(owner, [mia, leo])
  const M = await h.connectMcp(app, mia, await h.mintToken(mia, 'notes', 'Mia Agent'), { user: { ...mia, via: 'Mia Agent' } })
  const RO = await h.connectMcp(app, mia, await h.mintToken(mia, 'read'), { canWrite: false })
  after(async () => {
    await M.close()
    await RO.close()
    await app.close()
    await closeDb()
  })

  const req = (u: { cookie: string }, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const fieldsOf = async (id: string) =>
    ((await db.select({ f: schema.collections.fields }).from(schema.collections).where(eq(schema.collections.pageId, id)))[0]?.f ?? []) as CollectionField[]
  const idIn = (t: string, re: RegExp) => {
    const m = re.exec(t)
    assert.ok(m, `no id in ${t}`)
    return m[1]
  }
  const liveCount = async (title: string) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(and(eq(schema.pages.title, title), isNull(schema.pages.deletedAt))))[0].n

  let projects: string
  let tasks: string

  it('create_collection: name-based specs become the stored fields in one call', async () => {
    const p = await M.tool('create_collection', {
      workspaceId: ws.id,
      title: 'Projects',
      fields: [
        { name: 'Status', type: 'select', options: ['Todo', { name: 'Done', color: 'green' }] },
        { name: 'Due', type: 'date' },
        { name: 'Lead', type: 'person' },
      ],
    })
    assert.equal(p.isError, false, p.text)
    projects = idIn(p.text, /Created collection ([0-9a-f-]{36})/)
    assert.match(p.text, /- Status \(select: Todo, Done\) #[0-9a-f]{8}/)
    const f = await fieldsOf(projects)
    assert.deepEqual(f.map((x) => [x.name, x.type]), [['Status', 'select'], ['Due', 'date'], ['Lead', 'person']])
    assert.equal(f[0].options![1].color, 'green')

    const t = await M.tool('create_collection', {
      workspaceId: ws.id,
      title: 'Tasks',
      fields: [
        { name: 'Done', type: 'checkbox' },
        { name: 'Project', type: 'relation', target: projects, twoWay: true },
        { name: 'Project status', type: 'rollup', relation: 'Project', property: 'Status', fn: 'showUnique' },
      ],
    })
    assert.equal(t.isError, false, t.text)
    tasks = idIn(t.text, /Created collection ([0-9a-f-]{36})/)
    const tf = await fieldsOf(tasks)
    const rel = tf.find((x) => x.name === 'Project')!
    assert.equal(rel.relation?.targetPageId, projects)
    assert.ok(rel.relation?.pairFieldId, 'two-way pairing done by the route')
    assert.equal(tf.find((x) => x.name === 'Project status')!.rollup?.relationFieldId, rel.id)
    assert.ok((await fieldsOf(projects)).some((x) => x.id === rel.relation!.pairFieldId && x.type === 'relation'))
  })

  it('create_collection: a bad spec or a hidden target writes nothing; read-only tokens are refused', async () => {
    const priv = await req(leo, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Leo private db', scope: 'private' })
    assert.equal(priv.statusCode, 200, priv.body)
    const hidden = priv.json().page.id as string
    const r = await M.tool('create_collection', { workspaceId: ws.id, title: 'Never made', fields: [{ name: 'X', type: 'relation', target: hidden }] })
    assert.equal(r.isError, true)
    assert.match(r.text, /not found/)
    const r2 = await M.tool('create_collection', { workspaceId: ws.id, title: 'Never made', fields: [{ name: 'R', type: 'rollup', relation: 'Nope', fn: 'count' }] })
    assert.equal(r2.isError, true)
    assert.match(r2.text, /no relation property "Nope"/)
    const r3 = await M.tool('create_collection', { workspaceId: ws.id, title: 'Never made', fields: [{ name: 'A', type: 'text' }, { name: 'a', type: 'number' }] })
    assert.equal(r3.isError, true)
    assert.equal(await liveCount('Never made'), 0)
    const ro = await RO.tool('create_collection', { workspaceId: ws.id, title: 'Never made', fields: [] })
    assert.equal(ro.isError, true)
    assert.match(ro.text, /read-only/)
  })

  it('update_fields: add, rename, options keep their ids, order; one write; errors write nothing', async () => {
    const before = await fieldsOf(projects)
    const todoId = before[0].options!.find((o) => o.name === 'Todo')!.id
    const r = await M.tool('update_fields', {
      collectionId: projects,
      add: [{ name: 'Budget', type: 'number' }],
      change: [
        { field: 'Status', addOptions: ['Doing'], removeOptions: ['Done'] },
        { field: 'Due', name: 'Deadline' },
      ],
      order: ['Budget'],
    })
    assert.equal(r.isError, false, r.text)
    const f = await fieldsOf(projects)
    assert.equal(f[0].name, 'Budget')
    assert.ok(f.some((x) => x.name === 'Deadline' && x.type === 'date'))
    const status = f.find((x) => x.name === 'Status')!
    assert.deepEqual(status.options!.map((o) => o.name), ['Todo', 'Doing'])
    assert.equal(status.options![0].id, todoId)

    const bad = await M.tool('update_fields', { collectionId: tasks, remove: ['Project'] })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /used by rollup "Project status"/)
    const bad2 = await M.tool('update_fields', { collectionId: projects, change: [{ field: 'Lead', addOptions: ['x'] }] })
    assert.equal(bad2.isError, true)
    assert.deepEqual(await fieldsOf(projects), f, 'nothing written')

    const both = await M.tool('update_fields', { collectionId: tasks, remove: ['Project status', 'Project'] })
    assert.equal(both.isError, false, both.text)
    assert.deepEqual((await fieldsOf(tasks)).map((x) => x.name), ['Done'])
    // the partner on Projects became one-way (links kept), as the route does for the web app
    const partner = (await fieldsOf(projects)).find((x) => x.type === 'relation')!
    assert.equal(partner.relation?.twoWay, false)
  })

  it('update_fields and create_collection respect the edit lock', async () => {
    const folder = await req(leo, 'POST', '/pages', { workspaceId: ws.id, title: 'Leo locked folder' })
    const F = folder.json().page.id as string
    const coll = await req(leo, 'POST', '/pages', { workspaceId: ws.id, parentId: F, kind: 'collection', title: 'Locked db' })
    const L = coll.json().page.id as string
    const lock = await req(owner, 'PUT', `/pages/${F}/lock`, { locked: true, editorIds: [] })
    assert.equal(lock.statusCode, 200, lock.body)
    const u = await M.tool('update_fields', { collectionId: L, add: [{ name: 'X', type: 'text' }] })
    assert.equal(u.isError, true)
    assert.match(u.text, /PAGE_LOCKED/)
    const c = await M.tool('create_collection', { workspaceId: ws.id, parentId: F, title: 'Inside lock', fields: [{ name: 'X', type: 'text' }] })
    assert.equal(c.isError, true)
    assert.equal(await liveCount('Inside lock'), 0)
  })

  it('create_row: relation links are written with the row (two-way mirrored), or no row at all', async () => {
    const a = await M.tool('create_collection', { workspaceId: ws.id, title: 'Clients', fields: [{ name: 'Tier', type: 'text' }] })
    const clients = idIn(a.text, /Created collection ([0-9a-f-]{36})/)
    const b = await M.tool('create_collection', { workspaceId: ws.id, title: 'Deals', fields: [{ name: 'Client', type: 'relation', target: clients, twoWay: true }] })
    const deals = idIn(b.text, /Created collection ([0-9a-f-]{36})/)
    const acme = await M.tool('create_row', { collectionId: clients, title: 'Acme' })
    assert.equal(acme.isError, false, acme.text)
    const acmeId = idIn(acme.text, /Created row ([0-9a-f-]{36})/)

    const d = await M.tool('create_row', { collectionId: deals, title: 'Deal 1', properties: { Client: ['Acme'] } })
    assert.equal(d.isError, false, d.text)
    const dealId = idIn(d.text, /Created row ([0-9a-f-]{36})/)
    const relId = (await fieldsOf(deals))[0].id
    const pairId = (await fieldsOf(deals))[0].relation!.pairFieldId!
    const dealProps = (await db.select({ p: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, dealId)))[0].p as Record<string, unknown>
    assert.deepEqual(dealProps[relId], [acmeId])
    const acmeProps = (await db.select({ p: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, acmeId)))[0].p as Record<string, unknown>
    assert.deepEqual(acmeProps[pairId], [dealId], 'two-way link mirrored in the same write')

    // the linked row becomes uneditable for Mia (locked by Leo, who owns a row there): no half-made row
    const leoRow = await req(leo, 'POST', `/pages/${clients}/collection/rows`, { title: 'Leo client' })
    assert.equal(leoRow.statusCode, 200, leoRow.body)
    const leoRowId = leoRow.json().row.id as string
    const lk = await req(owner, 'PUT', `/pages/${leoRowId}/lock`, { locked: true, editorIds: [] })
    assert.equal(lk.statusCode, 200, lk.body)
    const rows = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(eq(schema.pages.parentId, deals)))[0].n
    const n0 = await rows()
    const fail = await M.tool('create_row', { collectionId: deals, title: 'Deal 2', properties: { Client: [leoRowId] } })
    assert.equal(fail.isError, true, fail.text)
    assert.match(fail.text, /PAGE_LOCKED/)
    assert.equal(await rows(), n0, 'no row without its links')
    assert.equal(await liveCount('Deal 2'), 0)
  })
})
