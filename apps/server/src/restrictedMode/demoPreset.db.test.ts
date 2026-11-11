// The whole demo preset at once (0.22 integration, contract §11, §13; docs/adr/2525-*..2529-*): the values
// of deploy/demo/demo.env.example and the terms folder deploy/demo/legal, with every piece registered as
// index.ts does.
//  - One sign-up passes the hooks of all pieces (ID rules, account cap, per-IP cap, bot checks, consent
//    check) and writes users.expires_at, user_consents and signup_events in one transaction: a failure
//    after them leaves none of the three, and a missing required item leaves no signup_events row either.
//  - Sign up → pages up to the limit → LIMIT_PAGES (concurrent requests included) → leave → no trace.
//  - A person without consent, behind the real consent gate, can still preview and finish deleting the
//    account: a local account with its password, an OIDC account with a sign-in younger than ten minutes.
// "No admin yet" and the account cap need a database of their own.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.PUBLIC_URL ||= 'https://demo.example.com/'
process.env.APP_URL ||= 'https://demo.example.com'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** KEY=value lines of an env file (comments and blanks skipped), as compose reads this simple file. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

describe('[db] the demo preset end to end', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('./restrictedTestKit')
  const drop = await kit.scratchDatabase('demopreset')
  const { db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const setup = await import('../firstAdminSetup')
  const legal = await import('../legal/register')
  const { registerSignupHook } = await import('../signupHooks')
  const { createSession, hashPassword, SESSION_COOKIE } = await import('../auth')
  const { AppError } = await import('../errors')

  // the preset as the operator ships it, the terms folder of the repository (placeholders left in)
  const presetEnv = { ...readEnvFile(path.join(repo, 'deploy/demo/demo.env.example')), LEGAL_DIR: path.join(repo, 'deploy/demo/legal') }
  const preset = L.parseLimitsEnv(presetEnv)
  assert.equal(preset.loginIdMode, 'username')
  assert.equal(preset.pagesPerWorkspace, 300)
  assert.equal(preset.trashDays, 7, 'the preset keeps the trash 7 days (the privacy policy says so)')
  const restoreLimits = L.setLimitsForTests(preset)
  assert.doesNotThrow(() => L.assertLimitsCompatible(L.limits, { delegated: false, oidc: false, mail: false }))
  const app = await kit.buildRestrictedApp()
  after(async () => {
    legal.resetLegalForTests()
    restoreLimits()
    await app.close()
    await drop()
  })

  const tag = () => randomBytes(3).toString('hex')
  const count = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as unknown as { n: number }[])[0].n)
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const legalInfo = (await app.inject({ method: 'GET', url: '/api/legal?locale=ko' })).json() as { version: string; items: { id: string; required: boolean }[] }
  const REQUIRED = legalInfo.items.filter((i) => i.required).map((i) => i.id)
  assert.equal(REQUIRED.length, 6)
  const register = (body: Record<string, unknown>, ip: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: body, remoteAddress: ip })
  const newcomer = (extra: Record<string, unknown> = {}) => ({
    loginId: `demo${tag()}`,
    name: `별명${tag()}`,
    password: 'password123',
    consents: REQUIRED,
    legalVersion: legalInfo.version,
    formMs: 3200,
    website: '',
    ...extra,
  })
  /** Every text/json column holding `needle`, every uuid column holding `id`. */
  const traces = async (id: string, needles: string[]): Promise<string[]> => {
    const hits: string[] = []
    const uuids = (await db.execute(sql`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'uuid'`)) as unknown as { t: string; c: string }[]
    for (const { t, c } of uuids) {
      if ((await count(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${id}::uuid`)) > 0) hits.push(`${t}.${c}`)
    }
    const texts = (await db.execute(sql`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY') AND table_name NOT LIKE '\\_\\_%'
    `)) as unknown as { t: string; c: string }[]
    for (const needle of needles) {
      const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      for (const { t, c } of texts) {
        if ((await count(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)}::text LIKE ${like}`)) > 0) hits.push(`${t}.${c} ~ ${needle}`)
      }
    }
    return hits
  }

  let operatorCookie = ''

  it('before the operator: SETUP_REQUIRED; the operator signs up with the setup code and the six consents', async () => {
    const refused = await register(newcomer(), '198.51.100.10')
    assert.equal(codeOf(refused), 'SETUP_REQUIRED', refused.body)
    const code = await setup.prepareFirstAdminSetup()
    const op = await register(newcomer({ loginId: 'operator1', setupCode: code, formMs: undefined }), '198.51.100.10')
    assert.equal(op.statusCode, 200, op.body)
    operatorCookie = kit.cookieOf(op)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, 'operator1'))
    assert.equal(u.isAdmin, true)
    assert.equal(u.expiresAt, null)
    assert.equal(await count(sql`SELECT count(*)::int AS n FROM user_consents WHERE user_id = ${u.id}`), 6)
    // the setup-code sign-up is not counted against the address
    assert.equal(await count(sql`SELECT count(*)::int AS n FROM signup_events`), 0)
  })

  it('one sign-up passes every piece and writes expires_at, user_consents and signup_events together', async () => {
    const p = newcomer()
    const r = await register(p, '198.51.100.20')
    assert.equal(r.statusCode, 200, r.body)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, p.loginId))
    assert.equal(u.isAdmin, false)
    const days = (u.expiresAt!.getTime() - Date.now()) / 86_400_000
    assert.ok(days > 13.99 && days <= 14, String(days))
    const rows = await db.select().from(schema.userConsents).where(eq(schema.userConsents.userId, u.id))
    assert.deepEqual(rows.map((x) => x.itemId).sort(), [...REQUIRED].sort())
    assert.ok(rows.every((x) => x.version === legalInfo.version))
    assert.equal(await count(sql`SELECT count(*)::int AS n FROM signup_events WHERE ip = '198.51.100.20'`), 1)
    // /auth/me: the expiry date, no consent screen
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: kit.cookieOf(r) } })).json() as { user: { expiresAt?: string; consentRequired?: boolean } }
    assert.ok(me.user.expiresAt)
    assert.ok(!('consentRequired' in me.user))
  })

  it('a failure after the hooks leaves none of the three; a missing item leaves no signup_events row', async () => {
    const before = {
      users: await count(sql`SELECT count(*)::int AS n FROM users`),
      consents: await count(sql`SELECT count(*)::int AS n FROM user_consents`),
      events: await count(sql`SELECT count(*)::int AS n FROM signup_events`),
    }
    // an extra `on` hook registered after every piece's, failing inside the same transaction
    const off = registerSignupHook('w22g-test-fails-last', {
      on: () => {
        throw new AppError(409, 'TEST_ROLLBACK', 'rolled back on purpose')
      },
    })
    try {
      const r = await register(newcomer(), '198.51.100.30')
      assert.equal(codeOf(r), 'TEST_ROLLBACK', r.body)
    } finally {
      off()
    }
    const missing = await register(newcomer({ consents: REQUIRED.slice(1) }), '198.51.100.31')
    assert.equal(missing.statusCode, 400)
    assert.equal(codeOf(missing), 'CONSENT_REQUIRED')
    const stale = await register(newcomer({ legalVersion: '000000000000' }), '198.51.100.31')
    assert.equal(codeOf(stale), 'CONSENT_REQUIRED')
    assert.deepEqual(
      {
        users: await count(sql`SELECT count(*)::int AS n FROM users`),
        consents: await count(sql`SELECT count(*)::int AS n FROM user_consents`),
        events: await count(sql`SELECT count(*)::int AS n FROM signup_events`),
      },
      before,
    )
  })

  it('the per-address cap (2 a day) and the bot checks still answer under the preset', async () => {
    assert.equal((await register(newcomer(), '198.51.100.40')).statusCode, 200)
    assert.equal((await register(newcomer(), '198.51.100.40')).statusCode, 200)
    assert.equal(codeOf(await register(newcomer(), '198.51.100.40')), 'SIGNUP_IP_LIMIT')
    assert.equal(codeOf(await register(newcomer({ formMs: 100 }), '198.51.100.41')), 'SIGNUP_CHECK_FAILED')
    assert.equal(codeOf(await register(newcomer({ loginId: 'admin' }), '198.51.100.42')), 'LOGIN_ID_INVALID')
  })

  it('sign up → pages up to 300 → LIMIT_PAGES (the last places raced) → leave → nothing of the person remains', async () => {
    const p = newcomer()
    const r = await register(p, '198.51.100.50')
    assert.equal(r.statusCode, 200, r.body)
    const cookie = kit.cookieOf(r)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, p.loginId))
    const list = (await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie } })).json() as { workspaces: { id: string }[] }
    assert.equal(list.workspaces.length, 1)
    const wsId = list.workspaces[0].id
    const newPage = (i: number) => app.inject({ method: 'POST', url: '/api/pages', headers: { cookie }, payload: { workspaceId: wsId, title: `Page ${i}` } })
    const pagesNow = () => count(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${wsId}`)
    let made = await pagesNow()
    while (made < 290) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, 290 - made) }, (_, i) => newPage(made + i)))
      for (const b of batch) assert.equal(b.statusCode, 200, b.body)
      made = await pagesNow()
    }
    const race = await Promise.all(Array.from({ length: 16 }, (_, i) => newPage(1000 + i)))
    assert.equal(race.filter((x) => x.statusCode === 200).length, 10)
    for (const x of race) if (x.statusCode !== 200) assert.equal(codeOf(x), 'LIMIT_PAGES', x.body)
    assert.equal(await pagesNow(), 300)
    const refused = await newPage(2000)
    assert.equal(refused.statusCode, 403)
    assert.deepEqual([codeOf(refused), (refused.json() as { error: { limit: number; used: number } }).error.limit], ['LIMIT_PAGES', 300])

    const preview = await app.inject({ method: 'GET', url: '/api/me/delete-preview', headers: { cookie } })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.deepEqual((preview.json() as { deleted: { pages: number }[] }).deleted.map((w) => w.pages), [300])
    const gone = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: p.loginId, password: p.password } })
    assert.equal(gone.statusCode, 200, gone.body)
    assert.equal(await pagesNow(), 0)
    assert.deepEqual(await traces(u.id, [p.loginId, p.name]), [])
  })

  it('without consent (behind the real gate): preview and delete the account, local with its password', async () => {
    const id = `noconsent${tag()}`
    const [u] = await db.insert(schema.users).values({ email: id, name: `동의 전 ${tag()}`, passwordHash: await hashPassword('password123'), origin: 'local' }).returning()
    const cookie = `${SESSION_COOKIE}=${(await createSession(u.id)).token}`
    // the gate is on: the app refuses, /auth/me says why
    const blocked = await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie } })
    assert.equal(codeOf(blocked), 'CONSENT_REQUIRED')
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json() as { user: { consentRequired?: boolean } }
    assert.equal(me.user.consentRequired, true)
    const preview = await app.inject({ method: 'GET', url: '/api/me/delete-preview', headers: { cookie } })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.deepEqual((preview.json() as { needs: unknown }).needs, { password: true, code: false, recentSignIn: false })
    const r = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: id, password: 'password123' } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, u.id))).length, 0)
  })

  it('without consent: an OIDC account deletes with a sign-in younger than ten minutes, else REAUTH_REQUIRED', async () => {
    const [u] = await db.insert(schema.users).values({ email: `oidc-${tag()}@example.com`, name: 'OIDC person', passwordHash: 'x', origin: 'oidc' }).returning()
    const cookie = `${SESSION_COOKIE}=${(await createSession(u.id)).token}`
    assert.equal(codeOf(await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie } })), 'CONSENT_REQUIRED')
    const preview = await app.inject({ method: 'GET', url: '/api/me/delete-preview', headers: { cookie } })
    assert.deepEqual((preview.json() as { needs: unknown }).needs, { password: false, code: false, recentSignIn: true })
    // an old sign-in first
    await db.execute(sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE user_id = ${u.id}`)
    const old = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: u.email } })
    assert.equal(codeOf(old), 'REAUTH_REQUIRED', old.body)
    // signed in again just now
    const fresh = `${SESSION_COOKIE}=${(await createSession(u.id)).token}`
    const r = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: fresh }, payload: { confirm: u.email } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, u.id))).length, 0)
  })

  it('the operator keeps the app: /auth/mode carries the preset, the consent gate does not stop the operator', async () => {
    const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
    assert.equal(mode.loginId, 'username')
    assert.equal(mode.instanceLabel, 'Demo')
    assert.deepEqual((mode.limits as { trashDays?: number }).trashDays, 7)
    assert.ok((mode.disabledFeatures as string[]).includes('password-reset'))
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: operatorCookie } })).statusCode, 200)
  })
})
