// Sign-up and account lifetime in restricted mode (0.22, docs/adr/2512-*, 2515-*, 2516-*): sign-in
// IDs, the account cap, the per-IP cap, the bot checks, expires_at at sign-up, the hourly expiry job
// with the six named cases of the contract (principle 2), and the retention of sign-up IPs and bans.
//
// The first-admin case needs a database without accounts, so this file makes its own scratch database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '0'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER', 'TRUST_PROXY']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] sign-up limits and account lifetime', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_acclife_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { setLimitsForTests } = await import('../limits')
  const { env } = await import('../env')
  const { generateInviteCodeColumns } = await import('../helpers')
  const { expireAccounts, purgeAccountRecords, EXPIRY_BATCH } = await import('./housekeeping')
  const { runRegisteredHousekeepingTasks } = await import('../restrictedExtras')

  const build = async (opts: { trustProxy?: string[] | false } = {}) => {
    const Fastify = (await import('fastify')).default
    const app = Fastify({ trustProxy: opts.trustProxy ?? env.trustProxy })
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        await (await import('../routes/auth')).registerAuthRoutes(api)
        await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
        await (await import('../restricted')).registerRestrictedMode(api)
      },
      { prefix: '/api' },
    )
    await app.ready()
    return app
  }
  const app = await build()
  const proxied = await build({ trustProxy: ['loopback'] })

  after(async () => {
    await app.close()
    await proxied.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  const tag = () => randomBytes(4).toString('hex')
  let ipN = 0
  /** A fresh client address per call unless given (the per-IP cap is off in most cases anyway). */
  const register = (body: Record<string, unknown>, opts: { ip?: string; headers?: Record<string, string>; via?: typeof app } = {}) =>
    (opts.via ?? app).inject({ method: 'POST', url: '/api/auth/register', payload: body, remoteAddress: opts.ip ?? `198.51.100.${(ipN++ % 250) + 1}`, headers: opts.headers ?? {} })
  const person = (extra: Record<string, unknown> = {}) => ({ email: `p-${tag()}@example.com`, name: `P ${tag()}`, password: 'password123', ...extra })
  const userBy = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0]
  const userCount = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM users`)) as unknown as { n: number }[])[0].n)
  const makeUser = async (opts: { isAdmin?: boolean; expiresAt?: Date | null } = {}) => {
    const [u] = await db.insert(schema.users).values({ email: `u-${tag()}@t.t`, name: `U ${tag()}`, passwordHash: 'x', isAdmin: !!opts.isAdmin, expiresAt: opts.expiresAt ?? null }).returning()
    return u
  }
  const exists = async (id: string) => (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id))).length > 0
  const past = () => new Date(Date.now() - 3_600_000)

  // --- contract principle 2, named test ③ (runs first: the database has no account yet) ---
  it('③ the first sign-up, made admin by promoteIfNoAdmin, has no expires_at; the next one has', async () => {
    assert.equal(await userCount(), 0)
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      const a = person()
      const r1 = await register(a)
      assert.equal(r1.statusCode, 200, r1.body)
      const first = await userBy(a.email)
      assert.equal(first.isAdmin, true)
      assert.equal(first.expiresAt, null)
      const b = person()
      assert.equal((await register(b)).statusCode, 200)
      const second = await userBy(b.email)
      assert.equal(second.isAdmin, false)
      const days = (second.expiresAt!.getTime() - Date.now()) / 86_400_000
      assert.ok(days > 13.99 && days <= 14, String(days))
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: String(r1.headers['set-cookie']).split(';')[0] } })
      assert.ok(!('expiresAt' in (me.json() as { user: object }).user))
    } finally {
      restore()
    }
  })

  // --- the six named tests of contract principle 2 ---
  it('① without the setting, an account whose expires_at has passed is not deleted', async () => {
    const u = await makeUser({ expiresAt: past() })
    assert.equal(await expireAccounts(() => undefined), 0)
    await runRegisteredHousekeepingTasks(() => undefined)
    assert.equal(await exists(u.id), true)
  })

  it('② an admin whose expires_at has passed is not deleted', async () => {
    const u = await makeUser({ isAdmin: true, expiresAt: past() })
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      await expireAccounts(() => undefined)
      assert.equal(await exists(u.id), true)
    } finally {
      restore()
    }
  })

  it('④ an account from before the setting (expires_at null) is not deleted', async () => {
    const u = await makeUser({ expiresAt: null })
    const restore = setLimitsForTests({ accountLifetimeDays: 1 })
    try {
      await expireAccounts(() => undefined)
      await runRegisteredHousekeepingTasks(() => undefined)
      assert.equal(await exists(u.id), true)
    } finally {
      restore()
    }
  })

  it('⑤ dry run: only log lines, the row count stays', async () => {
    const u = await makeUser({ expiresAt: past() })
    const restore = setLimitsForTests({ accountLifetimeDays: 14, accountLifetimeDryRun: true })
    try {
      const before = await userCount()
      const lines: string[] = []
      const n = await expireAccounts((m) => lines.push(m))
      assert.ok(n >= 1)
      assert.ok(lines.some((l) => l.startsWith(`[inkling] account lifetime (dry run): would delete user ${u.id},`)), lines.join('\n'))
      assert.equal(await userCount(), before)
      assert.equal(await exists(u.id), true)
    } finally {
      restore()
    }
    await db.update(schema.users).set({ expiresAt: null }).where(eq(schema.users.id, u.id))
  })

  it('⑥ one failing deletion does not stop the next; the log has ids and counts, no names', async () => {
    const a = await makeUser({ expiresAt: new Date(Date.now() - 7_200_000) })
    const b = await makeUser({ expiresAt: past() })
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      const { deleteAccount } = await import('./deletion')
      const lines: string[] = []
      const n = await expireAccounts(
        (m) => lines.push(m),
        async (id, opts) => {
          if (id === a.id) throw Object.assign(new Error(`row of ${a.email}`), { code: '40P01' })
          return deleteAccount(id, opts)
        },
      )
      assert.equal(n, 1)
      assert.equal(await exists(a.id), true)
      assert.equal(await exists(b.id), false)
      assert.ok(lines.includes(`[inkling] account lifetime: deleting user ${a.id} failed (40P01); will retry next hour`), lines.join('\n'))
      assert.ok(lines.includes(`[inkling] account lifetime: deleted user ${b.id}, 0 workspace(s) deleted, 0 handed over`), lines.join('\n'))
      for (const l of lines) {
        assert.ok(!l.includes(a.email) && !l.includes(a.name) && !l.includes(b.email) && !l.includes(b.name), l)
      }
    } finally {
      restore()
    }
    await db.update(schema.users).set({ expiresAt: null }).where(eq(schema.users.id, a.id))
  })

  it('the hourly job runs the expiry, at most 50 a time', async () => {
    assert.equal(EXPIRY_BATCH, 50)
    const u = await makeUser({ expiresAt: past() })
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      await runRegisteredHousekeepingTasks(() => undefined)
      assert.equal(await exists(u.id), false)
    } finally {
      restore()
    }
  })

  it('an expired account with a shared workspace: the content stays and the oldest member owns it', async () => {
    const u = await makeUser({ expiresAt: past() })
    const m1 = await makeUser()
    const m2 = await makeUser()
    const id = crypto.randomUUID()
    await db.insert(schema.workspaces).values({ id, name: 'Team', ...(await generateInviteCodeColumns(db, id)) })
    await db.insert(schema.workspaceMembers).values({ workspaceId: id, userId: u.id, role: 'owner' })
    await db.insert(schema.workspaceMembers).values({ workspaceId: id, userId: m1.id, role: 'member', createdAt: new Date(Date.now() - 60_000) })
    await db.insert(schema.workspaceMembers).values({ workspaceId: id, userId: m2.id, role: 'member' })
    const [page] = await db.insert(schema.pages).values({ workspaceId: id, title: 'kept', createdBy: u.id }).returning({ id: schema.pages.id })
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      assert.equal(await expireAccounts(() => undefined), 1)
    } finally {
      restore()
    }
    const members = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, id))
    assert.deepEqual(Object.fromEntries(members.map((m) => [m.userId, m.role])), { [m1.id]: 'owner', [m2.id]: 'member' })
    const [p] = await db.select().from(schema.pages).where(eq(schema.pages.id, page.id))
    assert.equal(p.createdBy, null)
    assert.equal(p.deletedAt, null)
  })

  // --- sign-in IDs ---
  it('sign-in IDs: rules, reserved names, lower case, taken, and email is refused in this mode', async () => {
    const restore = setLimitsForTests({ loginIdMode: 'username' })
    try {
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { loginId?: string }
      assert.equal(mode.loginId, 'username')
      const id = `Mina.${tag()}`
      const ok = await register({ loginId: id, name: 'Mina', password: 'password123' })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal((ok.json() as { user: { email: string } }).user.email, id.toLowerCase())
      const code = async (body: Record<string, unknown>) => (await register(body)).json().error?.code
      assert.equal(await code({ loginId: id.toUpperCase(), name: 'x', password: 'password123' }), 'LOGIN_ID_TAKEN')
      for (const bad of ['ab', 'Admin', 'root', 'a@b.cd', '-lead', 'with space', 'x'.repeat(31), 'kor한글']) {
        assert.equal(await code({ loginId: bad, name: 'x', password: 'password123' }), 'LOGIN_ID_INVALID', bad)
      }
      assert.equal((await register({ email: 'a@example.com', name: 'x', password: 'password123' })).statusCode, 400)
      assert.equal((await register({ email: 'a@example.com', loginId: `ok-${tag()}`, name: 'x', password: 'password123' })).statusCode, 400)
      assert.equal(await code({ name: 'x', password: 'password123' }), 'LOGIN_ID_INVALID')

      // sign-in with the ID in any case; an unknown ID and a wrong password answer alike
      const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: `203.0.113.${(ipN++ % 250) + 1}` })
      assert.equal((await login(id.toUpperCase(), 'password123')).statusCode, 200)
      const wrong = await login(id, 'wrong-password')
      const unknown = await login(`nobody-${tag()}`, 'wrong-password')
      assert.equal(wrong.statusCode, 401)
      assert.equal(unknown.statusCode, 401)
      assert.deepEqual(unknown.json(), wrong.json())
      // timing: an unknown ID spends the same password check as a known one
      const time = async (who: string) => {
        const t0 = performance.now()
        await login(who, 'wrong-password')
        return performance.now() - t0
      }
      const med = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)]
      const k: number[] = []
      const u: number[] = []
      for (let i = 0; i < 3; i++) {
        k.push(await time(id))
        u.push(await time(`nobody-${tag()}`))
      }
      assert.ok(med(u) > med(k) * 0.5, `unknown ${med(u).toFixed(1)} ms vs known ${med(k).toFixed(1)} ms`)
    } finally {
      restore()
    }
  })

  it('email mode is unchanged: a stray loginId is ignored as in 0.21.1', async () => {
    const p = person({ loginId: 'ignored' })
    const r = await register(p)
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((r.json() as { user: { email: string } }).user.email, p.email)
  })

  // --- sign-up limits ---
  it('SIGNUP_MAX_USERS: refused once full, concurrent sign-ups never pass the cap, auth/mode says so', async () => {
    const n = await userCount()
    const restore = setLimitsForTests({ signupMaxUsers: n + 3 })
    try {
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
      assert.equal(mode.signupChecks, true)
      assert.ok(!('signupFull' in mode))
      const rs = await Promise.all(Array.from({ length: 8 }, () => register(person({ formMs: 2500 }))))
      const codes = rs.map((r) => r.statusCode).sort()
      assert.deepEqual(codes, [200, 200, 200, 403, 403, 403, 403, 403], rs.map((r) => r.body).join('\n'))
      for (const r of rs) if (r.statusCode === 403) assert.equal(r.json().error.code, 'SIGNUP_FULL')
      assert.equal(await userCount(), n + 3)
      assert.equal(((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>).signupFull, true)
    } finally {
      restore()
    }
    assert.ok(!('signupChecks' in ((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as object)))
  })

  it('SIGNUP_PER_IP_PER_DAY: counted per address (IPv6 per /64), recorded only while set', async () => {
    const before = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM signup_events`)) as unknown as { n: number }[])[0].n)
    assert.equal(before, 0) // nothing recorded while the setting was off
    const restore = setLimitsForTests({ signupPerIpPerDay: 2 })
    try {
      const ip = '192.0.2.10'
      assert.equal((await register(person({ formMs: 3000 }), { ip })).statusCode, 200)
      assert.equal((await register(person({ formMs: 3000 }), { ip })).statusCode, 200)
      const third = await register(person({ formMs: 3000 }), { ip })
      assert.equal(third.statusCode, 429)
      assert.equal(third.json().error.code, 'SIGNUP_IP_LIMIT')
      assert.equal((await register(person({ formMs: 3000 }), { ip: '192.0.2.11' })).statusCode, 200)
      // one IPv6 /64 is one address
      assert.equal((await register(person({ formMs: 3000 }), { ip: '2001:db8:1:2::a' })).statusCode, 200)
      assert.equal((await register(person({ formMs: 3000 }), { ip: '2001:db8:1:2::b' })).statusCode, 200)
      assert.equal((await register(person({ formMs: 3000 }), { ip: '2001:db8:1:2:ffff::1' })).statusCode, 429)
      // X-Forwarded-For counts only from a trusted proxy: a direct client cannot pick its address
      const direct = await register(person({ formMs: 3000 }), { ip, headers: { 'x-forwarded-for': '198.18.0.1' } })
      assert.equal(direct.statusCode, 429)
      // behind a proxy on loopback, the forwarded address is the one counted
      const viaProxy = await register(person({ formMs: 3000 }), { ip: '127.0.0.1', headers: { 'x-forwarded-for': '198.18.0.2' }, via: proxied })
      assert.equal(viaProxy.statusCode, 200, viaProxy.body)
      const rows = (await db.execute(sql`SELECT ip FROM signup_events ORDER BY id`)) as unknown as { ip: string }[]
      assert.deepEqual(rows.map((r) => r.ip), ['192.0.2.10', '192.0.2.10', '192.0.2.11', '2001:db8:1:2::/64', '2001:db8:1:2::/64', '198.18.0.2'])
    } finally {
      restore()
    }
  })

  it('bot checks only with a sign-up limit: the hidden field must be empty, the form shown for 2 s', async () => {
    const restore = setLimitsForTests({ signupMaxUsers: 10_000 })
    try {
      const code = async (extra: Record<string, unknown>) => (await register(person(extra))).json().error?.code ?? 'ok'
      assert.equal(await code({ formMs: 2500, website: 'http://spam.example' }), 'SIGNUP_CHECK_FAILED')
      assert.equal(await code({ formMs: 500 }), 'SIGNUP_CHECK_FAILED')
      assert.equal(await code({}), 'SIGNUP_CHECK_FAILED')
      assert.equal(await code({ formMs: 2500, website: '' }), 'ok')
    } finally {
      restore()
    }
    // no limit set: the same bodies sign up as before
    assert.equal((await register(person({ website: 'http://spam.example' }))).statusCode, 200)
  })

  // --- retention ---
  it('retention: sign-up IPs after 30 days; IP bans only when they ended more than 30 days ago', async () => {
    const day = 86_400_000
    await db.execute(sql`DELETE FROM signup_events`)
    await db.insert(schema.signupEvents).values([
      { ip: 'old', createdAt: new Date(Date.now() - 31 * day) },
      { ip: 'new', createdAt: new Date(Date.now() - 29 * day) },
    ])
    const ban = async (ip: string, until: Date, created = new Date(Date.now() - 60 * day)) =>
      (await db.insert(schema.ipBans).values({ ip, reason: 'auto:login', bannedUntil: until, createdAt: created }).returning({ id: schema.ipBans.id }))[0].id
    const active = await ban('a', new Date(Date.now() + 365 * day))
    const recent = await ban('b', new Date(Date.now() - 10 * day))
    const old = await ban('c', new Date(Date.now() - 31 * day))
    const r = await purgeAccountRecords()
    assert.deepEqual(r, { signupEvents: 1, ipBans: 1 })
    const left = (await db.select({ id: schema.ipBans.id }).from(schema.ipBans)).map((x) => x.id).sort()
    assert.deepEqual(left, [active, recent].sort())
    assert.ok(!left.includes(old))
    const ips = (await db.select({ ip: schema.signupEvents.ip }).from(schema.signupEvents)).map((x) => x.ip)
    assert.deepEqual(ips, ['new'])
  })
})
