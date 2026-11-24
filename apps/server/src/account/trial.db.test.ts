// Trial accounts (TRIAL_ACCOUNTS, docs/adr/2555-*) against a real database of this file's own (the cases
// need "no admin yet" and server-wide counts that other files moving the shared database would disturb):
// off, no admin (never promoted), the account it makes, the bot checks, a session already there, the
// per-address, hourly and seat limits (concurrent requests too), SIGNUP_MAX_USERS untouched, the sign-up
// texts, the reserved domain, every refused route (session, API token, MCP grant), nobody joining a trial
// workspace, expiry without ACCOUNT_LIFETIME_DAYS (other accounts untouched, dry run not applied), what
// deletion leaves (rows and the uploaded file on disk), the instance storage fuse, and two deletions of
// one account at once.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db --test-name-pattern="trial accounts"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
// uploads of this file go to a folder of its own (as accountDeletion.db.test.ts), set before env.ts loads
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-trial-'))
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] trial accounts', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('../restrictedMode/restrictedTestKit')
  const drop = await kit.scratchDatabase('trial')
  const { db } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const { setLimitsForTests, limits } = await import('../limits')
  const legal = await import('../legal/register')
  const trial = await import('./trial')
  const { deleteAccount } = await import('./deletion')
  const { expireAccounts } = await import('./housekeeping')
  const { revealInviteCode } = await import('../helpers')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
  const h = await import('../mcpTools/testHarness')
  const collab = await import('../collab')

  const folders: string[] = []
  let restoreLimits = setLimitsForTests({})
  after(async () => {
    restoreLimits()
    legal.resetLegalForTests()
    for (const d of folders) rmSync(d, { recursive: true, force: true })
    rmSync(process.env.DATA_DIR!, { recursive: true, force: true })
    await collab.destroyCollab().catch(() => undefined)
    await drop()
  })

  /** Every route module that has a refused route, registered as index.ts does. */
  async function buildApp(opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
    const Fastify = (await import('fastify')).default
    const { ZodError } = await import('zod')
    const { AppError } = await import('../errors')
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
    if (opts.rateLimit) {
      // as index.ts: the global limit keyed by rateLimitKey, routes overriding max and key
      const { rateLimitKey } = await import('../rateLimitKey')
      await app.register(import('@fastify/rate-limit'), {
        global: true,
        max: 300,
        timeWindow: '1 minute',
        errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
        keyGenerator: rateLimitKey,
      })
    }
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
        await (await import('../restricted')).registerRestrictedMode(api)
        await (await import('../routes/twoFactor')).registerTwoFactorRoutes(api)
        await (await import('../routes/oidc')).registerOidcRoutes(api)
        await (await import('../routes/admin')).registerAdminRoutes(api)
        await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
        await (await import('../routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
        await (await import('../routes/pages')).registerPageRoutes(api)
        await (await import('../routes/pageAccess')).registerPageAccessRoutes(api)
        await (await import('../routes/collections')).registerCollectionRoutes(api)
        await (await import('../routes/ical')).registerIcalApiRoutes(api)
        await (await import('../routes/notion')).registerNotionRoutes(api)
        await (await import('../routes/suggestions')).registerSuggestionRoutes(api)
        await (await import('../onboarding/routes')).registerOnboardingRoutes(api)
        await (await import('../routes/apiTokens')).registerApiTokenRoutes(api)
        await (await import('../routes/files')).registerFileRoutes(api)
        await (await import('../routes/webhooks')).registerWebhookRoutes(api)
        await (await import('../routes/slack')).registerSlackRoutes(api)
        await (await import('../routes/linkPreview')).registerLinkPreviewRoutes(api)
        await (await import('../routes/clip')).registerClipRoutes(api)
      },
      { prefix: '/api' },
    )
    await app.ready()
    return app
  }

  let app = await buildApp()
  let ipN = 0
  const freshIp = () => `198.51.100.${++ipN}`
  const human = { formMs: 2500, website: '' }
  const tryTrial = (opts: { ip?: string; body?: Record<string, unknown>; cookie?: string; locale?: string } = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/trial',
      remoteAddress: opts.ip ?? freshIp(),
      payload: opts.body ?? human,
      headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.locale ? { 'accept-language': opts.locale } : {}) },
    })
  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const mode = async () => (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
  const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0]
  const n = async (q: ReturnType<typeof sql>) => Number((await one<{ n: number }>(q))?.n ?? 0)
  const register = (email: string, ip = freshIp(), extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { email, name: 'Person', password: 'password123', ...human, ...extra } })
  const on = (extra: Partial<typeof limits> = {}) => {
    restoreLimits()
    restoreLimits = setLimitsForTests({ trial: { lifetimeHours: 24, maxAccounts: 30, perIpPerDay: 3 }, ...extra })
  }
  type Made = { user: { id: string; email: string; name: string; isAdmin: boolean }; workspaceId: string; samplePageId: string | null; cookie: string }
  const makeTrial = async (opts: Parameters<typeof tryTrial>[0] = {}): Promise<Made> => {
    const r = await tryTrial(opts)
    assert.equal(r.statusCode, 200, r.body)
    return { ...(r.json() as Omit<Made, 'cookie'>), cookie: kit.cookieOf(r) }
  }

  it('off: 404 TRIAL_OFF and no `trial` in /auth/mode', async () => {
    assert.equal(limits.trial, undefined)
    const r = await tryTrial()
    assert.equal(r.statusCode, 404)
    assert.equal(code(r), 'TRIAL_OFF')
    assert.ok(!('trial' in (await mode())))
  })

  it('no admin on the server: 403 SETUP_REQUIRED, the button is hidden (reason setup), no account is made, nobody is promoted', async () => {
    on()
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users`), 0)
    assert.deepEqual((await mode()).trial, { available: false, reason: 'setup', hours: 24 })
    const r = await tryTrial()
    assert.equal(r.statusCode, 403)
    assert.equal(code(r), 'SETUP_REQUIRED')
    assert.equal(r.headers['set-cookie'], undefined)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users`), 0)
    // even with the cheap check passed (a racing admin delete), the transaction checks again
    await assert.rejects(trial.createTrialAccount({ rawBody: human, body: { email: trial.trialEmail(), name: 'Trial X', password: '' } as never, ip: '198.51.100.250', locale: 'en', setupCode: false, trial: true, req: { log: { warn() {}, error() {} } } as never }), /SETUP_REQUIRED|no operator/)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE is_admin`), 0)
  })

  let admin: { cookie: string; id: string }
  it('the first ordinary sign-up becomes the admin (as before); then the button is available', async () => {
    restoreLimits()
    const r = await register('admin@example.com')
    assert.equal(r.statusCode, 200, r.body)
    admin = { cookie: kit.cookieOf(r), id: (r.json() as { user: { id: string; isAdmin: boolean } }).user.id }
    assert.equal((r.json() as { user: { isAdmin: boolean } }).user.isAdmin, true)
    on()
    assert.deepEqual((await mode()).trial, { available: true, hours: 24 })
  })

  let first: Made
  it('a click makes a signed-in trial account: reserved address, no admin, 24 h, its workspace with the invite link off, the sample page with the two example suggestions', async () => {
    first = await makeTrial({ locale: 'ko' })
    assert.match(first.user.email, /^trial-[0-9a-f-]{36}@trial\.invalid$/)
    assert.match(first.user.name, /^체험 [0-9A-F]{4}$/)
    assert.equal(first.user.isAdmin, false)
    const row = await one<{ trial: boolean; is_admin: boolean; origin: string; hours: number }>(sql`
      SELECT trial, is_admin, origin, extract(epoch FROM expires_at - now()) / 3600 AS hours FROM users WHERE id = ${first.user.id}`)
    assert.equal(row.trial, true)
    assert.equal(row.is_admin, false)
    assert.equal(row.origin, 'local')
    assert.ok(Math.abs(Number(row.hours) - 24) < 0.1, String(row.hours))
    const ws = await one<{ invite_link_enabled: boolean; role: string }>(sql`
      SELECT w.invite_link_enabled, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = ${first.workspaceId} AND m.user_id = ${first.user.id}`)
    assert.equal(ws.invite_link_enabled, false)
    assert.equal(ws.role, 'owner')
    assert.ok(first.samplePageId)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM section_suggestions WHERE page_id = ${first.samplePageId} AND status = 'open' AND connection = 'example'`), 2)
    // the session works; /auth/me says trial (and not the account-lifetime date)
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie } })).json() as { user: Record<string, unknown> }
    assert.ok((me.user.trial as { expiresAt: string }).expiresAt)
    assert.ok(!('expiresAt' in me.user))
    // an ordinary account's /auth/me has no `trial`
    const am = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin.cookie } })).json() as { user: Record<string, unknown> }
    assert.ok(!('trial' in am.user))
  })

  it('a browser already signed in (a real account or a trial one) gets 409 ALREADY_SIGNED_IN and keeps its session', async () => {
    const before = await n(sql`SELECT count(*)::int AS n FROM users`)
    for (const cookie of [admin.cookie, first.cookie]) {
      const r = await tryTrial({ cookie })
      assert.equal(r.statusCode, 409)
      assert.equal(code(r), 'ALREADY_SIGNED_IN')
      assert.equal(r.headers['set-cookie'], undefined)
    }
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users`), before)
    // a stale cookie (no such session) does not count as signed in
    const r = await tryTrial({ cookie: 'inkling_sid=nope' })
    assert.equal(r.statusCode, 200, r.body)
  })

  it('bot checks always (no sign-up limits set): hidden field filled, too fast, or no formMs is 400 SIGNUP_CHECK_FAILED', async () => {
    assert.equal(limits.signupPerIpPerDay, null)
    for (const body of [{ formMs: 2500, website: 'x' }, { formMs: 1999 }, {}, { formMs: 'x' }]) {
      const r = await tryTrial({ body })
      assert.equal(r.statusCode, 400, JSON.stringify(body))
      if (typeof body.formMs !== 'string') assert.equal(code(r), 'SIGNUP_CHECK_FAILED')
    }
    assert.equal((await tryTrial({ body: { formMs: 2000 } })).statusCode, 200)
  })

  it('TRIAL_PER_IP_PER_DAY: the next one from that address is 429 SIGNUP_IP_LIMIT; another address and ordinary sign-up are not affected', async () => {
    on({ trial: { lifetimeHours: 24, maxAccounts: 30, perIpPerDay: 2 } })
    const ip = freshIp()
    await makeTrial({ ip })
    await makeTrial({ ip })
    const r = await tryTrial({ ip })
    assert.equal(r.statusCode, 429)
    assert.equal(code(r), 'SIGNUP_IP_LIMIT')
    assert.equal((await tryTrial()).statusCode, 200)
    assert.equal((await register(`ip-${ipN}@example.com`, ip)).statusCode, 200)
  })

  it('SIGNUP_PER_HOUR counts trials and sign-ups apart: a full hour of trials leaves sign-up open, and the other way round', async () => {
    const trialHour = await n(sql`SELECT count(*)::int AS n FROM signup_events WHERE created_at > now() - interval '1 hour' AND ip LIKE 'trial:%'`)
    const signupHour = await n(sql`SELECT count(*)::int AS n FROM signup_events WHERE created_at > now() - interval '1 hour' AND ip NOT LIKE 'taken:%' AND ip NOT LIKE 'trial:%'`)
    assert.ok(trialHour >= 3, `${trialHour} trial rows this hour`)
    // the hour's number set to what trials already made: trials are refused, sign-up is not
    on({ signupPerHour: trialHour })
    assert.ok(signupHour < trialHour, `${signupHour} sign-up rows, ${trialHour} trial rows`)
    const r = await tryTrial()
    assert.equal(r.statusCode, 429)
    assert.equal(code(r), 'SIGNUP_RATE_LIMIT')
    const s1 = await register(`hourly-${ipN}@example.com`)
    assert.equal(s1.statusCode, 200, s1.body)
    // sign-ups fill their own hour: sign-up is refused, a trial (with room in its own count) is not
    const signupNow = signupHour + 1
    on({ signupPerHour: signupNow })
    assert.equal(code(await register(`hourly2-${ipN}@example.com`)), 'SIGNUP_RATE_LIMIT')
    if (trialHour < signupNow) assert.equal((await tryTrial()).statusCode, 200)
    on({ signupPerHour: Math.max(signupNow, trialHour) + 1 })
    assert.equal((await tryTrial()).statusCode, 200)
    on()
  })

  it('TRIAL_MAX_ACCOUNTS holds under concurrent clicks; full shows as reason full', async () => {
    const now = await n(sql`SELECT count(*)::int AS n FROM users WHERE trial`)
    on({ trial: { lifetimeHours: 24, maxAccounts: now + 2, perIpPerDay: 3 } })
    const results = await Promise.all(Array.from({ length: 6 }, () => tryTrial()))
    const ok = results.filter((r) => r.statusCode === 200)
    assert.equal(ok.length, 2, results.map((r) => r.statusCode).join(','))
    for (const r of results.filter((x) => x.statusCode !== 200)) assert.equal(code(r), 'TRIAL_FULL')
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE trial`), now + 2)
    assert.deepEqual((await mode()).trial, { available: false, reason: 'full', hours: 24 })
  })

  it('an expired seat is taken back by the next click (quick reclaim), so the cap counts it only until then', async () => {
    const victim = await one<{ id: string }>(sql`SELECT id FROM users WHERE trial AND id <> ${first.user.id} ORDER BY created_at LIMIT 1`)
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = ${victim.id}`)
    assert.equal(((await mode()).trial as { available: boolean }).available, true)
    await makeTrial()
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${victim.id}`), 0)
    on()
  })

  it('trial accounts do not count toward SIGNUP_MAX_USERS, and are not refused by it', async () => {
    const people = await n(sql`SELECT count(*)::int AS n FROM users WHERE NOT trial`)
    on({ signupMaxUsers: people + 1 })
    assert.notEqual((await mode()).signupFull, true)
    await makeTrial()
    await makeTrial()
    assert.notEqual((await mode()).signupFull, true)
    assert.equal((await register('last-seat@example.com')).statusCode, 200)
    assert.equal(code(await register('one-too-many@example.com')), 'SIGNUP_FULL')
    assert.equal((await mode()).signupFull, true)
    await makeTrial()
    on()
  })

  it('ACCOUNT_LIFETIME_DAYS on: ordinary accounts get days, a trial keeps its hours', async () => {
    on({ accountLifetimeDays: 30 })
    const t = await makeTrial()
    const hrs = await one<{ h: number }>(sql`SELECT extract(epoch FROM expires_at - now()) / 3600 AS h FROM users WHERE id = ${t.user.id}`)
    assert.ok(Math.abs(Number(hrs.h) - 24) < 0.1, String(hrs.h))
    on()
  })

  const folder = (files: Record<string, string | object>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkling-trial-legal-'))
    folders.push(dir)
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
    return dir
  }

  it('sign-up texts with tick boxes: 403 TRIAL_NEEDS_CONSENT and the button hidden (reason consent)', async () => {
    const dir = folder({ 'terms.en.md': '# Terms\n', 'signup.json': { items: [{ id: 'terms', required: true, doc: 'terms', label: { en: 'I agree.' } }] } })
    on({ legalDir: dir })
    app = await buildApp()
    try {
      assert.deepEqual((await mode()).trial, { available: false, reason: 'consent', hours: 24 })
      const r = await tryTrial()
      assert.equal(r.statusCode, 403)
      assert.equal(code(r), 'TRIAL_NEEDS_CONSENT')
    } finally {
      on()
      legal.resetLegalForTests()
      app = await buildApp()
    }
  })

  it('documents without tick boxes: the click must send the version shown (as sign-up does); no consent row is written', async () => {
    const dir = folder({ 'terms.en.md': '# Terms\n', 'privacy.en.md': '# Privacy\n', 'signup.json': { items: [] } })
    on({ legalDir: dir })
    app = await buildApp()
    try {
      const m = await mode()
      assert.deepEqual(m.trial, { available: true, hours: 24 })
      const version = (m.legal as { version: string }).version
      for (const body of [human, { ...human, legalVersion: 'old' }]) {
        const r = await tryTrial({ body })
        assert.equal(r.statusCode, 400, r.body)
        assert.equal(code(r), 'CONSENT_REQUIRED')
      }
      const t = await makeTrial({ body: { ...human, legalVersion: version } })
      assert.equal(await n(sql`SELECT count(*)::int AS n FROM user_consents WHERE user_id = ${t.user.id}`), 0)
      // not gated afterwards
      assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: t.cookie } })).statusCode, 200)
    } finally {
      on()
      legal.resetLegalForTests()
      app = await buildApp()
    }
  })

  it('the reserved domain: no sign-up (EMAIL_RESERVED), no password sign-in, no reset, nothing queued for "forgot password"', async () => {
    const r = await register('someone@trial.invalid')
    assert.equal(r.statusCode, 400)
    assert.equal(code(r), 'EMAIL_RESERVED')
    assert.equal(code(await register('Trial-X@TRIAL.INVALID')), 'EMAIL_RESERVED')
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: freshIp(), payload: { email: first.user.email, password: 'anything-at-all' } })
    assert.equal(login.statusCode, 401)
    assert.equal(code(login), 'INVALID_CREDENTIALS')
    const reset = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: freshIp(), payload: { email: first.user.email, code: 'ABCDE-FGHIJ', newPassword: 'password123' } })
    assert.equal(reset.statusCode, 400)
    const forgot = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: freshIp(), payload: { email: first.user.email } })
    assert.equal(forgot.statusCode, 200)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM password_reset_requests WHERE user_id = ${first.user.id}`), 0)
  })

  it('every refused route answers a trial session 403 TRIAL_RESTRICTED and an ordinary session something else', async () => {
    const ZERO = '00000000-0000-4000-8000-000000000000'
    const routes = new Set<string>()
    const stack: string[] = []
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?$/.exec(line)
      if (!m) continue
      stack.length = m[1].length / 4
      stack.push(m[2])
      for (const method of (m[3] ?? '').split(', ').filter(Boolean)) routes.add(`${method} ${stack.join('')}`)
    }
    const fill = (url: string) => url.replace(/\/workspaces\/:id\b/, `/workspaces/${first.workspaceId}`).replace(/\/pages\/:id\b/, `/pages/${first.samplePageId}`).replace(/:[A-Za-z]+/g, ZERO)
    for (const r of trial.TRIAL_RESTRICTED_ROUTES) {
      assert.ok(routes.has(`${r.method} ${r.url}`), `${r.method} ${r.url} is not a route of the app`)
      const asTrial = await app.inject({ method: r.method, url: fill(r.url), headers: { cookie: first.cookie }, payload: {} })
      assert.equal(asTrial.statusCode, 403, `${r.method} ${r.url}: ${asTrial.body}`)
      assert.equal(code(asTrial), 'TRIAL_RESTRICTED', `${r.method} ${r.url}`)
      const asPerson = await app.inject({ method: r.method, url: fill(r.url), headers: { cookie: admin.cookie }, payload: {} })
      assert.notEqual(code(asPerson), 'TRIAL_RESTRICTED', `${r.method} ${r.url}`)
    }
    // the invite link: refused on, allowed off and for other settings
    const settings = `/api/workspaces/${first.workspaceId}/settings`
    const on1 = await app.inject({ method: 'PATCH', url: settings, headers: { cookie: first.cookie }, payload: { inviteLinkEnabled: true } })
    assert.equal(code(on1), 'TRIAL_RESTRICTED')
    const off1 = await app.inject({ method: 'PATCH', url: settings, headers: { cookie: first.cookie }, payload: { inviteLinkEnabled: false } })
    assert.notEqual(code(off1), 'TRIAL_RESTRICTED')
    assert.equal((await one<{ e: boolean }>(sql`SELECT invite_link_enabled AS e FROM workspaces WHERE id = ${first.workspaceId}`)).e, false)
    // what stays open: pages, the sample, export-like reads, tokens
    const page = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: first.cookie }, payload: { workspaceId: first.workspaceId, title: 'Mine' } })
    assert.equal(page.statusCode, 200, page.body)
  })

  let apiToken = ''
  let mcpToken = ''
  it('an API token and an MCP connection of a trial account are refused the same routes (the gate is in authenticate)', async () => {
    const t = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: first.cookie }, payload: { name: 'demo', expiresInDays: 30, access: 'write', range: { kind: 'all' } } })
    assert.equal(t.statusCode, 201, t.body)
    apiToken = (t.json() as { secret: string }).secret
    mcpToken = await h.mintToken(first.user, 'notes')
    const ZERO = '00000000-0000-4000-8000-000000000000'
    const fill = (url: string) => url.replace(/\/workspaces\/:id\b/, `/workspaces/${first.workspaceId}`).replace(/\/pages\/:id\b/, `/pages/${first.samplePageId}`).replace(/:[A-Za-z]+/g, ZERO)
    // An API token, and an MCP tool's REST call (the grant's bearer with the internal header, as
    // mcp.ts call() sends it). Browser-only routes refuse a bearer before the gate (FORBIDDEN); every
    // other listed route reaches the gate. Either way nothing is written.
    const seen = { gate: 0, browserOnly: 0 }
    for (const headers of [{ authorization: `Bearer ${apiToken}` }, { authorization: `Bearer ${mcpToken}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }]) {
      for (const r of trial.TRIAL_RESTRICTED_ROUTES) {
        const res = await app.inject({ method: r.method, url: fill(r.url), headers, payload: {} })
        assert.equal(res.statusCode, 403, `${r.method} ${r.url}: ${res.body}`)
        const c = code(res)
        assert.ok(c === 'TRIAL_RESTRICTED' || c === 'FORBIDDEN', `${r.method} ${r.url}: ${c}`)
        if (c === 'TRIAL_RESTRICTED') seen.gate++
        else seen.browserOnly++
      }
    }
    assert.ok(seen.gate > 0, JSON.stringify(seen))
    // the same credentials still read
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: `Bearer ${apiToken}` } })).statusCode, 200)
  })

  it('a trial account deletes itself from its browser session with the confirmation only, no password; its seat frees at once', async () => {
    const t = await makeTrial()
    const preview = await app.inject({ method: 'GET', url: '/api/me/delete-preview', headers: { cookie: t.cookie } })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.deepEqual((preview.json() as { needs: unknown }).needs, { password: false, code: false, recentSignIn: false })
    // the same rules as before for anything but the browser session and the confirmation
    const tok = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: t.cookie }, payload: { name: 'x', expiresInDays: 30, access: 'write', range: { kind: 'all' } } })
    const bearer = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${(tok.json() as { secret: string }).secret}` }, payload: { confirm: t.user.email } })
    assert.equal(bearer.statusCode, 403)
    const wrong = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: t.cookie }, payload: { confirm: 'nope' } })
    assert.equal(code(wrong), 'CONFIRM_MISMATCH')
    const seats = await n(sql`SELECT count(*)::int AS n FROM users WHERE trial`)
    const r = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: t.cookie }, payload: { confirm: t.user.email } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${t.user.id}`), 0)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE trial`), seats - 1)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${t.workspaceId}`), 0)
    // repeated attempts did not count as sign-in failures for the address (the guard would answer 429)
    const again = await makeTrial()
    for (let i = 0; i < 12; i++) await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: again.cookie }, payload: { confirm: 'still wrong' } })
    const ok = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: again.cookie }, payload: { confirm: again.user.email } })
    assert.equal(ok.statusCode, 200, ok.body)
  })

  it('an expired trial account is signed out at once, before the hourly job: cookie, API token and MCP grant are 401', async () => {
    const t = await makeTrial()
    const tok = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: t.cookie }, payload: { name: 'x', expiresInDays: 30, access: 'write', range: { kind: 'all' } } })
    const pat = (tok.json() as { secret: string }).secret
    const grant = await h.mintToken(t.user, 'notes')
    const asCookie = () => app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: t.cookie } })
    const asPat = () => app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: `Bearer ${pat}` } })
    const asMcp = () => app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: `Bearer ${grant}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET } })
    for (const f of [asCookie, asPat, asMcp]) assert.equal((await f()).statusCode, 200)
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 second' WHERE id = ${t.user.id}`)
    for (const f of [asCookie, asPat, asMcp]) assert.equal((await f()).statusCode, 401)
    const { getSessionUser } = await import('../auth')
    assert.equal(await getSessionUser(t.cookie.split('=')[1]), null, 'the collaboration socket reads the same function')
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${t.user.id}`), 1, 'not deleted yet')
    // an ordinary account with a past expires_at is not touched (ACCOUNT_LIFETIME_DAYS off: it stays usable)
    const plain = await h.makeUser('PastDate')
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 day' WHERE id = ${plain.id}`)
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: plain.cookie } })).statusCode, 200)
    await trial.expireTrialAccounts(() => {})
  })

  it('LIMIT_WORKSPACES_TOTAL does not count trial workspaces: trials neither fill it nor are refused by it', async () => {
    const counted = await n(sql`SELECT count(*)::int AS n FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.created_by AND u.trial)`)
    const trials = await n(sql`SELECT count(*)::int AS n FROM workspaces w JOIN users u ON u.id = w.created_by WHERE u.trial`)
    assert.ok(trials > 0)
    // at the limit for ordinary workspaces: sign-up is full, trials still work
    on({ workspacesTotal: counted })
    assert.equal((await mode()).signupFull, true)
    assert.equal(code(await register(`wst-${ipN}@example.com`)), 'SIGNUP_FULL')
    assert.equal((await tryTrial()).statusCode, 200)
    // one ordinary seat left: however many trials exist, an ordinary sign-up takes it
    on({ workspacesTotal: counted + 1 })
    await makeTrial()
    await makeTrial()
    assert.notEqual((await mode()).signupFull, true)
    assert.equal((await register(`wst2-${ipN}@example.com`)).statusCode, 200)
    on()
  })

  it('a full server answers TRIAL_FULL before hashing a password', async () => {
    const seats = await n(sql`SELECT count(*)::int AS n FROM users WHERE trial`)
    on({ trial: { lifetimeHours: 24, maxAccounts: seats, perIpPerDay: 30 } })
    let hashed = 0
    const spy = async (p: string) => {
      hashed++
      return p
    }
    const ctx = { rawBody: human, body: { email: trial.trialEmail(), name: 'Trial X', password: '' } as never, ip: freshIp(), locale: 'en' as const, setupCode: false, trial: true, req: { log: { warn() {}, error() {} } } as never }
    await assert.rejects(trial.createTrialAccount(ctx, spy), (e: unknown) => (e as { code?: string }).code === 'TRIAL_FULL')
    assert.equal(hashed, 0)
    on()
  })

  it('rate limits: a token with a fresh cookie each time, or a made-up bearer on the trial route, still runs out', async () => {
    const limited = await buildApp({ rateLimit: true })
    try {
      const tok = await limited.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: admin.cookie }, payload: { name: 'rl', expiresInDays: 30, access: 'write', range: { kind: 'all' } } })
      assert.equal(tok.statusCode, 201, tok.body)
      const pat = (tok.json() as { secret: string }).secret
      const { randomBytes } = await import('node:crypto')
      const cookie = () => `inkling_sid=${randomBytes(16).toString('hex')}`
      // link previews (no url: 400 before any fetch) and clips (empty body: 400), 30 a minute each
      for (const [method, url] of [['GET', '/api/link-preview'], ['POST', '/api/clip']] as const) {
        const send = () => limited.inject({ method, url, remoteAddress: '203.0.113.7', headers: { authorization: `Bearer ${pat}`, cookie: cookie() }, ...(method === 'POST' ? { payload: {} } : {}) })
        for (let i = 0; i < 30; i++) assert.notEqual((await send()).statusCode, 429, `${url} #${i + 1}`)
        const over = await send()
        assert.equal(over.statusCode, 429, `${url}: ${over.body}`)
      }
      // the trial route: a random `Bearer ink_pat_…` per request does not make a new bucket
      const { API_TOKEN_PREFIX } = await import('@inkling/shared')
      const sendTrial = () =>
        limited.inject({ method: 'POST', url: '/api/auth/trial', remoteAddress: '203.0.113.8', headers: { authorization: `Bearer ${API_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}` }, payload: {} })
      for (let i = 0; i < 10; i++) assert.notEqual((await sendTrial()).statusCode, 429, `trial #${i + 1}`)
      assert.equal((await sendTrial()).statusCode, 429)
    } finally {
      await limited.close()
    }
  })

  it('a trial account an admin made an admin is never deleted by the trial job', async () => {
    const t = await makeTrial()
    await db.execute(sql`UPDATE users SET is_admin = true, expires_at = now() - interval '1 minute' WHERE id = ${t.user.id}`)
    await trial.expireTrialAccounts(() => {})
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${t.user.id}`), 1)
    await db.execute(sql`UPDATE users SET is_admin = false, expires_at = now() + interval '1 hour' WHERE id = ${t.user.id}`)
  })

  it('nobody joins a trial workspace with its code (the invite link is off)', async () => {
    const ws = await one<{ id: string; invite_code_enc: string | null }>(sql`SELECT id, invite_code_enc FROM workspaces WHERE id = ${first.workspaceId}`)
    const inviteCode = revealInviteCode({ id: ws.id, inviteCodeEnc: ws.invite_code_enc })
    assert.ok(inviteCode)
    const r = await app.inject({ method: 'POST', url: '/api/workspaces/join', headers: { cookie: admin.cookie }, payload: { code: inviteCode } })
    assert.notEqual(r.statusCode, 200, r.body)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = ${first.workspaceId}`), 1)
  })

  it('the instance storage fuse refuses a click (503 INSTANCE_FULL) and shows the seats as full', async () => {
    const I = await import('../quota/instance')
    const before = await n(sql`SELECT count(*)::int AS n FROM users`)
    const restoreFuse = setLimitsForTests({ instanceStorageMb: 1 })
    I._setInstanceStorageForTests({ dbBytes: 2 * 1024 * 1024, fileBytes: 0 })
    try {
      const r = await tryTrial()
      assert.equal(r.statusCode, 503, r.body)
      assert.equal(code(r), 'INSTANCE_FULL')
      assert.equal(((await mode()).trial as { reason?: string }).reason, 'full')
      assert.equal(await n(sql`SELECT count(*)::int AS n FROM users`), before)
    } finally {
      I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 })
      I._setInstanceStorageForTests(null)
      restoreFuse()
    }
    assert.equal((await tryTrial()).statusCode, 200)
  })

  it('deletion leaves nothing: workspace, pages, example suggestions, the upload\'s row and its file on disk', async () => {
    const t = await makeTrial()
    const boundary = '----w23trial'
    const up = await app.inject({
      method: 'POST',
      url: `/api/files?workspaceId=${t.workspaceId}&pageId=${t.samplePageId}`,
      headers: { cookie: t.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello trial\r\n--${boundary}--\r\n`,
    })
    assert.equal(up.statusCode, 200, up.body)
    const fileId = (up.json() as { file?: { id: string }; id?: string }).file?.id ?? (up.json() as { id: string }).id
    const uploads = path.join(process.env.DATA_DIR!, 'uploads')
    const onDisk = () => readdirSync(uploads, { recursive: true }).map(String).filter((f) => f.includes(fileId))
    assert.ok(onDisk().length > 0, 'the upload is on disk')
    const counts = async () => ({
      workspaces: await n(sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${t.workspaceId}`),
      pages: await n(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${t.workspaceId}`),
      suggestions: await n(sql`SELECT count(*)::int AS n FROM section_suggestions WHERE page_id = ${t.samplePageId}`),
      files: await n(sql`SELECT count(*)::int AS n FROM files WHERE workspace_id = ${t.workspaceId}`),
      members: await n(sql`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = ${t.user.id}`),
      onboarding: await n(sql`SELECT count(*)::int AS n FROM user_onboarding WHERE user_id = ${t.user.id}`),
    })
    const was = await counts()
    assert.ok(was.pages > 0 && was.suggestions === 2 && was.files === 1 && was.workspaces === 1, JSON.stringify(was))
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = ${t.user.id}`)
    assert.ok((await trial.expireTrialAccounts(() => {})) >= 1)
    assert.deepEqual(await counts(), { workspaces: 0, pages: 0, suggestions: 0, files: 0, members: 0, onboarding: 0 })
    assert.deepEqual(onDisk(), [], 'the uploaded file is gone from DATA_DIR')
    assert.equal(existsSync(path.join(uploads, fileId)), false)
  })

  it('expiry without ACCOUNT_LIFETIME_DAYS: an expired trial is deleted with its sessions, tokens and grants; an ordinary account with a past expires_at is not', async () => {
    restoreLimits()
    restoreLimits = setLimitsForTests({}) // TRIAL_ACCOUNTS off too: the expiry still runs
    assert.equal(limits.accountLifetimeDays, null)
    const plain = await h.makeUser('Plain')
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 day' WHERE id = ${plain.id}`)
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = ${first.user.id}`)
    for (const t of ['sessions', 'api_tokens', 'oauth_grants']) {
      assert.ok((await n(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)} WHERE user_id = ${first.user.id}`)) > 0, t)
    }
    assert.equal(await expireAccounts(() => {}), 0)
    const deleted = await trial.expireTrialAccounts(() => {})
    assert.ok(deleted >= 1)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${first.user.id}`), 0)
    for (const t of ['sessions', 'api_tokens', 'oauth_grants']) {
      assert.equal(await n(sql`SELECT count(*)::int AS n FROM ${sql.raw(t)} WHERE user_id = ${first.user.id}`), 0, t)
    }
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${first.workspaceId}`), 0)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${plain.id}`), 1)
    // the old cookie and tokens are dead
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: `Bearer ${apiToken}` } })).statusCode, 401)
    // a trial not yet expired stays
    const alive = await n(sql`SELECT count(*)::int AS n FROM users WHERE trial AND expires_at > now()`)
    assert.ok(alive > 0)
    assert.equal(await trial.expireTrialAccounts(() => {}), 0)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE trial AND expires_at > now()`), alive)
  })

  it('ACCOUNT_LIFETIME_DRY_RUN does not apply to trial accounts; the lifetime job leaves them to the trial job', async () => {
    restoreLimits()
    restoreLimits = setLimitsForTests({ accountLifetimeDays: 30, accountLifetimeDryRun: true })
    const t = await one<{ id: string }>(sql`SELECT id FROM users WHERE trial ORDER BY created_at LIMIT 1`)
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = ${t.id}`)
    const lines: string[] = []
    await expireAccounts((m) => lines.push(m))
    assert.ok(!lines.some((l) => l.includes(t.id)), lines.join('\n'))
    assert.ok(await trial.expireTrialAccounts(() => {}) >= 1)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id = ${t.id}`), 0)
    restoreLimits()
    restoreLimits = setLimitsForTests({})
  })

  it('two deletions of one trial account at once (quick reclaim and the hourly job): one deletes, the other finds nothing, neither throws', async () => {
    on()
    const a = await makeTrial()
    const b = await makeTrial()
    await db.execute(sql`UPDATE users SET expires_at = now() - interval '1 minute' WHERE id IN (${a.user.id}, ${b.user.id})`)
    const rs = await Promise.all([trial.deleteTrialAccount(a.user.id, () => {}), trial.deleteTrialAccount(a.user.id, () => {}), trial.expireTrialAccounts(() => {})])
    assert.equal([rs[0], rs[1]].filter((r) => r.deleted).length + (rs[2] as number), 2)
    assert.equal(await n(sql`SELECT count(*)::int AS n FROM users WHERE id IN (${a.user.id}, ${b.user.id})`), 0)
    // what deleteAccount itself does with by:'self' when the row is already gone (the second caller)
    await assert.rejects(deleteAccount(a.user.id, { by: 'self', log: () => {} }), (e: unknown) => (e as { code?: string }).code === 'USER_NOT_FOUND')
    // and by:'expiry' (ACCOUNT_LIFETIME_DAYS servers): "not deleted", no error
    assert.deepEqual(await deleteAccount(a.user.id, { by: 'expiry', log: () => {} }), { deleted: false, deletedWorkspaces: 0, transferredWorkspaces: 0 })
    restoreLimits()
    restoreLimits = setLimitsForTests({})
  })
})
