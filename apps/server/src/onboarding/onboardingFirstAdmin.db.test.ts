// Onboarding on a new server (docs/adr/2380-*, 2381-*): the first admin, made through the /setup link,
// gets the sample page in their first workspace once, in their language; deleting it does not bring
// it back; a second account made with a signup key and added to that workspace gets nothing by itself.
//
// The shared test database always has users, so like firstAdminSetup.db.test.ts this file makes its own
// scratch database, points DATABASE_URL at it before the lazy `../db` import, migrates it and drops it.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-onboard-first-${process.pid}`
process.env.SIGNUP_REQUIRE_KEY = '1'
delete process.env.ONBOARDING

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] onboarding on a new server', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_onboard_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const setup = await import('../firstAdminSetup')
  const { hashSignupKey } = await import('../secretsAtRest')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const collab = await import('../collab')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/auth')).registerAuthRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('./routes')).registerOnboardingRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  type DTO = import('@inkling/shared').OnboardingDTO
  const register = async (body: Record<string, unknown>, lang: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'accept-language': lang },
      payload: { email: `p-${randomBytes(3).toString('hex')}@example.test`, name: 'Ada', password: 'correct horse battery', ...body },
    })
    assert.equal(r.statusCode, 200, r.body)
    const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0]
    assert.ok(cookie, 'signed in')
    return { id: (r.json() as { user: { id: string } }).user.id, cookie }
  }
  const onboarding = async (cookie: string, lang = 'en'): Promise<DTO> => {
    const r = await app.inject({ method: 'GET', url: '/api/me/onboarding', headers: { cookie, 'accept-language': lang } })
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as DTO
  }
  const pagesBy = async (userId: string) =>
    db.select().from(schema.pages).where(and(eq(schema.pages.createdBy, userId), sql`${schema.pages.deletedAt} IS NULL`))

  let first: { id: string; cookie: string }
  let firstWs: string

  it('the first admin gets the sample once, in their language, in their first workspace’s private pages', async () => {
    const code = await setup.prepareFirstAdminSetup()
    assert.ok(code)
    first = await register({ setupCode: code }, 'ko-KR,ko;q=0.9')
    firstWs = (await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, first.id)))[0].workspaceId

    // two first reads at once (two tabs) make one sample
    const [a, b] = await Promise.all([onboarding(first.cookie, 'ko'), onboarding(first.cookie, 'ko')])
    assert.equal(a.audience, 'owner')
    assert.equal(a.intro, true)
    const root = a.samples[firstWs] ?? b.samples[firstWs]
    assert.ok(root, 'sample made')
    const made = await pagesBy(first.id)
    assert.equal(made.filter((p) => p.parentId === null).length, 1, 'exactly one sample tree')
    const top = made.find((p) => p.id === root)!
    assert.equal(top.title, 'Inkling 시작하기 (샘플)')
    assert.equal(top.workspaceId, firstWs)
    assert.ok(made.every((p) => p.scope === 'private'))
    // the sample ticks nothing
    assert.ok((await onboarding(first.cookie)).checklist.items.every((i) => !i.done))
    // more reads make nothing more
    await onboarding(first.cookie)
    assert.equal((await pagesBy(first.id)).length, made.length)
  })

  it('a deleted sample is not made again by itself', async () => {
    const root = (await onboarding(first.cookie)).samples[firstWs]
    const del = await app.inject({ method: 'DELETE', url: `/api/pages/${root}`, headers: { cookie: first.cookie } })
    assert.ok(del.statusCode < 300, del.body)
    const d = await onboarding(first.cookie)
    assert.deepEqual(d.samples, {})
    await onboarding(first.cookie)
    assert.equal((await pagesBy(first.id)).filter((p) => p.parentId === null).length, 0)
  })

  it('a second account (signup key) that joined the workspace gets no sample by itself, and the member list', async () => {
    const key = `ONB-${randomBytes(6).toString('hex').toUpperCase()}`
    await db.insert(schema.signupKeys).values({ key: hashSignupKey(key), note: 'test', maxUses: 1 })
    const second = await register({ signupKey: key }, 'en-US')
    // joined the first admin's workspace (what /join/:code does: a member row)
    await db.insert(schema.workspaceMembers).values({ workspaceId: firstWs, userId: second.id, role: 'member' })
    const d = await onboarding(second.cookie)
    assert.equal(d.audience, 'member')
    assert.equal(d.intro, true, 'a new account sees the intro')
    assert.deepEqual(d.samples, {})
    assert.equal((await pagesBy(second.id)).length, 0)
    const state = (await db.select().from(schema.userOnboarding).where(eq(schema.userOnboarding.userId, second.id)))[0].state as { autoSample?: string }
    assert.equal(state.autoSample, 'none')
    // by button: in their private pages of the team workspace
    const r = await app.inject({ method: 'POST', url: '/api/me/onboarding/sample', headers: { cookie: second.cookie }, payload: { workspaceId: firstWs } })
    assert.equal(r.statusCode, 200, r.body)
    const page = (await pagesBy(second.id)).find((p) => p.id === (r.json() as { pageId: string }).pageId)!
    assert.equal(page.title, 'Getting started with Inkling (sample)')
    assert.equal(page.scope, 'private')
    assert.equal(page.workspaceId, firstWs)
  })
})
