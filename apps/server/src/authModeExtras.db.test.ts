// Restricted-mode registration places (docs/adr/2503-*): with nothing registered GET /api/auth/mode
// and GET /api/auth/me answer as before; registered fields are merged in.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
for (const k of [
  'DELEGATED_AUTH_URL', 'DELEGATED_AUTH_NAME', 'DELEGATED_EMAIL_DOMAIN', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET',
  'SMTP_HOST', 'MAIL_FROM', 'DEFAULT_LOCALE', 'EXPERIMENTAL_FEATURES', 'REQUIRE_EMAIL_VERIFICATION', 'NODE_ENV',
  'LOGIN_ID_MODE', 'SIGNUP_MAX_USERS', 'ACCOUNT_LIFETIME_DAYS', 'DISABLED_FEATURES', 'WORKSPACE_RESTORE_DAYS', 'LEGAL_DIR', 'INSTANCE_LABEL',
]) delete process.env[k]
process.env.SIGNUP_REQUIRE_KEY = '0'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] auth mode and me extras', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('./mcpTools/testHarness')
  let x: typeof import('./restrictedExtras')
  let closeDb: () => Promise<void>

  before(async () => {
    h = await import('./mcpTools/testHarness')
    x = await import('./restrictedExtras')
    ;({ closeDb } = await import('./db/index'))
    const Fastify = (await import('fastify')).default
    app = Fastify()
    await app.register(import('@fastify/cookie'))
    await app.register(
      async (api) => {
        await (await import('./routes/auth')).registerAuthRoutes(api)
        await (await import('./restricted')).registerRestrictedMode(api)
      },
      { prefix: '/api' },
    )
    await app.ready()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  it('nothing registered: the same answers as without the registration places', async () => {
    const mode = await app.inject({ method: 'GET', url: '/api/auth/mode' })
    assert.equal(
      mode.body,
      JSON.stringify({
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
      }),
    )
    const u = await h.makeUser('extras-plain')
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })).json() as { user: Record<string, unknown> }
    assert.deepEqual(Object.keys(me.user), ['id', 'email', 'name', 'isAdmin', 'origin', 'emailVerified', 'locale', 'sidebar', 'twoFactor', 'logins'])
  })

  it('registered fields are merged into both answers', async () => {
    const u = await h.makeUser('extras-on')
    const offMode = x.registerAuthModeExtra('test-legal', async () => ({ legal: { version: 'abc123def456', docs: ['terms', 'privacy'] } }))
    const offMe = x.registerMeExtra('test-consent', async (user) => (user.id === u.id ? { consentRequired: true } : {}))
    try {
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
      assert.deepEqual(mode.legal, { version: 'abc123def456', docs: ['terms', 'privacy'] })
      assert.equal(mode.delegated, false)
      const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })).json() as { user: Record<string, unknown> }
      assert.equal(me.user.consentRequired, true)
      assert.equal(me.user.id, u.id)
    } finally {
      offMode()
      offMe()
    }
    const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
    assert.ok(!('legal' in mode))
  })
})
