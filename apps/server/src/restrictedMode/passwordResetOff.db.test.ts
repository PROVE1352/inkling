// DISABLED_FEATURES=password-reset with sign-in IDs (0.22 integration): every way to set a password
// without knowing the current one is closed, for an ID account too. The request and reset routes, the
// admin's reset code, temporary password, mailing of either and the request queue all answer 404
// FEATURE_DISABLED; the only password change left is the signed-in person's own, with the current
// password. With the feature on, an ID account's reset code works as before (that is why it must be off).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.SIGNUP_REQUIRE_KEY = '0'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] password-reset turned off closes every reset path', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('./restrictedTestKit')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { createSession, hashPassword, SESSION_COOKIE } = await import('../auth')
  const { setLimitsForTests } = await import('../limits')
  const app = await kit.buildRestrictedApp()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const tag = () => randomBytes(4).toString('hex')
  const [admin] = await db.insert(schema.users).values({ email: `reset-admin-${tag()}@t.t`, name: 'Reset admin', passwordHash: 'x', isAdmin: true }).returning()
  const adminCookie = `${SESSION_COOKIE}=${(await createSession(admin.id)).token}`
  const loginId = `resetid${tag()}`
  const [person] = await db.insert(schema.users).values({ email: loginId, name: 'ID person', passwordHash: await hashPassword('password123') }).returning()
  const personCookie = `${SESSION_COOKIE}=${(await createSession(person.id)).token}`
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

  const paths = (): [string, string, Record<string, string>, unknown][] => [
    ['POST', '/api/auth/forgot-password', {}, { email: loginId, note: 'forgot' }],
    ['POST', '/api/auth/reset-password', {}, { email: loginId, code: 'ABCD-EFGH', newPassword: 'another-password' }],
    ['POST', `/api/admin/users/${person.id}/temp-password`, { cookie: adminCookie }, {}],
    ['POST', `/api/admin/users/${person.id}/reset-code`, { cookie: adminCookie }, {}],
    ['POST', `/api/admin/users/${person.id}/send-credential`, { cookie: adminCookie }, { kind: 'reset-code', secret: 'ABCD-EFGH' }],
    ['GET', '/api/admin/reset-requests', { cookie: adminCookie }, undefined],
    ['POST', `/api/admin/reset-requests/${person.id}/dismiss`, { cookie: adminCookie }, {}],
  ]

  it('off, ID mode: all seven answer 404 FEATURE_DISABLED and the password is unchanged', async () => {
    const restore = setLimitsForTests({ loginIdMode: 'username', disabledFeatures: ['password-reset'] })
    try {
      for (const [method, url, headers, payload] of paths()) {
        const r = await app.inject({ method: method as 'POST', url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        assert.equal(r.statusCode, 404, `${method} ${url}: ${r.body}`)
        assert.equal(codeOf(r), 'FEATURE_DISABLED', `${method} ${url}`)
      }
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: loginId, password: 'password123' } })
      assert.equal(login.statusCode, 200, login.body)
      // the person's own change, with the current password, stays
      const own = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie: personCookie }, payload: { currentPassword: 'password123', newPassword: 'password456' } })
      assert.equal(own.statusCode, 200, own.body)
    } finally {
      restore()
    }
  })

  it('on (as on a server without the setting): an admin reset code works for an ID account, which is why the ID mode requires it off', async () => {
    const code = await app.inject({ method: 'POST', url: `/api/admin/users/${person.id}/reset-code`, headers: { cookie: adminCookie }, payload: {} })
    assert.equal(code.statusCode, 200, code.body)
    const secret = (code.json() as { code?: string; secret?: string }).code ?? (code.json() as { secret?: string }).secret
    assert.ok(secret, code.body)
    const r = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { email: loginId, code: secret, newPassword: 'reset-password-1' } })
    assert.equal(r.statusCode, 200, r.body)
  })
})
