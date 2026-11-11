// Restricted mode (docs/adr/2500-*): GET /api/auth/mode and GET /api/auth/me are those of 0.21.1
// until the operator sets something, byte for byte; each setting adds its own field.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db

// A plain server: no delegated sign-in, OIDC, mail, default locale, experimental features or
// restricted settings, whatever the shell running the tests has.
for (const k of [
  'DELEGATED_AUTH_URL', 'DELEGATED_AUTH_NAME', 'DELEGATED_EMAIL_DOMAIN', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET',
  'SMTP_HOST', 'MAIL_FROM', 'DEFAULT_LOCALE', 'EXPERIMENTAL_FEATURES', 'REQUIRE_EMAIL_VERIFICATION', 'NODE_ENV',
  'LOGIN_ID_MODE', 'SIGNUP_MAX_USERS', 'SIGNUP_PER_IP_PER_DAY', 'ACCOUNT_LIFETIME_DAYS', 'ACCOUNT_LIFETIME_DRY_RUN',
  'LIMIT_WORKSPACES_PER_USER', 'LIMIT_MEMBERS_PER_WORKSPACE', 'LIMIT_PAGES_PER_WORKSPACE', 'LIMIT_FILE_MB',
  'LIMIT_WORKSPACE_STORAGE_MB', 'LIMIT_VERSIONS_PER_PAGE', 'DISABLED_FEATURES', 'WORKSPACE_RESTORE_DAYS', 'LEGAL_DIR', 'INSTANCE_LABEL',
]) delete process.env[k]
process.env.SIGNUP_REQUIRE_KEY = '0'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] auth mode and me: inert by default, a field per restricted setting', { skip: !process.env.DATABASE_URL }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let h: typeof import('./mcpTools/testHarness')
  let closeDb: () => Promise<void>
  let limitsMod: typeof import('./limits')

  async function buildApp() {
    const Fastify = (await import('fastify')).default
    const { AppError } = await import('./errors')
    const a = Fastify()
    await a.register(import('@fastify/cookie'))
    a.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await a.register(async (api) => (await import('./routes/auth')).registerAuthRoutes(api), { prefix: '/api' })
    await a.ready()
    return a
  }

  before(async () => {
    h = await import('./mcpTools/testHarness')
    ;({ closeDb } = await import('./db/index'))
    limitsMod = await import('./limits')
    app = await buildApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const mode = () => app.inject({ method: 'GET', url: '/api/auth/mode' })

  it('with no restricted setting the answer is exactly the 0.21.1 one (same keys, same order, nothing undefined)', async () => {
    const res = await mode()
    assert.equal(res.statusCode, 200)
    // 0.21.1's /api/auth/mode on a plain server, written out
    const v0211 = {
      delegated: false,
      delegatedName: 'External account',
      delegatedEmailDomain: 'delegated.local',
      signupKeyRequired: false,
      mailEnabled: false,
      emailVerificationRequired: false,
      experimental: [],
      oidc: null,
      defaultLocale: null,
      setupPending: false,
    }
    assert.equal(res.body, JSON.stringify(v0211))
    assert.deepEqual(Object.keys(res.json()), Object.keys(v0211))
  })

  it('each setting adds its field; signupFull only once the account cap is reached', async () => {
    await h.makeUser('authmode-cap') // at least one account, whatever ran before
    const restore = limitsMod.setLimitsForTests({
      loginIdMode: 'username',
      signupMaxUsers: 1,
      instanceLabel: 'Demo',
      accountLifetimeDays: 14,
      disabledFeatures: ['ical', 'public-links', 'webhooks'],
      workspacesPerUser: 2,
      membersPerWorkspace: 4,
      pagesPerWorkspace: 300,
      fileMb: 5,
      workspaceStorageMb: 20,
      versionsPerPage: 10, // not shown: nothing on screen needs it
      workspaceRestoreDays: 7,
    })
    try {
      const body = (await mode()).json() as Record<string, unknown>
      assert.equal(body.loginId, 'username')
      assert.equal(body.signupFull, true)
      assert.equal(body.instanceLabel, 'Demo')
      assert.equal(body.accountLifetimeDays, 14)
      assert.deepEqual(body.disabledFeatures, ['ical', 'public-links', 'webhooks'])
      assert.deepEqual(body.limits, { workspacesPerUser: 2, membersPerWorkspace: 4, pagesPerWorkspace: 300, fileMb: 5, workspaceStorageMb: 20 })
      assert.equal(body.workspaceRestoreDays, 7)
      // LEGAL_DIR is not set: no legal block
      assert.ok(!('legal' in body))
    } finally {
      restore()
    }
    const restore2 = limitsMod.setLimitsForTests({ signupMaxUsers: 1_000_000_000, fileMb: 2.5 })
    try {
      const body = (await mode()).json() as Record<string, unknown>
      assert.ok(!('signupFull' in body), 'below the cap')
      assert.deepEqual(body.limits, { fileMb: 2.5 })
      for (const k of ['loginId', 'instanceLabel', 'accountLifetimeDays', 'disabledFeatures', 'workspaceRestoreDays']) assert.ok(!(k in body), k)
    } finally {
      restore2()
    }
    // and back to the plain answer
    assert.equal(Object.keys((await mode()).json()).length, 10)
  })

  it('/auth/me has expiresAt only for an account with an expiry date', async () => {
    const { db } = await import('./db/index')
    const schema = await import('./db/schema')
    const { eq } = await import('drizzle-orm')
    const u = await h.makeUser('authmode-me')
    const me = async () => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })).json() as { user: Record<string, unknown> }
    const plain = await me()
    assert.ok(!('expiresAt' in plain.user))
    assert.ok(!('consentRequired' in plain.user))
    // the 0.21.1 keys of a member's /auth/me
    assert.deepEqual(Object.keys(plain.user), ['id', 'email', 'name', 'isAdmin', 'origin', 'emailVerified', 'locale', 'sidebar', 'twoFactor', 'logins'])
    const at = new Date('2026-12-01T00:00:00.000Z')
    await db.update(schema.users).set({ expiresAt: at }).where(eq(schema.users.id, u.id))
    assert.equal((await me()).user.expiresAt, at.toISOString())
  })
})
