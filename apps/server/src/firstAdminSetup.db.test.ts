// First-admin setup link (docs/adr/2160-*): the one-time code from the server log creates the first
// account as admin, only while the database has no account; concurrent setups commit at most one;
// any account (made any way) closes the path; the signup-key path keeps working.
//
// The shared test database always has users (suites run in parallel and never clean up), so this
// file makes its own scratch database, points DATABASE_URL at it before the lazy `./db` import,
// migrates it, and drops it at the end.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-setup-${process.pid}`
// Production-like: signups need a key, so the setup code is what lets the first account in.
process.env.SIGNUP_REQUIRE_KEY = '1'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] first-admin setup link', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_setup_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('./db/index')
  await runMigrations()
  const schema = await import('./db/schema')
  const { sql } = await import('drizzle-orm')
  const setup = await import('./firstAdminSetup')
  const { hashSignupKey } = await import('./secretsAtRest')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
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
  const register = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: `setup-${++n}-${randomBytes(3).toString('hex')}@example.test`, name: `Person ${n}`, password: 'correct horse battery', ...body },
    })
  const mode = async () => (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { setupPending?: boolean; signupKeyRequired: boolean }
  const userCount = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM users`)) as unknown as { n: number }[])[0].n)
  const wipeAccounts = async () => {
    await db.execute(sql`TRUNCATE users, workspaces, signup_keys CASCADE`)
  }

  it('makes a 24-character code in groups of four from the unambiguous alphabet', () => {
    const a = setup.newSetupCode()
    assert.match(a, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){5}$/)
    assert.notEqual(a, setup.newSetupCode())
    assert.equal(setup.normalizeSetupCode(' abcd-efgh '), 'ABCDEFGH')
  })

  it('with no account: a code is made, /auth/mode says setup is pending, a wrong code is refused', async () => {
    assert.equal(await userCount(), 0)
    const code = await setup.prepareFirstAdminSetup()
    assert.ok(code)
    const m = await mode()
    assert.equal(m.setupPending, true)
    assert.equal(m.signupKeyRequired, true)

    const noKey = await register({})
    assert.equal(noKey.statusCode, 400)
    assert.equal(noKey.json().error.code, 'SIGNUP_KEY_REQUIRED')

    const wrong = await register({ setupCode: setup.newSetupCode() })
    assert.equal(wrong.statusCode, 403)
    assert.equal(wrong.json().error.code, 'INVALID_SETUP_CODE')
    assert.equal(await userCount(), 0)
  })

  it('eight concurrent setups with the right code: exactly one account, and it is admin', async () => {
    await wipeAccounts()
    const code = (await setup.prepareFirstAdminSetup())!
    // lower case and without dashes is the same code
    const variants = [code, code.toLowerCase(), code.replace(/-/g, '')]
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => register({ setupCode: variants[i % variants.length] })))
    const ok = res.filter((r) => r.statusCode === 200)
    const closed = res.filter((r) => r.statusCode === 403 && r.json().error.code === 'SETUP_CLOSED')
    assert.equal(ok.length, 1, res.map((r) => `${r.statusCode} ${r.body}`).join('\n'))
    assert.equal(closed.length, 7)
    assert.equal(ok[0].json().user.isAdmin, true)
    assert.ok(String(ok[0].headers['set-cookie'] ?? '').length > 0, 'the setup account is signed in')
    assert.equal(await userCount(), 1)
    const admins = (await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE is_admin`)) as unknown as { n: number }[]
    assert.equal(Number(admins[0].n), 1)
    // the account got its workspace like any signup
    const ws = (await db.execute(sql`SELECT count(*)::int AS n FROM workspace_members WHERE role = 'owner'`)) as unknown as { n: number }[]
    assert.equal(Number(ws[0].n), 1)

    // closed for good: the same code again, and /auth/mode
    const again = await register({ setupCode: code })
    assert.equal(again.statusCode, 403)
    assert.equal(again.json().error.code, 'SETUP_CLOSED')
    assert.equal((await mode()).setupPending, false)
    assert.equal(await userCount(), 1)
  })

  it('the signup-key path is unchanged: a key still signs up a (non-admin) second account', async () => {
    const key = 'ABCD-EFGH-JKLM-NPQR'
    await db.insert(schema.signupKeys).values({ key: hashSignupKey(key), note: 'test', maxUses: 1 })
    const r = await register({ signupKey: key })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().user.isAdmin, false)
    const reused = await register({ signupKey: key })
    assert.equal(reused.statusCode, 403)
    assert.equal(reused.json().error.code, 'INVALID_SIGNUP_KEY')
  })

  it('an account made some other way (signup key, OpenID Connect, delegated) closes the open setup path', async () => {
    await wipeAccounts()
    const code = (await setup.prepareFirstAdminSetup())!
    assert.equal((await mode()).setupPending, true)
    // e.g. an OIDC auto-created account: inserted without going through /auth/register
    await db.insert(schema.users).values({ email: `oidc-${randomBytes(3).toString('hex')}@example.test`, name: 'Elsewhere', passwordHash: 'x' })
    const r = await register({ setupCode: code })
    assert.equal(r.statusCode, 403)
    assert.equal(r.json().error.code, 'SETUP_CLOSED')
    assert.equal((await mode()).setupPending, false)
    assert.equal(await userCount(), 1)
  })

  it('a setup racing a key signup: never two admins, and the setup only wins on an empty database', async () => {
    await wipeAccounts()
    const code = (await setup.prepareFirstAdminSetup())!
    const key = 'WXYZ-2345-6789-ABCD'
    await db.insert(schema.signupKeys).values({ key: hashSignupKey(key), note: 'race', maxUses: 1 })
    const [s, k] = await Promise.all([register({ setupCode: code }), register({ signupKey: key })])
    assert.equal(k.statusCode, 200, k.body)
    const admins = (await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE is_admin`)) as unknown as { n: number }[]
    assert.equal(Number(admins[0].n), 1, 'exactly one admin')
    if (s.statusCode === 200) assert.equal(s.json().user.isAdmin, true)
    else assert.equal(s.json().error.code, 'SETUP_CLOSED')
  })

  it('a restart with still no account makes a new code and the old one stops working', async () => {
    await wipeAccounts()
    const first = (await setup.prepareFirstAdminSetup())!
    const second = (await setup.prepareFirstAdminSetup())!
    assert.notEqual(first, second)
    const old = await register({ setupCode: first })
    assert.equal(old.statusCode, 403)
    assert.equal(old.json().error.code, 'INVALID_SETUP_CODE')
    const ok = await register({ setupCode: second })
    assert.equal(ok.statusCode, 200, ok.body)
  })

  it('a server that boots with accounts prints nothing and accepts no setup code', async () => {
    assert.ok((await userCount()) > 0)
    assert.equal(await setup.prepareFirstAdminSetup(), null)
    assert.equal(setup.checkSetupCode(setup.newSetupCode()), 'closed')
    assert.equal((await mode()).setupPending, false)
  })

  it('the log lines carry the link on PUBLIC_URL, or say to keep the path when it is unset', () => {
    const withOrigin = setup.setupLogLines('AAAA-BBBB', 'http://localhost:3987', 3000).join('\n')
    assert.match(withOrigin, /http:\/\/localhost:3987\/setup\?code=AAAA-BBBB/)
    assert.doesNotMatch(withOrigin, /PUBLIC_URL is not set/)
    const without = setup.setupLogLines('AAAA-BBBB', null, 3000).join('\n')
    assert.match(without, /http:\/\/localhost:3000\/setup\?code=AAAA-BBBB/)
    assert.match(without, /PUBLIC_URL is not set/)
  })
})
