// Per-user sidebar menu order / hidden menus (docs/adr/1020-*): GET/PUT /me/sidebar, the copy on
// /auth/me, validation, reset to default and isolation between users.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-sidebar-${process.pid}`

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] sidebar menu preferences', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const app = await h.buildTestApp()

  // /auth/me lives in the auth routes, which the shared harness does not mount.
  const Fastify = (await import('fastify')).default
  const authApp = Fastify()
  await authApp.register(import('@fastify/cookie'))
  await authApp.register(async (api) => (await import('./routes/auth')).registerAuthRoutes(api), { prefix: '/api' })
  await authApp.ready()

  after(async () => {
    await collab.destroyCollab()
    await authApp.close()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const get = (u: U) => app.inject({ method: 'GET', url: '/api/me/sidebar', headers: { cookie: u.cookie } })
  const put = (u: U, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/me/sidebar', headers: { cookie: u.cookie }, payload: payload as object })
  const stored = async (u: U) =>
    (await db.select({ p: schema.users.sidebarPrefs }).from(schema.users).where(eq(schema.users.id, u.id)))[0]?.p

  it('defaults to empty lists and stores nothing until customized', async () => {
    const u = await h.makeUser('fresh')
    const r = await get(u)
    assert.equal(r.statusCode, 200)
    assert.deepEqual(r.json(), { order: [], hidden: [] })
    assert.equal(await stored(u), null)
  })

  it('saves and reads back order and hidden; /auth/me carries the same value', async () => {
    const u = await h.makeUser('saver')
    const body = { order: ['today', 'search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity'], hidden: ['tags', 'activity'] }
    const w = await put(u, body)
    assert.equal(w.statusCode, 200)
    assert.deepEqual(w.json(), body)
    assert.deepEqual((await get(u)).json(), body)
    assert.deepEqual(await stored(u), body)

    const me = await authApp.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })
    assert.equal(me.statusCode, 200)
    assert.deepEqual((me.json() as { user: { sidebar: unknown } }).user.sidebar, body)
  })

  it('both lists empty resets to the default (row value NULL)', async () => {
    const u = await h.makeUser('reset')
    await put(u, { order: ['graph', 'search'], hidden: ['due'] })
    const r = await put(u, { order: [], hidden: [] })
    assert.equal(r.statusCode, 200)
    assert.equal(await stored(u), null)
    assert.deepEqual((await get(u)).json(), { order: [], hidden: [] })
  })

  it('accepts well-formed ids it does not know (a newer client), dedupes, keeps first occurrence', async () => {
    const u = await h.makeUser('future')
    const r = await put(u, { order: ['inbox', 'search', 'search', 'graph'], hidden: ['inbox', 'inbox'] })
    assert.equal(r.statusCode, 200)
    assert.deepEqual(r.json(), { order: ['inbox', 'search', 'graph'], hidden: ['inbox'] })
  })

  it('rejects malformed bodies with 400 and leaves the stored value alone', async () => {
    const u = await h.makeUser('bad')
    const good = { order: ['graph'], hidden: ['search'] }
    await put(u, good)
    const tooMany = Array.from({ length: 33 }, (_, i) => `m${i}`)
    const cases: unknown[] = [
      {},
      { order: ['graph'] },
      { order: 'graph', hidden: [] },
      { order: [1], hidden: [] },
      { order: ['Graph'], hidden: [] },
      { order: ['has space'], hidden: [] },
      { order: ['x'.repeat(33)], hidden: [] },
      { order: [''], hidden: [] },
      { order: tooMany, hidden: [] },
      { order: [], hidden: tooMany },
    ]
    for (const c of cases) {
      const r = await put(u, c)
      assert.equal(r.statusCode, 400, `expected 400 for ${JSON.stringify(c).slice(0, 80)}`)
    }
    assert.deepEqual(await stored(u), good)
  })

  it('is per user: one person’s change never shows for another', async () => {
    const a = await h.makeUser('alice')
    const b = await h.makeUser('bob')
    const ws = await h.makeWorkspace(a, [b])
    assert.ok(ws.id)
    await put(a, { order: ['calendar', 'search'], hidden: ['graph'] })
    assert.deepEqual((await get(b)).json(), { order: [], hidden: [] })
    await put(b, { order: [], hidden: ['today'] })
    assert.deepEqual((await get(a)).json(), { order: ['calendar', 'search'], hidden: ['graph'] })
    assert.deepEqual((await get(b)).json(), { order: [], hidden: ['today'] })
  })

  it('needs a browser session: no cookie → 401, an agent token → 403', async () => {
    const u = await h.makeUser('agentless')
    assert.equal((await app.inject({ method: 'GET', url: '/api/me/sidebar' })).statusCode, 401)
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/api/me/sidebar', payload: { order: [], hidden: [] } })).statusCode,
      401,
    )
    // An agent's request as the MCP server makes it (bearer + internal header) still gets no access.
    const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('./oauth')
    const token = await h.mintToken(u)
    const auth = { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }
    assert.equal((await app.inject({ method: 'GET', url: '/api/me/sidebar', headers: auth })).statusCode, 403)
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/api/me/sidebar', headers: auth, payload: { order: [], hidden: ['search'] } }))
        .statusCode,
      403,
    )
    assert.equal(await stored(u), null)
  })
})
