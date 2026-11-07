// GET /api/admin/status (docs/adr/1230-*): admins with a browser session only, no secret values or
// paths in the body, heavy probes cached between calls.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// run-tests: db-exclusive (whole-database aggregates; under the parallel run a probe query can time out and
// report "unknown", which is the intended answer but not what this test checks, docs/adr/1243-*)
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] admin status summary', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const { _resetStatusCache } = await import('./probes')

  let app: FastifyInstance
  let admin: Awaited<ReturnType<typeof h.makeUser>>
  let member: Awaited<ReturnType<typeof h.makeUser>>

  before(async () => {
    app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String(err) } })
      console.error(err)
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        await (await import('../routes/admin')).registerAdminRoutes(api)
        await (await import('../routes/apiTokens')).registerApiTokenRoutes(api)
      },
      { prefix: '/api' },
    )
    await app.ready()
    admin = await h.makeUser('status-admin')
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin.id))
    member = await h.makeUser('status-member')
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const get = (headers: Record<string, string>, url = '/api/admin/status') => app.inject({ method: 'GET', url, headers })

  it('answers admins with groups, levels and summaries', async () => {
    _resetStatusCache()
    const res = await get({ cookie: admin.cookie })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as {
      level: string
      groups: { id: string; level: string; summary: string | null; items: { key: string; level: string; data: Record<string, unknown> }[] }[]
      issues: { key: string }[]
      cache: { hit: boolean }
    }
    assert.deepEqual(body.groups.map((g) => g.id), ['backup', 'storage', 'app', 'security', 'update'])
    assert.ok(['ok', 'warn', 'error'].includes(body.level))
    assert.equal(body.cache.hit, false)
    const items = Object.fromEntries(body.groups.flatMap((g) => g.items).map((i) => [i.key, i]))
    // the probes ran against the real database
    assert.ok(Number(items['storage.database'].data.bytes) > 0)
    assert.equal(typeof items['storage.uploads'].data.files, 'number')
    assert.equal(typeof items['storage.largePages'].data.count, 'number')
    assert.equal(items['app.migrations'].data.state, 'current', JSON.stringify(items['app.migrations']))
    assert.equal(items['update.check'].level, 'off') // UPDATE_CHECK is not set: no outbound request
    // nothing secret or path-like leaves the server
    const raw = res.body
    const url = new URL(process.env.DATABASE_URL!)
    for (const bad of [process.env.DATABASE_URL!, process.env.APP_SECRET_KEY!, '/backups', '/backup-ctl', '_journal.json']) {
      assert.ok(!raw.includes(bad), `body contains ${bad}`)
    }
    if (url.password.length >= 6) assert.ok(!raw.includes(`"${decodeURIComponent(url.password)}"`), 'body contains the db password')
  })

  it('caches the heavy probes; refresh=1 recomputes', async () => {
    const a = (await get({ cookie: admin.cookie })).json() as { cache: { hit: boolean } }
    assert.equal(a.cache.hit, true)
    const b = (await get({ cookie: admin.cookie }, '/api/admin/status?refresh=1')).json() as { cache: { hit: boolean } }
    assert.equal(b.cache.hit, false)
  })

  it('refuses members and every bearer token', async () => {
    assert.equal((await get({ cookie: member.cookie })).statusCode, 403)
    assert.equal((await get({})).statusCode, 401)
    const t = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: admin.cookie },
      payload: { name: 'status', expiresInDays: 30, access: 'read', range: { kind: 'all' } },
    })
    assert.equal(t.statusCode, 201, t.body)
    const secret = (t.json() as { secret: string }).secret
    const res = await get({ authorization: `Bearer ${secret}` })
    assert.equal(res.statusCode, 403)
    assert.match(res.body, /web app/)
  })
})
