// Sign-up hooks (docs/adr/2501-*): without hooks POST /api/auth/register answers as 0.21.1; `before`
// refuses before anything is consumed; `on` runs inside the account's transaction after the
// first-admin promotion (so it sees the final isAdmin), and its failure leaves no account and gives
// the signup key back.
//
// The first-admin case needs a database without accounts, and the shared test database always has
// some, so this file makes its own scratch database (as firstAdminSetup.db.test.ts does).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
// Signups need a key here, so the refund of a consumed key can be checked.
process.env.SIGNUP_REQUIRE_KEY = '1'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] sign-up hooks', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_signuphooks_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('./db/index')
  await runMigrations()
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { hashSignupKey } = await import('./secretsAtRest')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const hooks = await import('./signupHooks')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => (await import('./routes/auth')).registerAuthRoutes(api), { prefix: '/api' })
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  let n = 0
  const newKey = async () => {
    const key = `KEY-${randomBytes(6).toString('hex').toUpperCase()}`
    await db.insert(schema.signupKeys).values({ key: hashSignupKey(key), maxUses: 1 })
    return key
  }
  const keyUses = async (key: string) =>
    (await db.select({ used: schema.signupKeys.usedCount }).from(schema.signupKeys).where(eq(schema.signupKeys.key, hashSignupKey(key))))[0]?.used
  const register = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: body, headers })
  const person = async (extra: Record<string, unknown> = {}) => {
    n += 1
    return { email: `hook${n}-${randomBytes(3).toString('hex')}@example.com`, name: `Hook ${n}`, password: 'password123', signupKey: await newKey(), ...extra }
  }
  const userCount = async () => Number(((await db.execute(sql`select count(*)::int as n from users`)) as unknown as { n: number }[])[0].n)
  const userByEmail = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0]

  it('without hooks: the first account becomes admin, the next does not, the answer is the 0.21.1 one', async () => {
    assert.equal(hooks.hasSignupHooks(), false)
    const a = await person()
    const r1 = await register(a)
    assert.equal(r1.statusCode, 200, r1.body)
    const b1 = r1.json() as { user: Record<string, unknown> }
    // 0.21.1: { user: { id, email, name, isAdmin } } and a session cookie
    assert.deepEqual(Object.keys(b1), ['user'])
    assert.deepEqual(Object.keys(b1.user), ['id', 'email', 'name', 'isAdmin'])
    assert.equal(b1.user.email, a.email)
    assert.equal(b1.user.isAdmin, true)
    assert.ok(String(r1.headers['set-cookie'] ?? '').includes('inkling_sid='))
    const row = await userByEmail(a.email)
    assert.equal(row.isAdmin, true)
    assert.equal(row.expiresAt, null)
    const ws = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, row.id))
    assert.equal(ws.length, 1)
    assert.equal(ws[0].role, 'owner')
    assert.equal(await keyUses(a.signupKey), 1)

    const b = await person()
    const r2 = await register(b)
    assert.equal(r2.statusCode, 200, r2.body)
    assert.equal((r2.json() as { user: { isAdmin: boolean } }).user.isAdmin, false)
    // extra fields are accepted and change nothing without hooks
    const c = await person({ consents: ['terms'], legalVersion: 'abc123', website: '', loginId: 'someone' })
    const r3 = await register(c)
    assert.equal(r3.statusCode, 200, r3.body)
  })

  it('`on` runs in the account transaction and sees the final isAdmin (first admin included)', async () => {
    // a server whose admins all left: the next sign-up is promoted (promoteIfNoAdmin)
    await db.update(schema.users).set({ isAdmin: false })
    const seen: { isAdmin: boolean; rowInTx: boolean; adminInTx: boolean; workspaceInTx: boolean; email: string }[] = []
    const off = hooks.registerSignupHook('test-on', {
      on: async (tx, user) => {
        const [r] = await tx.select({ isAdmin: schema.users.isAdmin }).from(schema.users).where(eq(schema.users.id, user.id))
        const w = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, user.workspaceId))
        seen.push({ isAdmin: user.isAdmin, rowInTx: !!r, adminInTx: !!r?.isAdmin, workspaceInTx: w.length === 1, email: user.email })
        // what B's lifetime hook will do: an expiry date for everyone but admins
        if (!user.isAdmin) await tx.update(schema.users).set({ expiresAt: new Date(Date.now() + 14 * 86_400_000) }).where(eq(schema.users.id, user.id))
      },
    })
    try {
      const first = await person()
      const r1 = await register(first)
      assert.equal(r1.statusCode, 200, r1.body)
      assert.equal((r1.json() as { user: { isAdmin: boolean } }).user.isAdmin, true)
      const second = await person()
      assert.equal((await register(second)).statusCode, 200)
      assert.deepEqual(seen, [
        { isAdmin: true, rowInTx: true, adminInTx: true, workspaceInTx: true, email: first.email },
        { isAdmin: false, rowInTx: true, adminInTx: false, workspaceInTx: true, email: second.email },
      ])
      // the promoted first account has no expiry date; the other one does
      assert.equal((await userByEmail(first.email)).expiresAt, null)
      assert.ok((await userByEmail(second.email)).expiresAt instanceof Date)
    } finally {
      off()
    }
  })

  it('`before` gets the raw and parsed body, IP and locale, and refuses before the key is used', async () => {
    let ctxSeen: import('./signupHooks').SignupContext | null = null
    const off = hooks.registerSignupHook('test-before', {
      before: (ctx) => {
        ctxSeen = ctx
        if (ctx.body.name === 'Refuse me') {
          // details are the fifth argument (the fourth is Retry-After)
          throw new AppError(403, 'SIGNUP_FULL', 'Sign-up is closed', undefined, { limit: 3, used: 3 })
        }
      },
    })
    try {
      const p = await person({ consents: ['terms', 'privacy'], legalVersion: 'v1abc', website: 'http://spam', loginId: 'Mina', unknownField: 42 })
      const r = await register(p, { 'accept-language': 'ko-KR,ko;q=0.9' })
      assert.equal(r.statusCode, 200, r.body)
      const ctx = ctxSeen as unknown as import('./signupHooks').SignupContext
      assert.equal((ctx.rawBody as Record<string, unknown>).unknownField, 42)
      assert.deepEqual(ctx.body.consents, ['terms', 'privacy'])
      assert.equal(ctx.body.legalVersion, 'v1abc')
      assert.equal(ctx.body.website, 'http://spam')
      assert.equal(ctx.body.loginId, 'Mina')
      assert.ok(!('unknownField' in ctx.body))
      assert.equal(ctx.ip, '127.0.0.1')
      assert.equal(ctx.locale, 'ko')
      assert.equal(ctx.setupCode, false)

      const before = await userCount()
      const q = await person({ name: 'Refuse me' })
      const res = await register(q)
      assert.equal(res.statusCode, 403)
      assert.deepEqual(res.json(), { error: { limit: 3, used: 3, code: 'SIGNUP_FULL', message: 'Sign-up is closed' } })
      assert.equal(await userCount(), before)
      assert.equal(await keyUses(q.signupKey), 0, 'the signup key was not consumed')
    } finally {
      off()
    }
  })

  it('a throwing `on` leaves no account, no workspace, and gives the key back', async () => {
    const off = hooks.registerSignupHook('test-on-fails', {
      on: async (tx, user) => {
        // something written in the transaction first, then a refusal
        await tx.insert(schema.signupEvents).values({ ip: 'hook-test' })
        if (user.name === 'Roll back') throw new AppError(400, 'CONSENT_REQUIRED', 'Consent missing')
      },
    })
    try {
      const users0 = await userCount()
      const ws0 = Number(((await db.execute(sql`select count(*)::int as n from workspaces`)) as unknown as { n: number }[])[0].n)
      const p = await person({ name: 'Roll back' })
      const r = await register(p)
      assert.equal(r.statusCode, 400, r.body)
      assert.equal((r.json() as { error: { code: string } }).error.code, 'CONSENT_REQUIRED')
      assert.equal(await userCount(), users0)
      assert.equal(Number(((await db.execute(sql`select count(*)::int as n from workspaces`)) as unknown as { n: number }[])[0].n), ws0)
      assert.equal(await userByEmail(p.email), undefined)
      assert.equal((await db.select().from(schema.signupEvents).where(eq(schema.signupEvents.ip, 'hook-test'))).length, 0)
      assert.equal(await keyUses(p.signupKey), 0, 'the key was given back')
      // the same person can sign up once the hook lets them
      const ok = await register({ ...p, name: 'Fine now', signupKey: await newKey() })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal((await db.select().from(schema.signupEvents).where(eq(schema.signupEvents.ip, 'hook-test'))).length, 1)
    } finally {
      off()
    }
  })
})
