// DISABLED_FEATURES (docs/adr/2507-*): every route of a feature that is off answers 404
// FEATURE_DISABLED (also those declared before the gate, and outside /api), what already exists stops
// working (public links, iCal feeds, webhooks, Slack, web push, CIMD, embed frame origins, Notion
// import), and with no feature off every one of those routes answers as before.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DISABLED_FEATURE_NAMES, type DisabledFeatureName } from '@inkling/shared'

describe('[db] features turned off', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let F: typeof import('./features')
  let closeDb: () => Promise<void>

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    F = await import('./features')
    ;({ closeDb } = await import('../db/index'))
    const { AppError } = await import('../errors')
    const { ZodError } = await import('zod')
    const Fastify = (await import('fastify')).default
    app = Fastify()
    await app.register(import('@fastify/cookie'))
    await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500
      return reply.code(statusCode).send({ error: { code: statusCode >= 500 ? 'INTERNAL' : 'VALIDATION', message: String(err) } })
    })
    // the modules whose routes the feature table names, in index.ts order around the registration place
    await app.register(
      async (api) => {
        await (await import('../routes/auth')).registerAuthRoutes(api)
        await (await import('../restricted')).registerRestrictedMode(api)
        await (await import('../routes/admin')).registerAdminRoutes(api)
        await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
        await (await import('../routes/pages')).registerPageRoutes(api)
        await (await import('../routes/collections')).registerCollectionRoutes(api)
        await (await import('../routes/ical')).registerIcalApiRoutes(api)
        await (await import('../routes/exportImport')).registerExportImportRoutes(api)
        await (await import('../routes/public')).registerPublicRoutes(api)
        await (await import('../routes/linkPreview')).registerLinkPreviewRoutes(api)
        await (await import('../routes/clip')).registerClipRoutes(api)
        await (await import('../routes/webhooks')).registerWebhookRoutes(api)
        await (await import('../routes/slack')).registerSlackRoutes(api)
        await (await import('../push/routes')).registerPushRoutes(api)
      },
      { prefix: '/api' },
    )
    await (await import('../routes/ical')).registerIcalFeedRoute(app)
    ;(await import('../embedCsp')).registerEmbedCsp(app)
    app.get('/spa', async (_req, reply) => reply.type('text/html').send('<!doctype html>'))
    await app.ready()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const ID = '00000000-0000-4000-8000-000000000000'
  const urlOf = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, (m) => (m === ':token' ? 'tok' : m === ':key' ? 'key' : ID))

  it('every route of the table exists', () => {
    for (const routes of Object.values(F.FEATURE_ROUTES)) {
      for (const r of routes) {
        const [method, url] = r.split(' ')
        assert.ok(app.hasRoute({ method: method as 'GET', url }), `${r} is not a route`)
      }
    }
  })

  for (const name of DISABLED_FEATURE_NAMES) {
    it(`${name}: off → its routes answer 404 FEATURE_DISABLED; on (no setting) → not`, async () => {
      const routes = F.FEATURE_ROUTES[name as DisabledFeatureName]
      const u = await h.makeUser(`ft-${name}`)
      const restore = L.setLimitsForTests({ disabledFeatures: [name as DisabledFeatureName] })
      try {
        for (const r of routes) {
          const [method, pattern] = r.split(' ')
          const res = await app.inject({ method: method as 'GET', url: urlOf(pattern), headers: { cookie: u.cookie }, ...(method === 'GET' ? {} : { payload: {} }) })
          assert.equal(res.statusCode, 404, `${r}: ${res.body}`)
          assert.equal(res.json().error.code, 'FEATURE_DISABLED', r)
        }
      } finally {
        restore()
      }
      for (const r of routes) {
        const [method, pattern] = r.split(' ')
        const res = await app.inject({ method: method as 'GET', url: urlOf(pattern), headers: { cookie: u.cookie }, ...(method === 'GET' ? {} : { payload: {} }) })
        assert.notEqual(res.json().error?.code, 'FEATURE_DISABLED', `${r} with no setting`)
      }
    })
  }

  it('what exists stops working: a public link, an iCal feed, webhooks, Slack, web push, CIMD, embed frames, Notion import', async () => {
    const o = await h.makeUser('ft-exist')
    const ws = await h.makeWorkspace(o)
    const page = (await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: o.cookie }, payload: { workspaceId: ws.id, title: 'pub' } })).json().page
    const share = (await app.inject({ method: 'POST', url: `/api/pages/${page.id}/share`, headers: { cookie: o.cookie }, payload: {} })).json()
    const token = String(share.token ?? '')
    assert.ok(token, JSON.stringify(share))
    const ical = (await app.inject({ method: 'POST', url: '/api/me/ical', headers: { cookie: o.cookie } })).json()
    const feed = String(ical.ical?.url ?? '').split('/ical/')[1]
    assert.ok(feed, JSON.stringify(ical))
    assert.equal((await app.inject({ method: 'GET', url: `/api/public/${token}` })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: `/ical/${feed}` })).statusCode, 200)
    const cspOn = String((await app.inject({ method: 'GET', url: '/spa' })).headers['content-security-policy'])

    const all = [...DISABLED_FEATURE_NAMES] as DisabledFeatureName[]
    const restore = L.setLimitsForTests({ disabledFeatures: all })
    const env = process.env.OAUTH_CIMD
    process.env.OAUTH_CIMD = '1'
    try {
      const pub = await app.inject({ method: 'GET', url: `/api/public/${token}` })
      assert.equal(pub.json().error.code, 'FEATURE_DISABLED')
      const f = await app.inject({ method: 'GET', url: `/ical/${feed}` })
      assert.equal(f.statusCode, 404)
      assert.equal(f.json().error.code, 'FEATURE_DISABLED')
      // unpublishing and removing still work (clean-up is never blocked)
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/pages/${page.id}/share`, headers: { cookie: o.cookie } })).statusCode < 300, true)
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/me/ical', headers: { cookie: o.cookie } })).statusCode < 300, true)
      const { hasEnabledHook } = await import('../webhooks')
      assert.equal(await hasEnabledHook(ws.id, 'page_created'), false)
      const { slackApi } = await import('../slack/api')
      assert.deepEqual(await slackApi('auth.test', 'xoxb-test'), { ok: false, error: 'feature_disabled', retryable: false })
      const { runPushPass } = await import('../push/deliver')
      assert.equal(await runPushPass(), 0)
      const { cimdConfig } = await import('../oauthCimd')
      assert.equal(cimdConfig().enabled, false)
      const csp = String((await app.inject({ method: 'GET', url: '/spa' })).headers['content-security-policy'])
      assert.match(csp, /frame-src 'self';/)
      assert.notEqual(csp, cspOn)
      const boundary = '----w22anotion'
      const imp = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/import?source=notion`,
        headers: { cookie: o.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.zip"\r\nContent-Type: application/zip\r\n\r\nPK\x05\x06${'\0'.repeat(18)}\r\n--${boundary}--\r\n`,
      })
      assert.equal(imp.json().error?.code, 'FEATURE_DISABLED', imp.body)
    } finally {
      restore()
      if (env === undefined) delete process.env.OAUTH_CIMD
      else process.env.OAUTH_CIMD = env
    }
    assert.equal(String((await app.inject({ method: 'GET', url: '/spa' })).headers['content-security-policy']), cspOn)
  })

  it('no feature off: /auth/mode has no disabledFeatures field and the gate is one length check', async () => {
    const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json()
    assert.equal('disabledFeatures' in mode, false)
    assert.equal(L.limits.disabledFeatures.length, 0)
  })
})
