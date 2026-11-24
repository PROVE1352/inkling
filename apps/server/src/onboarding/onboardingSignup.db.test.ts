// Every new account gets the sample page in the workspace it got with its sign-up (docs/adr/2390-*,
// amending the "members by button" of 2381): made on the account's first onboarding read, as the first
// admin's always was, so the sign-up request itself does not change. With the two example suggestions
// (docs/adr/2388-*); not in a team workspace the person joined; not with ONBOARDING=off, not for an
// existing account, not twice when the button races it; a workspace page limit leaves the sign-up and
// the read working and just no sample.
// Accounts are made through POST /api/auth/register, the real sign-up (the test harness's accounts have
// no sign-up workspace and get none: onboarding.db.test.ts).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-onboarding-signup-${process.pid}`
process.env.SIGNUP_REQUIRE_KEY = '0'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER', 'ONBOARDING', 'ONBOARDING_EXISTING_USERS']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] onboarding: the sample page for every new sign-up', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, isNull, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const L = await import('../limits')
  const app = await h.buildTestApp()
  // buildTestApp has no auth routes: the sign-up route on an app of its own, same database
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const auth = Fastify()
  await auth.register(import('@fastify/cookie'))
  auth.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await auth.register(async (api) => (await import('../routes/auth')).registerAuthRoutes(api), { prefix: '/api' })
  await auth.ready()

  // The first account of an empty database would be its first admin (the old rule): make sure one exists.
  const admins = (await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE is_admin`)) as unknown as { n: number }[]
  if (admins[0].n === 0) await db.insert(schema.users).values({ email: `admin-${randomBytes(4).toString('hex')}@t.t`, name: 'Admin', passwordHash: 'x', isAdmin: true, createdAt: new Date(Date.now() - 86_400_000) })

  after(async () => {
    await collab.destroyCollab()
    await auth.close()
    await app.close()
    await closeDb()
  })

  type DTO = import('@inkling/shared').OnboardingDTO
  type Account = { id: string; cookie: string; ws: string }
  const register = async (lang = 'en-US'): Promise<Account> => {
    const r = await auth.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'accept-language': lang },
      payload: { email: `s-${randomBytes(4).toString('hex')}@example.test`, name: 'Sam', password: 'correct horse battery' },
    })
    assert.equal(r.statusCode, 200, r.body)
    const id = (r.json() as { user: { id: string } }).user.id
    const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0]
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, id))
    return { id, cookie, ws: m.workspaceId }
  }
  const call = (a: Account, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, lang = 'en') =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: a.cookie, 'accept-language': lang }, ...(payload ? { payload } : {}) })
  const onboarding = async (a: Account, lang = 'en'): Promise<DTO> => {
    const r = await call(a, 'GET', '/me/onboarding', undefined, lang)
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as DTO
  }
  const stored = async (a: Account) =>
    (await db.select().from(schema.userOnboarding).where(eq(schema.userOnboarding.userId, a.id)))[0]?.state as Record<string, unknown> | undefined
  /** Live top-level pages of the person in a workspace (a sample is one tree, one root). */
  const roots = async (a: Account, ws: string) =>
    db
      .select()
      .from(schema.pages)
      .where(and(eq(schema.pages.workspaceId, ws), eq(schema.pages.createdBy, a.id), isNull(schema.pages.parentId), isNull(schema.pages.deletedAt)))
  const exampleSuggestions = async (pageId: string) =>
    ((await db.execute(sql`
      SELECT count(*)::int AS n FROM section_suggestions WHERE page_id = ${pageId} AND connection = 'example' AND status = 'open'
    `)) as unknown as { n: number }[])[0].n

  it('a new account gets the sample in its sign-up workspace on its first read, private, with two example suggestions', async () => {
    const a = await register('ko-KR,ko;q=0.9')
    assert.equal(await stored(a), undefined, 'the sign-up itself made nothing')
    assert.equal((await roots(a, a.ws)).length, 0)
    const d = await onboarding(a, 'ko')
    assert.equal(d.audience, 'owner')
    const root = d.samples[a.ws]
    assert.ok(root, 'sample made in the sign-up workspace')
    const [top] = await roots(a, a.ws)
    assert.equal(top.id, root)
    assert.equal(top.title, 'Inkling 시작하기 (샘플)', 'in the person’s language')
    const all = await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, a.ws))
    assert.ok(all.length > 1 && all.every((p) => p.scope === 'private' && p.createdBy === a.id), 'private, the person’s own')
    assert.equal(await exampleSuggestions(root), 2, 'the two example suggestions')
    assert.equal((await stored(a))?.autoSample, 'created')
    assert.ok(d.checklist.items.every((i) => !i.done), 'the sample ticks nothing')
    // more reads make nothing more; deleted, it does not come back by itself; the button makes a new one
    await onboarding(a)
    assert.equal((await roots(a, a.ws)).length, 1)
    assert.ok((await call(a, 'DELETE', `/pages/${root}`)).statusCode < 300)
    assert.deepEqual((await onboarding(a)).samples, {})
    assert.equal((await roots(a, a.ws)).length, 0)
    const again = await call(a, 'POST', '/me/onboarding/sample', { workspaceId: a.ws })
    assert.equal(again.statusCode, 200, again.body)
    assert.equal((again.json() as { created: boolean }).created, true)
  })

  it('an invited member gets it in their own sign-up workspace, never in the team workspace they joined', async () => {
    const owner = await h.makeUser('team-owner')
    const team = await h.makeWorkspace(owner)
    const m = await register()
    // joined the team before the app first asked (what /join/:code does: a member row)
    await db.insert(schema.workspaceMembers).values({ workspaceId: team.id, userId: m.id, role: 'member' })
    const d = await onboarding(m)
    assert.equal(d.audience, 'member')
    assert.deepEqual(Object.keys(d.samples), [m.ws])
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, team.id))).length, 0, 'nothing in the team workspace')
    // the button still makes one in the team workspace when asked
    const r = await call(m, 'POST', '/me/onboarding/sample', { workspaceId: team.id })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((await roots(m, team.id)).length, 1)
  })

  it('ONBOARDING=off: no sample, then or after it is turned on', async () => {
    const a = await register()
    process.env.ONBOARDING = 'off'
    try {
      assert.equal((await onboarding(a)).enabled, false)
    } finally {
      delete process.env.ONBOARDING
    }
    assert.equal((await roots(a, a.ws)).length, 0)
    const d = await onboarding(a)
    assert.deepEqual(d.samples, {}, 'first seen while off: an existing account later')
    assert.equal((await roots(a, a.ws)).length, 0)
  })

  it('an existing account (legacy row) gets none, also with ONBOARDING_EXISTING_USERS=once', async () => {
    const a = await register()
    await db.insert(schema.userOnboarding).values({ userId: a.id, state: { legacy: true } })
    process.env.ONBOARDING_EXISTING_USERS = 'once'
    try {
      const d = await onboarding(a)
      assert.equal(d.intro, true)
      assert.deepEqual(d.samples, {})
    } finally {
      delete process.env.ONBOARDING_EXISTING_USERS
    }
    assert.deepEqual((await onboarding(a)).samples, {})
    assert.equal((await roots(a, a.ws)).length, 0)
    // an account whose first read was before this release ('none' recorded) is not asked again
    const b = await register()
    await db.insert(schema.userOnboarding).values({ userId: b.id, state: { autoSample: 'none' } })
    assert.deepEqual((await onboarding(b)).samples, {})
    assert.equal((await roots(b, b.ws)).length, 0)
  })

  it('a page limit: the sign-up and the read work, there is just no sample (recorded as failed, the button stays)', async () => {
    const restore = L.setLimitsForTests({ pagesPerWorkspace: 2 })
    try {
      const a = await register()
      const d = await onboarding(a)
      assert.equal(d.enabled, true)
      assert.equal(d.intro, true)
      assert.deepEqual(d.samples, {})
      assert.equal((await stored(a))?.autoSample, 'failed')
      assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, a.ws))).length, 0, 'no partial sample')
      // the person can still write
      const p = await call(a, 'POST', '/pages', { workspaceId: a.ws, title: 'Mine' })
      assert.equal(p.statusCode, 200, p.body)
    } finally {
      restore()
    }
  })

  it('the first read and the button at once: one sample', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await register()
      const results = await Promise.all([
        onboarding(a),
        call(a, 'POST', '/me/onboarding/sample', { workspaceId: a.ws }),
        onboarding(a),
        call(a, 'POST', '/me/onboarding/sample', { workspaceId: a.ws }),
      ])
      for (const r of results) if ('statusCode' in r) assert.ok(r.statusCode === 200 || r.statusCode === 409, String(r.body))
      const live = await roots(a, a.ws)
      assert.equal(live.length, 1, `round ${round}: exactly one sample tree`)
      assert.equal(await exampleSuggestions(live[0].id), 2)
      const d = await onboarding(a)
      assert.equal(d.samples[a.ws], live[0].id)
      assert.equal((await stored(a))?.autoSample, 'created')
    }
  })
})
