// Terms, privacy and consent (LEGAL_DIR, restricted mode 0.22, docs/adr/2519-*).
//  - Without LEGAL_DIR nothing shows: /api/legal is 404, /auth/mode has no `legal`, a sign-up without
//    `consents` works as in 0.21.1.
//  - Sign-up: a missing required item, an unknown item or another version refuses it and leaves no
//    account; a good one writes one consent row per ticked item in the account's transaction.
//  - A person without consent to the current version is refused on every way in (cookie, API token,
//    MCP door and the REST its tools call, collaboration socket); the exempt routes pass; agreeing
//    lifts it at once; a changed document (new version) refuses them again.
//  - A bad signup.json stops the server from booting.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] terms and consent (LEGAL_DIR)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { createSession, SESSION_COOKIE } = await import('../auth')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
  const { setLimitsForTests, limits } = await import('../limits')
  const { AUTOMATION_RUN_HEADER, withRunToken } = await import('../automations/context')
  const consent = await import('./consent')
  const legal = await import('./register')
  const { LegalConfigError } = await import('./bundle')
  const collab = await import('../collab')

  const folders: string[] = []
  const folder = (files: Record<string, string | object>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkling-legal-db-'))
    folders.push(dir)
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
    return dir
  }
  const legalDir = folder({
    'terms.en.md': '# Terms\n\nBe nice.\n',
    'privacy.ko.md': '# 개인정보 처리방침\n\n수집하는 정보는 아이디뿐입니다.\n',
    'signup.json': {
      notice: { ko: '데모 서비스입니다.', en: 'This is a demo service.' },
      items: [
        { id: 'demo_notice', required: true, label: { ko: '안내를 읽었습니다.', en: 'I read the notice.' } },
        { id: 'terms', required: true, doc: 'terms', label: { ko: '이용약관에 동의합니다.', en: 'I agree to the terms.' } },
        { id: 'privacy', required: true, doc: 'privacy', label: { ko: '개인정보 수집·이용에 동의합니다.', en: 'I agree to the privacy policy.' }, details: { ko: '| 항목 | 기간 |\n|---|---|\n| 아이디 | 14일 |' } },
        { id: 'news', required: false, label: { ko: '선택 항목입니다.', en: 'Optional.' } },
      ],
    },
  })
  const ALL = ['demo_notice', 'terms', 'privacy']

  const apps: FastifyInstance[] = []
  async function buildApp(): Promise<FastifyInstance> {
    const Fastify = (await import('fastify')).default
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String(err) } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        await (await import('../routes/auth')).registerAuthRoutes(api)
        await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
        await (await import('../routes/apiTokens')).registerApiTokenRoutes(api)
        // as index.ts: the restricted-mode pieces right after the auth routes
        await (await import('../restricted')).registerRestrictedMode(api)
      },
      { prefix: '/api' },
    )
    await app.register(async (pub) => (await import('../mcp')).registerMcpRoutes(pub, app))
    await app.ready()
    apps.push(app)
    return app
  }

  let restoreLimits: (() => void) | null = null
  after(async () => {
    legal.resetLegalForTests()
    restoreLimits?.()
    await collab.destroyCollab()
    for (const a of apps) await a.close()
    await closeDb()
    for (const d of folders) rmSync(d, { recursive: true, force: true })
  })

  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const errorOf = (r: { json: () => unknown }) => (r.json() as { error: Record<string, unknown> }).error
  let n = 0
  const person = (extra: Record<string, unknown> = {}) => {
    n += 1
    return { email: `legal${n}-${randomBytes(4).toString('hex')}@example.com`, name: `Legal ${n}`, password: 'password123', ...extra }
  }
  const accountOf = async (email: string) => (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0]
  const consentRows = async (userId: string) =>
    db.select().from(schema.userConsents).where(eq(schema.userConsents.userId, userId)).orderBy(schema.userConsents.itemId)

  // ---------------------------------------------------------------------------------------------
  // Without LEGAL_DIR (the app and the credentials below are made before the folder is switched on)
  // ---------------------------------------------------------------------------------------------
  assert.equal(limits.legalDir, null)
  const off = await buildApp()
  const blocked = await h.makeUser('legal-blocked')
  await h.makeWorkspace(blocked)
  const tokenRes = await off.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: blocked.cookie },
    payload: { name: 'legal', expiresInDays: 30, access: 'read', range: { kind: 'all' } },
  })
  assert.equal(tokenRes.statusCode, 201, tokenRes.body)
  const apiToken = (tokenRes.json() as { secret: string }).secret
  const oauthToken = await h.mintToken(blocked)

  it('without LEGAL_DIR: /api/legal is 404, /auth/mode has no legal, sign-up without consents works (0.21.1)', async () => {
    for (const [method, url] of [['GET', '/api/legal'], ['GET', '/api/legal/terms'], ['POST', '/api/legal/consent']] as const) {
      const r = await off.inject({ method, url, headers: { cookie: blocked.cookie } })
      assert.equal(r.statusCode, 404, `${method} ${url}`)
    }
    const mode = (await off.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
    assert.equal('legal' in mode, false)
    const p = person()
    const r = await off.inject({ method: 'POST', url: '/api/auth/register', payload: p })
    assert.equal(r.statusCode, 200, r.body)
    const u = await accountOf(p.email)
    assert.ok(u)
    assert.deepEqual(await consentRows(u.id), [])
    // stray consent fields are ignored, as before
    const p2 = person({ consents: ['x'], legalVersion: 'whatever' })
    assert.equal((await off.inject({ method: 'POST', url: '/api/auth/register', payload: p2 })).statusCode, 200)
    // and nobody is gated
    const me = (await off.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: blocked.cookie } })).json() as { user: Record<string, unknown> }
    assert.equal('consentRequired' in me.user, false)
    assert.equal((await off.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: blocked.cookie } })).statusCode, 200)
  })

  // ---------------------------------------------------------------------------------------------
  // With LEGAL_DIR
  // ---------------------------------------------------------------------------------------------
  let on: FastifyInstance
  let version = ''
  const get = (url: string, headers: Record<string, string> = {}) => on.inject({ method: 'GET', url, headers })

  it('with LEGAL_DIR: /api/legal answers the notice and items in the asked language; documents fall back to the other language', async () => {
    restoreLimits = setLimitsForTests({ legalDir })
    on = await buildApp()
    const ko = (await get('/api/legal?locale=ko')).json() as { version: string; notice: string; items: { id: string; label: string; doc?: string; details?: string; required: boolean }[] }
    version = ko.version
    assert.match(version, /^[0-9a-f]{12}$/)
    assert.equal(ko.notice, '데모 서비스입니다.')
    assert.deepEqual(ko.items.map((i) => [i.id, i.required, i.label, i.doc ?? null]), [
      ['demo_notice', true, '안내를 읽었습니다.', null],
      ['terms', true, '이용약관에 동의합니다.', 'terms'],
      ['privacy', true, '개인정보 수집·이용에 동의합니다.', 'privacy'],
      ['news', false, '선택 항목입니다.', null],
    ])
    assert.match(ko.items[2].details ?? '', /\| 아이디 \| 14일 \|/)
    const en = (await get('/api/legal', { 'accept-language': 'en-US,en;q=0.9' })).json() as { notice: string; items: { label: string; details?: string }[] }
    assert.equal(en.notice, 'This is a demo service.')
    assert.equal(en.items[1].label, 'I agree to the terms.')
    assert.match(en.items[2].details ?? '', /아이디/, 'details only in Korean: served to everyone')

    const terms = (await get('/api/legal/terms?locale=ko')).json() as { doc: string; version: string; locale: string; markdown: string }
    assert.deepEqual(terms, { doc: 'terms', version, locale: 'en', markdown: '# Terms\n\nBe nice.\n' })
    const privacy = (await get('/api/legal/privacy?locale=en')).json() as { locale: string; markdown: string }
    assert.equal(privacy.locale, 'ko')
    assert.match(privacy.markdown, /수집하는 정보는/)
    assert.equal((await get('/api/legal/cookies')).statusCode, 404)
    assert.equal((await get('/api/legal/..%2Fsignup.json')).statusCode, 404)

    const mode = (await get('/api/auth/mode')).json() as { legal?: unknown }
    assert.deepEqual(mode.legal, { version, docs: ['terms', 'privacy'] })
  })

  it('sign-up: a missing required item, an unknown item or another version is refused with the current version, and no account is made', async () => {
    const tries: [string, Record<string, unknown>][] = [
      ['no consent fields', {}],
      ['one required item missing', { consents: ['demo_notice', 'terms'], legalVersion: version }],
      ['an unknown item', { consents: [...ALL, 'made_up'], legalVersion: version }],
      ['another version', { consents: ALL, legalVersion: '000000000000' }],
      ['no version', { consents: ALL }],
    ]
    for (const [what, extra] of tries) {
      const p = person(extra)
      const r = await on.inject({ method: 'POST', url: '/api/auth/register', payload: p })
      assert.equal(r.statusCode, 400, `${what}: ${r.body}`)
      assert.equal(code(r), 'CONSENT_REQUIRED', what)
      assert.equal(errorOf(r).version, version, what)
      assert.equal(await accountOf(p.email), undefined, `${what}: no account`)
    }
  })

  it('sign-up with every required item (and an optional one) writes one consent row per item, with version and IP', async () => {
    const p = person({ consents: [...ALL, 'news'], legalVersion: version })
    const r = await on.inject({ method: 'POST', url: '/api/auth/register', payload: p, remoteAddress: '198.51.100.7' })
    assert.equal(r.statusCode, 200, r.body)
    const u = await accountOf(p.email)
    const rows = await consentRows(u.id)
    assert.deepEqual(rows.map((x) => x.itemId), ['demo_notice', 'news', 'privacy', 'terms'])
    assert.ok(rows.every((x) => x.version === version && x.ip === '198.51.100.7' && x.acceptedAt instanceof Date))
    // the new account is not asked again
    const cookie = String(r.headers['set-cookie']).split(';')[0]
    const me = (await get('/api/auth/me', { cookie })).json() as { user: Record<string, unknown> }
    assert.equal('consentRequired' in me.user, false)
    assert.equal((await get('/api/workspaces', { cookie })).statusCode, 200)
  })

  it('the first admin made with the setup code gets the same check', async () => {
    const body = { email: 'op@example.com', name: 'Op', password: 'password123' }
    assert.throws(
      () => legal.legalBeforeSignup({ body: body as never }),
      (err: unknown) => err instanceof AppError && err.code === 'CONSENT_REQUIRED',
    )
    legal.legalBeforeSignup({ body: { ...body, consents: ALL, legalVersion: version } as never })
  })

  const mcpInit = (token: string) =>
    on.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legal-test', version: '1' } } },
    })
  const collabAuth = (u: { id: string; cookie: string }) =>
    (collab.hocuspocus.configuration.onAuthenticate as (d: unknown) => Promise<unknown>)({
      requestHeaders: { cookie: u.cookie },
      documentName: `inbox:${u.id}`,
      connection: {},
      context: {},
    })

  it('without consent: cookie, API token, MCP (door and REST) and collab are refused; me says consentRequired; exempt routes pass', async () => {
    const me = (await get('/api/auth/me', { cookie: blocked.cookie }))
    assert.equal(me.statusCode, 200)
    assert.equal((me.json() as { user: { consentRequired?: boolean } }).user.consentRequired, true)

    const cookie = await get('/api/workspaces', { cookie: blocked.cookie })
    assert.equal(cookie.statusCode, 403)
    assert.equal(code(cookie), 'CONSENT_REQUIRED')
    assert.equal(errorOf(cookie).version, version)
    const bearer = await get('/api/workspaces', { authorization: `Bearer ${apiToken}` })
    assert.equal(bearer.statusCode, 403)
    assert.equal(code(bearer), 'CONSENT_REQUIRED')
    const viaTool = await get('/api/workspaces', { authorization: `Bearer ${oauthToken}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET })
    assert.equal(viaTool.statusCode, 403)
    const door = await mcpInit(oauthToken)
    assert.equal(door.statusCode, 403)
    assert.equal(code(door), 'CONSENT_REQUIRED')
    // what an agent relays to its person: what to do and where
    assert.match(String(errorOf(door).message), /agree to the terms of this server.*https:\/\/notes\.example\.com\//)
    await assert.rejects(collabAuth(blocked), /agree to the terms/)

    // exempt: who am I, the documents, sign-out (another session of the same person)
    assert.equal((await get('/api/legal', { cookie: blocked.cookie })).statusCode, 200)
    assert.equal((await get('/api/legal/terms', { authorization: `Bearer ${apiToken}` })).statusCode, 200)
    const extra = await createSession(blocked.id)
    const out = await on.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `${SESSION_COOKIE}=${extra.token}` } })
    assert.equal(out.statusCode, 204)
    // account deletion (piece B's routes) is never refused by this gate
    for (const [method, url] of [['DELETE', '/api/me'], ['GET', '/api/me/delete-preview']] as const) {
      const r = await on.inject({ method, url, headers: { cookie: blocked.cookie } })
      assert.notEqual(code(r), 'CONSENT_REQUIRED', `${method} ${url}`)
    }
  })

  it('automation runs (the server acting on a rule set up earlier) are not refused; the same person otherwise is', async () => {
    const author = { id: blocked.id, email: blocked.email, name: blocked.name, isAdmin: false }
    const run = await withRunToken({ ...author, automation: { ruleId: randomUUID(), depth: 0, chain: [] } }, (token) =>
      on.inject({ method: 'GET', url: '/api/workspaces', headers: { [AUTOMATION_RUN_HEADER]: token } }),
    )
    assert.equal(run.statusCode, 200, run.body)
    const plain = await withRunToken(author, (token) => on.inject({ method: 'GET', url: '/api/workspaces', headers: { [AUTOMATION_RUN_HEADER]: token } }))
    assert.equal(plain.statusCode, 403)
  })

  it('POST /api/legal/consent: browser only, checks the items and version, then lifts the gate at once for every way in', async () => {
    const body = { consents: ALL, legalVersion: version }
    const byToken = await on.inject({ method: 'POST', url: '/api/legal/consent', headers: { authorization: `Bearer ${apiToken}` }, payload: body })
    assert.equal(byToken.statusCode, 403)
    assert.equal(code(byToken), 'FORBIDDEN')
    const short = await on.inject({ method: 'POST', url: '/api/legal/consent', headers: { cookie: blocked.cookie }, payload: { consents: ['terms'], legalVersion: version } })
    assert.equal(short.statusCode, 400)
    assert.equal(code(short), 'CONSENT_REQUIRED')
    const stale = await on.inject({ method: 'POST', url: '/api/legal/consent', headers: { cookie: blocked.cookie }, payload: { ...body, legalVersion: 'abcdefabcdef' } })
    assert.equal(code(stale), 'CONSENT_REQUIRED')
    assert.equal((await consentRows(blocked.id)).length, 0)

    const ok = await on.inject({ method: 'POST', url: '/api/legal/consent', headers: { cookie: blocked.cookie }, payload: body, remoteAddress: '203.0.113.9' })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.deepEqual(ok.json(), { ok: true, version })
    const rows = await consentRows(blocked.id)
    assert.deepEqual(rows.map((r) => [r.itemId, r.version, r.ip]), [
      ['demo_notice', version, '203.0.113.9'],
      ['privacy', version, '203.0.113.9'],
      ['terms', version, '203.0.113.9'],
    ])

    assert.equal((await get('/api/workspaces', { cookie: blocked.cookie })).statusCode, 200)
    assert.equal((await get('/api/workspaces', { authorization: `Bearer ${apiToken}` })).statusCode, 200)
    assert.equal((await get('/api/workspaces', { authorization: `Bearer ${oauthToken}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET })).statusCode, 200)
    assert.equal((await mcpInit(oauthToken)).statusCode, 200)
    assert.deepEqual(await collabAuth(blocked), { userId: blocked.id, sessionToken: blocked.cookie.split('=')[1] })
    const me = (await get('/api/auth/me', { cookie: blocked.cookie })).json() as { user: Record<string, unknown> }
    assert.equal('consentRequired' in me.user, false)
  })

  it('"agreed" is cached per person and version (no database read per request)', async () => {
    const before = await db.select().from(schema.userConsents).where(eq(schema.userConsents.userId, blocked.id))
    await db.delete(schema.userConsents).where(eq(schema.userConsents.userId, blocked.id))
    try {
      assert.equal(await consent.hasConsented(blocked.id), true, 'served from the cache')
      consent.forgetConsent(blocked.id)
      assert.equal(await consent.hasConsented(blocked.id), false, 'read again after the cache entry is gone')
    } finally {
      await db.insert(schema.userConsents).values(before)
    }
    assert.equal(await consent.hasConsented(blocked.id), true)
  })

  it('a changed document (new version) refuses people who agreed to the old one until they agree again', async () => {
    writeFileSync(path.join(legalDir, 'terms.en.md'), '# Terms\n\nBe nice. Second edition.\n')
    const b = legal.reloadLegalForTests()
    assert.ok(b && b.version !== version)
    const next = b.version
    const mode = (await get('/api/auth/mode')).json() as { legal?: { version: string } }
    assert.equal(mode.legal?.version, next)

    const r = await get('/api/workspaces', { cookie: blocked.cookie })
    assert.equal(r.statusCode, 403)
    assert.equal(code(r), 'CONSENT_REQUIRED')
    assert.equal(errorOf(r).version, next)
    assert.equal(((await get('/api/auth/me', { cookie: blocked.cookie })).json() as { user: { consentRequired?: boolean } }).user.consentRequired, true)
    // the old version's rows stay (what was agreed when); the new ones are added
    const again = await on.inject({ method: 'POST', url: '/api/legal/consent', headers: { cookie: blocked.cookie }, payload: { consents: ALL, legalVersion: next } })
    assert.equal(again.statusCode, 200, again.body)
    assert.equal((await get('/api/workspaces', { cookie: blocked.cookie })).statusCode, 200)
    const byVersion = await db
      .select()
      .from(schema.userConsents)
      .where(and(eq(schema.userConsents.userId, blocked.id), eq(schema.userConsents.version, version)))
    assert.equal(byVersion.length, 3)
  })

  it('a bad signup.json stops the boot (registerRestrictedMode throws with the file and reason)', async () => {
    const bad = folder({ 'terms.en.md': '# T\n', 'signup.json': { items: [{ id: 'a', required: true, doc: 'privacy', label: { en: 'A' } }] } })
    const restore = setLimitsForTests({ legalDir: bad })
    try {
      await assert.rejects(buildApp(), (err: unknown) => err instanceof LegalConfigError && /signup\.json: items\[0\]\.doc is "privacy"/.test(err.message))
    } finally {
      restore()
      legal.resetLegalForTests()
    }
  })
})
