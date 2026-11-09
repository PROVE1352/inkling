// Ink PUT refuses a blind wipe (docs/adr/1340-*): a save without `expectedUpdatedAt` that would turn
// non-empty ink into an empty list answers 412 INK_CONFLICT with the current ink, and nothing is written.
// A versioned clear (the toolbar's "Clear", which always carries the version) still goes through,
// and the legacy last-write-wins path keeps working for non-empty lists.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-inkguard-${process.pid}`

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] ink blind-wipe guard', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { createSession, SESSION_COOKIE } = await import('./auth')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION' } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./routes/ink')).registerInkRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  let cookie = ''
  let wsId = ''
  let userId = ''
  before(async () => {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `ink-${randomUUID().slice(0, 8)}@t.t`, name: 'ink', passwordHash: 'x' })
      .returning()
    userId = u.id
    cookie = `${SESSION_COOKIE}=${(await createSession(u.id)).token}`
    const { generateInviteCodeColumns } = await import('./helpers')
    const id = randomUUID()
    const [ws] = await db.insert(schema.workspaces).values({ id, name: 'w', ...(await generateInviteCodeColumns(db, id)) }).returning()
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: 'owner' })
    wsId = ws.id
  })

  async function newPage() {
    const [p] = await db.insert(schema.pages).values({ workspaceId: wsId, title: 'p', createdBy: userId, scope: 'shared' }).returning()
    return `/api/pages/${p.id}/ink`
  }
  const req = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, payload: payload as object })
  const stroke = (id: string) => ({ id, color: '#000000', size: 2, points: [1, 2, 0.5] })
  const ids = async (url: string) => (await req('GET', url)).json().ink.strokes.map((s: { id: string }) => s.id)

  it('blind PUT of [] over existing strokes → 412 with the current ink, nothing written', async () => {
    const url = await newPage()
    const v1 = (await req('PUT', url, { strokes: [stroke('a'), stroke('b')], expectedUpdatedAt: null })).json().ink.updatedAt
    const wipe = await req('PUT', url, { strokes: [] })
    assert.equal(wipe.statusCode, 412, wipe.body)
    assert.equal(wipe.json().error.code, 'INK_CONFLICT')
    assert.deepEqual(wipe.json().error.ink.strokes.map((s: { id: string }) => s.id), ['a', 'b'])
    assert.equal(wipe.json().error.ink.updatedAt, v1)
    assert.deepEqual(await ids(url), ['a', 'b'])
  })

  it('versioned clear still works', async () => {
    const url = await newPage()
    const v1 = (await req('PUT', url, { strokes: [stroke('a')], expectedUpdatedAt: null })).json().ink.updatedAt
    const clear = await req('PUT', url, { strokes: [], expectedUpdatedAt: v1 })
    assert.equal(clear.statusCode, 200, clear.body)
    assert.deepEqual(await ids(url), [])
  })

  it('legacy (unversioned) saves of a non-empty list keep last-write-wins; [] on empty ink is fine', async () => {
    const url = await newPage()
    assert.equal((await req('PUT', url, { strokes: [] })).statusCode, 200)
    assert.equal((await req('PUT', url, { strokes: [stroke('a')] })).statusCode, 200)
    assert.equal((await req('PUT', url, { strokes: [stroke('z')] })).statusCode, 200)
    assert.deepEqual(await ids(url), ['z'])
  })
})
