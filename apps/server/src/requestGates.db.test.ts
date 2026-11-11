// Request gates (docs/adr/2502-*): a registered gate refuses cookie sessions, personal API tokens,
// MCP tokens on the REST routes their tools call, the /mcp endpoint itself and the collaboration
// socket; the exempt routes pass; without gates nothing changes.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] request gates', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const { requireUser } = await import('./auth')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('./oauth')
  const gates = await import('./requestGates')
  const collab = await import('./collab')

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
      await (await import('./routes/auth')).registerAuthRoutes(api)
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/apiTokens')).registerApiTokenRoutes(api)
      // stand-ins for the routes restricted mode adds, at their exempt paths, plus one that is not exempt
      const ok = async () => ({ ok: true })
      api.get('/legal', { preHandler: requireUser }, ok)
      api.get('/legal/:doc', { preHandler: requireUser }, ok)
      api.post('/legal/consent', { preHandler: requireUser }, ok)
      api.delete('/me', { preHandler: requireUser }, ok)
      api.get('/me/delete-preview', { preHandler: requireUser }, ok)
      api.get('/me/not-exempt', { preHandler: requireUser }, ok)
    },
    { prefix: '/api' },
  )
  await app.register(async (pub) => (await import('./mcp')).registerMcpRoutes(pub, app))
  await app.ready()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const blocked = await h.makeUser('gate-blocked')
  const free = await h.makeUser('gate-free')
  await h.makeWorkspace(blocked)
  await h.makeWorkspace(free)
  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers })

  // credentials made before any gate exists
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: blocked.cookie },
    payload: { name: 'gate', expiresInDays: 30, access: 'read', range: { kind: 'all' } },
  })
  assert.equal(tokenRes.statusCode, 201, tokenRes.body)
  const apiToken = (tokenRes.json() as { secret: string }).secret
  const oauthBlocked = await h.mintToken(blocked)
  const oauthFree = await h.mintToken(free)
  const mcpInit = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gate-test', version: '1' } } },
    })
  const collabAuth = (u: { id: string; cookie: string }) =>
    (collab.hocuspocus.configuration.onAuthenticate as (d: unknown) => Promise<unknown>)({
      requestHeaders: { cookie: u.cookie },
      documentName: `inbox:${u.id}`,
      connection: {},
      context: {},
    })

  it('without gates every credential works as before', async () => {
    assert.equal(gates.hasRequestGates(), false)
    assert.equal((await get('/api/workspaces', { cookie: blocked.cookie })).statusCode, 200)
    assert.equal((await get('/api/workspaces', { authorization: `Bearer ${apiToken}` })).statusCode, 200)
    assert.equal((await get('/api/workspaces', { authorization: `Bearer ${oauthBlocked}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET })).statusCode, 200)
    assert.equal((await mcpInit(oauthBlocked)).statusCode, 200)
    assert.deepEqual(await collabAuth(blocked), { userId: blocked.id, sessionToken: blocked.cookie.split('=')[1] })
    assert.equal((await get('/api/me/not-exempt', { cookie: blocked.cookie })).statusCode, 200)
  })

  it('a gate refuses cookie, API token, MCP-through-REST, /mcp and collab alike; others pass', async () => {
    const seen: string[] = []
    const off = gates.registerRequestGate('test-consent', ({ user, via, channel, req }) => {
      if (user.id !== blocked.id) return
      seen.push(`${channel}/${via}/${req ? 'req' : 'no-req'}`)
      throw new AppError(403, 'CONSENT_REQUIRED', 'Consent to the current terms first')
    })
    try {
      const cookie = await get('/api/workspaces', { cookie: blocked.cookie })
      assert.equal(cookie.statusCode, 403)
      assert.equal(code(cookie), 'CONSENT_REQUIRED')
      const bearer = await get('/api/workspaces', { authorization: `Bearer ${apiToken}` })
      assert.equal(bearer.statusCode, 403)
      assert.equal(code(bearer), 'CONSENT_REQUIRED')
      const viaMcp = await get('/api/workspaces', { authorization: `Bearer ${oauthBlocked}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET })
      assert.equal(viaMcp.statusCode, 403)
      const door = await mcpInit(oauthBlocked)
      assert.equal(door.statusCode, 403)
      assert.equal(code(door), 'CONSENT_REQUIRED')
      await assert.rejects(collabAuth(blocked), /Consent to the current terms first/)
      assert.deepEqual(seen, ['http/cookie/req', 'http/bearer/req', 'http/bearer/req', 'mcp/bearer/req', 'collab/collab/no-req'])

      // somebody the gate lets through is not affected
      assert.equal((await get('/api/workspaces', { cookie: free.cookie })).statusCode, 200)
      assert.equal((await mcpInit(oauthFree)).statusCode, 200)
      assert.deepEqual(await collabAuth(free), { userId: free.id, sessionToken: free.cookie.split('=')[1] })
    } finally {
      off()
    }
    assert.equal((await get('/api/workspaces', { cookie: blocked.cookie })).statusCode, 200)
  })

  it('exempt routes pass for the refused person (cookie and bearer); the rest does not', async () => {
    const off = gates.registerRequestGate('test-consent-2', ({ user }) => {
      if (user.id === blocked.id) throw new AppError(403, 'CONSENT_REQUIRED', 'Consent first')
    })
    try {
      const me = await get('/api/auth/me', { cookie: blocked.cookie })
      assert.equal(me.statusCode, 200, me.body)
      assert.equal((me.json() as { user: { id: string } }).user.id, blocked.id)
      for (const [method, url] of [
        ['GET', '/api/legal'],
        ['GET', '/api/legal/terms'],
        ['POST', '/api/legal/consent'],
        ['DELETE', '/api/me'],
        ['GET', '/api/me/delete-preview'],
      ] as const) {
        const r = await app.inject({ method, url, headers: { cookie: blocked.cookie } })
        assert.equal(r.statusCode, 200, `${method} ${url}: ${r.body}`)
      }
      assert.equal((await get('/api/legal', { authorization: `Bearer ${apiToken}` })).statusCode, 200)
      assert.equal((await get('/api/me/not-exempt', { cookie: blocked.cookie })).statusCode, 403)
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/auth/me/locale', headers: { cookie: blocked.cookie }, payload: { locale: 'ko' } })).statusCode, 403)
      // signing out needs no gate either
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: free.cookie } })).statusCode, 204)
    } finally {
      off()
    }
  })
})
