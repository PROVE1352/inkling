// [db] Link islands and unlinked pages (docs/adr/1123-*): GET /workspaces/:id/graph/islands —
// components, trash, collection rows, folders, private pages per viewer, non-members, and the
// version key (ETag) after a link is deleted.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-islands-${process.pid}`

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] link islands and unlinked pages', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const { AppError } = await import('./errors')
  const { reindexPageLinks } = await import('./md/linkIndex')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => (await import('./routes/graph')).registerGraphRoutes(api), { prefix: '/api' })
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Islands = import('./linkIslands').LinkIslands
  const get = (u: U, ws: string, etag?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/graph/islands`,
      headers: { cookie: u.cookie, ...(etag ? { 'if-none-match': etag } : {}) },
    })
  const link = (ws: string, to: string[]) => [
    {
      type: 'paragraph',
      content: to.map((id) => ({ type: 'link', href: `/w/${ws}/p/${id}`, content: [{ type: 'text', text: 'x', styles: {} }] })),
    },
  ]
  const page = async (ws: string, by: string, title: string, extra: Record<string, unknown> = {}) =>
    (await h.makeDocPage(ws, by, title, [{ type: 'paragraph', content: [] }], extra)).id
  const setLinks = (ws: string, from: string, to: string[]) => reindexPageLinks(from, link(ws, to) as never)
  const islandSets = (r: Islands) => r.islands.map((i) => new Set(i.pageIds))

  it('components, unlinked pages, trash, folders and collection rows', async () => {
    const u = await h.makeUser('isl')
    const ws = (await h.makeWorkspace(u)).id
    const [a, b, c, d, e, f] = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F'].map((t) => page(ws, u.id, t)))
    const folder = await page(ws, u.id, 'Folder', { kind: 'folder' })
    const coll = await page(ws, u.id, 'Table', { kind: 'collection' })
    const row = await page(ws, u.id, 'Row 1', { parentId: coll })
    const trashed = await page(ws, u.id, 'Old')
    await setLinks(ws, a, [b])
    await setLinks(ws, c, [b]) // direction does not matter: A–B–C is one island
    await setLinks(ws, d, [e])
    await setLinks(ws, row, [f]) // a row's link is not an edge: rows are not in the graph
    await setLinks(ws, trashed, [f]) // nor is a trashed page's
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, trashed))

    const r = await get(u, ws)
    assert.equal(r.statusCode, 200, r.body)
    const body = r.json() as Islands
    assert.deepEqual(islandSets(body), [new Set([a, b, c]), new Set([d, e])])
    assert.equal(body.islands[0].hub.id, b, 'the most linked page names the island')
    const unlinked = body.unlinked.map((p) => p.id).sort()
    assert.deepEqual(unlinked, [coll, f].sort(), 'F has only links from a row and a trashed page; folders are not listed')
    assert.equal(body.unlinkedTotal, 2)
    assert.ok(!body.unlinked.some((p) => p.id === folder))
    assert.equal(body.links, 3)
  })

  it("a private page's links count only for its author; other members see the target as unlinked", async () => {
    const owner = await h.makeUser('own')
    const other = await h.makeUser('oth')
    const ws = (await h.makeWorkspace(owner, [other])).id
    const target = await page(ws, owner.id, 'Shared target')
    const secret = await page(ws, owner.id, 'Private notes', { scope: 'private' })
    await setLinks(ws, secret, [target])

    const mine = (await get(owner, ws)).json() as Islands
    assert.deepEqual(islandSets(mine), [new Set([secret, target])])
    assert.equal(mine.unlinkedTotal, 0)

    const theirs = (await get(other, ws)).json() as Islands
    assert.deepEqual(theirs.islands, [])
    assert.deepEqual(theirs.unlinked.map((p) => p.id), [target])
    assert.ok(!JSON.stringify(theirs).includes(secret), 'the private page appears nowhere for another member')
  })

  it('non-members get 403', async () => {
    const owner = await h.makeUser('o2')
    const stranger = await h.makeUser('st')
    const ws = (await h.makeWorkspace(owner)).id
    assert.equal((await get(stranger, ws)).statusCode, 403)
  })

  it('a deleted link changes the version key: no stale 304, the island splits', async () => {
    const u = await h.makeUser('ver')
    const ws = (await h.makeWorkspace(u)).id
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((t) => page(ws, u.id, t)))
    await setLinks(ws, a, [b, c])
    const first = await get(u, ws)
    const etag = String(first.headers.etag)
    assert.deepEqual(islandSets(first.json() as Islands), [new Set([a, b, c])])
    // Unchanged graph: 304 from the version key alone.
    assert.equal((await get(u, ws, etag)).statusCode, 304)
    // A drops its link to C (union-find cannot undo a union; the list is recomputed).
    await setLinks(ws, a, [b])
    const second = await get(u, ws, etag)
    assert.equal(second.statusCode, 200)
    const body = second.json() as Islands
    assert.deepEqual(islandSets(body), [new Set([a, b])])
    assert.deepEqual(body.unlinked.map((p) => p.id), [c])
  })
})
