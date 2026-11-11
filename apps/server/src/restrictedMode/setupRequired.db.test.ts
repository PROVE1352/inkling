// SETUP_REQUIRED (0.22 integration, contract §13, docs/adr/2527-*): on a server in "restricted sign-up"
// (SIGNUP_MAX_USERS, SIGNUP_PER_IP_PER_DAY, ACCOUNT_LIFETIME_DAYS or LOGIN_ID_MODE=username) with no admin,
// a sign-up without the setup code is refused with 403 and leaves no account, concurrent ones included;
// the setup code still signs up (cap and bot checks do not apply to it, the consent check does); once an
// admin exists sign-up is as usual; without restricted sign-up the first account becomes admin as in 0.21.1.
// "No admin yet" needs a database without accounts, so this file has its own.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.SIGNUP_REQUIRE_KEY = '0'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] SETUP_REQUIRED: restricted sign-up waits for the setup-code admin', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('./restrictedTestKit')
  const drop = await kit.scratchDatabase('setupreq')
  const { db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { setLimitsForTests } = await import('../limits')
  const setup = await import('../firstAdminSetup')
  const legal = await import('../legal/register')
  const app = await kit.buildRestrictedApp()
  const dir = mkdtempSync(path.join(tmpdir(), 'inkling-setupreq-'))
  writeFileSync(path.join(dir, 'terms.en.md'), '# Terms\n')
  writeFileSync(
    path.join(dir, 'signup.json'),
    JSON.stringify({ items: [{ id: 'terms', required: true, doc: 'terms', label: { ko: '약관에 동의합니다.', en: 'I agree.' } }] }),
  )
  after(async () => {
    legal.resetLegalForTests()
    await app.close()
    await drop()
    rmSync(dir, { recursive: true, force: true })
  })

  const tag = () => randomBytes(4).toString('hex')
  let ip = 0
  const register = (body: Record<string, unknown>, via = app) =>
    via.inject({ method: 'POST', url: '/api/auth/register', payload: body, remoteAddress: `203.0.113.${(ip++ % 250) + 1}` })
  const person = (extra: Record<string, unknown> = {}) => ({ email: `s-${tag()}@example.com`, name: `S ${tag()}`, password: 'password123', formMs: 5000, ...extra })
  const users = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM users`)) as unknown as { n: number }[])[0].n)
  const workspaces = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspaces`)) as unknown as { n: number }[])[0].n)
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const mode = async () => (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { setupPending?: boolean }
  const reset = async () => {
    await db.execute(sql`DELETE FROM users`)
    await db.execute(sql`DELETE FROM workspaces`)
    await db.execute(sql`DELETE FROM signup_events`)
  }

  const RESTRICTED: [string, Parameters<typeof setLimitsForTests>[0]][] = [
    ['SIGNUP_MAX_USERS', { signupMaxUsers: 50 }],
    ['SIGNUP_PER_IP_PER_DAY', { signupPerIpPerDay: 2 }],
    ['ACCOUNT_LIFETIME_DAYS', { accountLifetimeDays: 14 }],
    ['LOGIN_ID_MODE=username', { loginIdMode: 'username', disabledFeatures: ['password-reset'] }],
  ]

  for (const [name, settings] of RESTRICTED) {
    it(`${name}, no admin, no setup code: 403 SETUP_REQUIRED and no account, eight at once too`, async () => {
      await reset()
      const restore = setLimitsForTests(settings)
      try {
        const body = (i: number) => (settings.loginIdMode === 'username' ? { loginId: `first${i}${tag()}`, name: 'N', password: 'password123', formMs: 5000 } : person())
        const one = await register(body(0))
        assert.equal(one.statusCode, 403, one.body)
        assert.equal(codeOf(one), 'SETUP_REQUIRED')
        const many = await Promise.all(Array.from({ length: 8 }, (_, i) => register(body(i + 1))))
        for (const r of many) assert.equal(codeOf(r), 'SETUP_REQUIRED', r.body)
        assert.equal(await users(), 0)
        assert.equal(await workspaces(), 0)
        assert.equal(Number(((await db.execute(sql`SELECT count(*)::int AS n FROM signup_events`)) as unknown as { n: number }[])[0].n), 0)
      } finally {
        restore()
      }
    })
  }

  it('SETUP_REQUIRED comes before the bot checks and the consent check (nothing else hides it)', async () => {
    await reset()
    const restore = setLimitsForTests({ signupMaxUsers: 50, legalDir: dir })
    try {
      const app2 = await kit.buildRestrictedApp()
      try {
        const r = await register({ email: `b-${tag()}@example.com`, name: 'B', password: 'password123', website: 'spam' }, app2)
        assert.equal(codeOf(r), 'SETUP_REQUIRED', r.body)
      } finally {
        await app2.close()
      }
    } finally {
      restore()
      legal.resetLegalForTests()
    }
  })

  it('the setup code signs up (admin, past the account cap and without bot fields) but must consent; then sign-ups are as usual', async () => {
    await reset()
    const code = await setup.prepareFirstAdminSetup()
    assert.ok(code)
    const restore = setLimitsForTests({ signupMaxUsers: 1, signupPerIpPerDay: 1, accountLifetimeDays: 14, legalDir: dir })
    try {
      const app2 = await kit.buildRestrictedApp()
      try {
        assert.equal((await app2.inject({ method: 'GET', url: '/api/auth/mode' })).json().setupPending, true)
        const version = ((await app2.inject({ method: 'GET', url: '/api/legal' })).json() as { version: string }).version
        const op = { email: `op-${tag()}@example.com`, name: 'Operator', password: 'password123', setupCode: code }
        const noConsent = await register(op, app2)
        assert.equal(codeOf(noConsent), 'CONSENT_REQUIRED', noConsent.body)
        assert.equal(await users(), 0)
        const ok = await register({ ...op, consents: ['terms'], legalVersion: version }, app2)
        assert.equal(ok.statusCode, 200, ok.body)
        const [u] = await db.select().from(schema.users).where(eq(schema.users.email, op.email))
        assert.equal(u.isAdmin, true)
        assert.equal(u.expiresAt, null)
        assert.equal((await app2.inject({ method: 'GET', url: '/api/auth/mode' })).json().setupPending, false)
        // the cap (1) is reached by the operator: the next sign-up meets the cap, not SETUP_REQUIRED
        const full = await register({ ...person(), consents: ['terms'], legalVersion: version }, app2)
        assert.equal(codeOf(full), 'SIGNUP_FULL', full.body)
      } finally {
        await app2.close()
      }
    } finally {
      restore()
      legal.resetLegalForTests()
    }
    // with an admin, restricted sign-up works as usual and never promotes
    const r2 = setLimitsForTests({ signupMaxUsers: 50, accountLifetimeDays: 14 })
    try {
      const p = person()
      const r = await register(p)
      assert.equal(r.statusCode, 200, r.body)
      const [u] = await db.select().from(schema.users).where(eq(schema.users.email, p.email))
      assert.equal(u.isAdmin, false)
      assert.ok(u.expiresAt)
    } finally {
      r2()
    }
  })

  it('not restricted: the first sign-up becomes admin as in 0.21.1, setupPending as before', async () => {
    await reset()
    await setup.prepareFirstAdminSetup()
    assert.equal((await mode()).setupPending, true)
    const p = person()
    const r = await register(p)
    assert.equal(r.statusCode, 200, r.body)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, p.email))
    assert.equal(u.isAdmin, true)
    assert.equal((await mode()).setupPending, false)
    const q = person()
    assert.equal((await register(q)).statusCode, 200)
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.email, q.email)))[0].isAdmin, false)
  })

  it('INSTANCE_NOTICE reaches /auth/mode only when set', async () => {
    assert.ok(!('instanceNotice' in (await mode())))
    const restore = setLimitsForTests({ instanceNotice: 'Maintenance on Friday\n02:00–03:00' })
    try {
      assert.equal(((await mode()) as { instanceNotice?: string }).instanceNotice, 'Maintenance on Friday\n02:00–03:00')
    } finally {
      restore()
    }
    assert.ok(!('instanceNotice' in (await mode())))
  })
})
