// Bearer tokens and the 0.22 account routes (0.22 security fix F9, contract §14).
// GET /api/me/delete-preview names every workspace of the account and the members who would take
// over: a token (an API token limited to one workspace included) must not read it. Ported from the
// review's R2 (w22-reports/sec/sec.db.test.ts), which got 200 with the out-of-range names.
// Also every other route 0.22 added, against a full-access API token: refused unless it is a
// workspace read that the token's range already covers (usage) or a public document (legal).
//
// This file makes its own scratch database (one of the cases needs an admin).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-sessiononly-'))
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] 0.22 account routes and bearer tokens', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_sessonly_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { createSession, SESSION_COOKIE, hashPassword } = await import('../auth')
  const { createApiToken } = await import('../apiTokens')
  const { generateInviteCodeColumns } = await import('../helpers')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String(err) } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/auth')).registerAuthRoutes(api)
      await (await import('../routes/admin')).registerAdminRoutes(api)
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../restricted')).registerRestrictedMode(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  const tag = () => randomBytes(4).toString('hex')
  const pw = await hashPassword('password123')
  const mkUser = async (name: string, isAdmin = false) => {
    const [u] = await db.insert(schema.users).values({ email: `${name.toLowerCase().replace(/\W/g, '')}-${tag()}@t.t`, name, passwordHash: pw, isAdmin }).returning()
    const { token } = await createSession(u.id)
    return { ...u, cookie: `${SESSION_COOKIE}=${token}` }
  }
  const mkWs = async (name: string, owner: { id: string }, members: { id: string; role?: 'admin' | 'member' }[] = []) => {
    const id = crypto.randomUUID()
    const [w] = await db.insert(schema.workspaces).values({ id, name, ...(await generateInviteCodeColumns(db, id)) }).returning()
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: w.id, userId: owner.id, role: 'owner' as const },
      ...members.map((m) => ({ workspaceId: w.id, userId: m.id, role: m.role ?? ('member' as const) })),
    ])
    return w
  }
  const bearer = (tok: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  it('R2 (ported): GET /api/me/delete-preview refuses an API token limited to one workspace, and names nothing outside it', async () => {
    const me = await mkUser('Ranged')
    const other = await mkUser('Bystander Bob')
    const inRange = await mkWs(`InRange ${tag()}`, me)
    const secret = await mkWs(`SecretProject ${tag()}`, me, [{ id: other.id, role: 'admin' }])
    const { secret: tok } = await createApiToken(me.id, { name: 't', expiresInDays: null, access: 'read', range: { kind: 'workspaces', workspaceIds: [inRange.id] } })
    const r = await bearer(tok, 'GET', '/api/me/delete-preview')
    assert.equal(r.statusCode, 403, r.body)
    assert.ok(!r.body.includes(secret.name))
    assert.ok(!r.body.includes('Bystander Bob'))
    // the browser session still gets the preview
    const s = await app.inject({ method: 'GET', url: '/api/me/delete-preview', headers: { cookie: me.cookie } })
    assert.equal(s.statusCode, 200, s.body)
    assert.ok(s.body.includes(secret.name))
  })

  it('every route 0.22 added: a full-access API token is refused, except the usage of a workspace in range and the public legal documents', async () => {
    const me = await mkUser('Tok', true)
    const peer = await mkUser('Peer')
    const solo = await mkWs(`Solo ${tag()}`, me)
    const gone = await mkWs(`Gone ${tag()}`, me)
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, gone.id))
    const shared = await mkWs(`Shared ${tag()}`, peer, [{ id: me.id }])
    const { secret: tok } = await createApiToken(me.id, { name: 't', expiresInDays: null, access: 'write', range: { kind: 'all' } })
    const refused: [string, string, unknown?][] = [
      ['GET', '/api/me/delete-preview'],
      ['DELETE', '/api/me', { confirm: me.email, password: 'password123' }],
      ['DELETE', `/api/workspaces/${gone.id}/permanent`, { name: gone.name }],
      ['GET', `/api/admin/users/${peer.id}/expiry`],
      ['PATCH', `/api/admin/users/${peer.id}/expiry`, { expiresAt: null }],
      // leaving a workspace as its only member deletes it (0.22): session-only like every member change
      ['DELETE', `/api/workspaces/${solo.id}/members/${me.id}`],
      ['DELETE', `/api/workspaces/${shared.id}/members/${me.id}`],
    ]
    for (const [m, url, body] of refused) {
      const r = await bearer(tok, m, url, body)
      assert.equal(r.statusCode, 403, `${m} ${url}: ${r.statusCode} ${r.body}`)
    }
    // nothing happened
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, me.id))).length, 1)
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, gone.id))).length, 1)
    assert.equal((await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, solo.id))).length, 1)
    // consent: refused for a token too (404 here: no LEGAL_DIR, so there is nothing to agree to)
    const c = await bearer(tok, 'POST', '/api/legal/consent', { consents: [], legalVersion: 'x' })
    assert.ok([403, 404].includes(c.statusCode), c.body)
    // allowed: the usage of a workspace the token covers (counts of that workspace only)
    const u = await bearer(tok, 'GET', `/api/workspaces/${solo.id}/usage`)
    assert.equal(u.statusCode, 200, u.body)
  })
})
