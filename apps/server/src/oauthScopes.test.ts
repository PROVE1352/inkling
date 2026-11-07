// Read/write OAuth scopes (docs/adr/0935-*) and "via agent" provenance (docs/adr/0936-*).
// Run: cd apps/server && DATABASE_URL=postgres://… npx tsx --test src/oauthScopes.test.ts
// Tests marked [db] are skipped when DATABASE_URL is unset (they need a migrated scratch DB).
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('scope decisions', async () => {
  const { canWriteFromScopes, grantedScope, requestedAccess, sanitizeClientName } = await import('./oauth')

  it('canWriteFromScopes: legacy and write grants write, read-only does not', () => {
    assert.equal(canWriteFromScopes(undefined), true) // cookie session
    assert.equal(canWriteFromScopes(null), true) // legacy grant without a scope
    assert.equal(canWriteFromScopes(''), true)
    assert.equal(canWriteFromScopes('notes'), true) // legacy single scope
    assert.equal(canWriteFromScopes('read write'), true)
    assert.equal(canWriteFromScopes('write'), true)
    assert.equal(canWriteFromScopes('read'), false)
    assert.equal(canWriteFromScopes('  read  '), false)
    assert.equal(canWriteFromScopes('openid'), false) // unknown only: fail closed
  })

  it('requestedAccess / grantedScope never widen a read-only request', () => {
    assert.equal(requestedAccess(undefined), 'write')
    assert.equal(requestedAccess('notes'), 'write')
    assert.equal(requestedAccess('read write'), 'write')
    assert.equal(requestedAccess('openid profile'), 'write')
    assert.equal(requestedAccess('read'), 'read')
    assert.equal(grantedScope(undefined, undefined), 'read write')
    assert.equal(grantedScope(undefined, 'read'), 'read')
    assert.equal(grantedScope('notes', 'write'), 'read write')
    assert.equal(grantedScope('read', 'write'), 'read')
    assert.equal(grantedScope('read', undefined), 'read')
  })

  it('sanitizeClientName strips controls/bidi, collapses whitespace, caps length', () => {
    assert.equal(sanitizeClientName('  Claude\n\tCode  '), 'Claude Code')
    assert.equal(sanitizeClientName('Evil‮edoC\u0000'), 'Evil edoC')
    assert.equal(sanitizeClientName('a​b'), 'a b')
    assert.equal(sanitizeClientName('\u0001\u0002 '), null)
    assert.equal(sanitizeClientName(null), null)
    const long = sanitizeClientName('😀'.repeat(100))!
    assert.equal(Array.from(long).length, 60)
    assert.ok(long.endsWith('…'))
    assert.ok(!/[\ud800-\udbff]…$/.test(long)) // no split surrogate pair
    assert.equal(sanitizeClientName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>') // escaped on render
  })
})

// ---------------------------------------------------------------------------
// [db]
// ---------------------------------------------------------------------------

describe('[db] read-only tokens and agent provenance', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const Fastify = (await import('fastify')).default
  const { closeDb, db } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const { destroyCollab } = await import('./collab')
  const { canWriteFromScopes, getBearerUser, MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET, sha256 } = await import('./oauth')
  const { READ_ONLY_MESSAGE } = await import('./mcpTools/core')
  const { READ_ONLY_INSTRUCTION } = await import('./mcp')
  const h = await import('./mcpTools/testHarness')

  const app = await h.buildTestApp()

  // The public OAuth endpoints (/oauth/token, metadata) are not in the harness app.
  const oauthApp = Fastify()
  await oauthApp.register(import('@fastify/cookie'))
  await oauthApp.register(async (root) => {
    await (await import('./routes/oauth')).registerOAuthRoutes(root)
  })
  await oauthApp.register(async (api) => {
    await (await import('./routes/oauth')).registerOAuthApiRoutes(api)
  }, { prefix: '/api' })
  await oauthApp.ready()

  after(async () => {
    await app.close()
    await oauthApp.close()
    await destroyCollab()
    await closeDb()
  })

  const para = (text: string) => ({
    id: randomUUID(),
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: [],
  })

  async function setup(scope: string | null, clientName = 'Claude Desktop') {
    const user = await h.makeUser('alice')
    const ws = await h.makeWorkspace(user)
    const page = await h.makeDocPage(ws.id, user.id, 'Notes', [para('hello') as never])
    const token = await h.mintToken(user, scope, clientName)
    const bearerUser = await getBearerUser(token)
    assert.ok(bearerUser)
    return { user, ws, page, token, bearerUser }
  }

  /** The /mcp handler's real decision: canWrite comes from the token's scope. */
  async function mcpFor(s: Awaited<ReturnType<typeof setup>>) {
    return h.connectMcp(app, s.bearerUser, s.token, { canWrite: canWriteFromScopes(s.bearerUser.scope) })
  }

  it('legacy notes/null grants keep write access (MCP + REST)', async () => {
    for (const scope of ['notes', null]) {
      const s = await setup(scope)
      assert.equal(canWriteFromScopes(s.bearerUser.scope), true)
      const m = await mcpFor(s)
      try {
        assert.equal(m.client.getInstructions()?.includes(READ_ONLY_INSTRUCTION), false)
        const r = await m.tool('add_comment', { pageId: s.page.id, body: `legacy ${scope}` })
        assert.equal(r.isError, false, r.text)
      } finally {
        await m.close()
      }
    }
  })

  it('read-only token: write tools refuse, read tools work, instructions say so', async () => {
    const s = await setup('read')
    assert.equal(canWriteFromScopes(s.bearerUser.scope), false)
    const m = await mcpFor(s)
    try {
      assert.ok(m.client.getInstructions()?.endsWith(READ_ONLY_INSTRUCTION))
      const read = await m.tool('read_page', { pageId: s.page.id })
      assert.equal(read.isError, false, read.text)
      assert.match(read.text, /hello/)
      const w = await m.tool('update_page', { pageId: s.page.id, markdown: 'x', mode: 'append' })
      assert.equal(w.isError, true)
      assert.ok(w.text.includes(READ_ONLY_MESSAGE))
      const c = await m.tool('add_comment', { pageId: s.page.id, body: 'nope' })
      assert.equal(c.isError, true)
      // Write tools stay listed (docs/adr/0935-*: friendly error instead of a stale/hidden list)
      const names = (await m.client.listTools()).tools.map((t) => t.name)
      assert.ok(names.includes('update_page'))
    } finally {
      await m.close()
    }
    const rows = await db.select().from(schema.comments).where(eq(schema.comments.pageId, s.page.id))
    assert.equal(rows.length, 0)
  })

  it('REST: read-only bearer + internal header → 403 on POST, GET still 200', async () => {
    const s = await setup('read')
    const headers = { authorization: `Bearer ${s.token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }
    const post = await app.inject({
      method: 'POST',
      url: `/api/pages/${s.page.id}/comments`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ blockId: 'b', body: 'x' }),
    })
    assert.equal(post.statusCode, 403)
    assert.match(post.json().error.message, /read-only/)
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/pages/${s.page.id}`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'hijack' }),
    })
    assert.equal(patch.statusCode, 403)
    const get = await app.inject({ method: 'GET', url: `/api/pages/${s.page.id}/comments`, headers })
    assert.equal(get.statusCode, 200)
    // a non-GET route that opts in with bearerReadOnlyOk (e.g. POST /workspaces/:id/query) stays open
    const { requireUser } = await import('./auth')
    const mini = Fastify()
    mini.post('/q', { preHandler: requireUser, config: { bearerReadOnlyOk: true } }, async () => ({ ok: true }))
    mini.post('/w', { preHandler: requireUser }, async () => ({ ok: true }))
    try {
      assert.equal((await mini.inject({ method: 'POST', url: '/q', headers })).statusCode, 200)
      assert.equal((await mini.inject({ method: 'POST', url: '/w', headers })).statusCode, 403)
    } finally {
      await mini.close()
    }
    // a write-scoped token on the same route is not affected
    const w = await setup('read write')
    const ok = await app.inject({
      method: 'GET',
      url: `/api/pages/${w.page.id}/comments`,
      headers: { authorization: `Bearer ${w.token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET },
    })
    assert.equal(ok.statusCode, 200)
  })

  async function consentAndExchange(user: { id: string; cookie: string }, scope: string | undefined, access: 'read' | 'write' | undefined) {
    const clientId = `test-${randomUUID().slice(0, 12)}`
    const redirectUri = 'https://client.example.com/cb'
    await db.insert(schema.oauthClients).values({ id: clientId, name: 'Consent Client', redirectUris: [redirectUri] })
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const info = await oauthApp.inject({
      method: 'GET',
      url: '/api/oauth/authorize/info',
      query: { client_id: clientId, redirect_uri: redirectUri, ...(scope ? { scope } : {}) },
      headers: { cookie: user.cookie },
    })
    assert.equal(info.statusCode, 200, info.body)
    const consent = await oauthApp.inject({
      method: 'POST',
      url: '/api/oauth/authorize',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's1',
        ...(scope ? { scope } : {}),
        ...(access ? { access } : {}),
        decision: 'allow',
      }),
    })
    assert.equal(consent.statusCode, 200, consent.body)
    const code = new URL(consent.json().redirectTo).searchParams.get('code')
    assert.ok(code)
    const tok = await oauthApp.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    })
    assert.equal(tok.statusCode, 200, tok.body)
    return { info: info.json(), tok: tok.json(), clientId }
  }

  it('consent choice → code → grant → refresh keeps the scope', async () => {
    const user = await h.makeUser('bob')
    // read-only choice on a default (no scope) request
    const ro = await consentAndExchange(user, undefined, 'read')
    assert.equal(ro.info.requestedAccess, 'write')
    assert.equal(ro.tok.scope, 'read')
    const grant = (await db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, sha256(ro.tok.access_token))))[0]
    assert.equal(grant.scope, 'read')
    const bu = await getBearerUser(ro.tok.access_token)
    assert.equal(canWriteFromScopes(bu?.scope), false)
    assert.equal(bu?.via, 'Consent Client')
    const ref = await oauthApp.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ro.tok.refresh_token, client_id: ro.clientId }).toString(),
    })
    assert.equal(ref.statusCode, 200, ref.body)
    assert.equal(ref.json().scope, 'read')
    assert.equal(canWriteFromScopes((await getBearerUser(ref.json().access_token))?.scope), false)

    // no choice sent (older SPA) + no scope → full access
    const full = await consentAndExchange(user, undefined, undefined)
    assert.equal(full.tok.scope, 'read write')
    // client asked only for read → cannot be widened by the consent body
    const asked = await consentAndExchange(user, 'read', 'write')
    assert.equal(asked.info.requestedAccess, 'read')
    assert.equal(asked.tok.scope, 'read')
    // legacy 'notes' request → full
    assert.equal((await consentAndExchange(user, 'notes', undefined)).tok.scope, 'read write')

    // connected-apps list reports access
    const list = await oauthApp.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie: user.cookie } })
    const accesses = (list.json().grants as { access: string }[]).map((g) => g.access).sort()
    assert.deepEqual(accesses, ['read', 'read', 'write', 'write'])
  })

  it('metadata advertises read and write', async () => {
    const res = await oauthApp.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
      headers: { host: 'notes.example.com' },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().scopes_supported, ['read', 'write'])
  })

  it('MCP update_page / add_comment leave via_client on snapshots and comments', async () => {
    const s = await setup('read write', 'Claude‮ Desktop\n')
    assert.equal(s.bearerUser.via, 'Claude Desktop')
    const m = await mcpFor(s)
    try {
      const rep = await m.tool('update_page', { pageId: s.page.id, markdown: 'replaced', mode: 'replace' })
      assert.equal(rep.isError, false, rep.text)
      const app1 = await m.tool('update_page', { pageId: s.page.id, markdown: 'appended', mode: 'append' })
      assert.equal(app1.isError, false, app1.text)
      const c = await m.tool('add_comment', { pageId: s.page.id, body: 'from the agent' })
      assert.equal(c.isError, false, c.text)
    } finally {
      await m.close()
    }

    const snaps = await app.inject({ method: 'GET', url: `/api/pages/${s.page.id}/snapshots`, headers: { cookie: s.user.cookie } })
    assert.equal(snaps.statusCode, 200)
    const list = snaps.json().snapshots as { label: string; viaClient: string | null; author: { name: string } | null }[]
    const before = list.find((x) => x.label === 'Before AI edit')
    assert.ok(before, JSON.stringify(list))
    assert.equal(before.viaClient, 'Claude Desktop')
    assert.equal(before.author?.name, 'alice')
    // the "AI edit" marker is throttled: a replace snapshot by an agent was just taken, so the
    // append right after it adds no second agent snapshot
    assert.equal(list.filter((x) => x.viaClient).length, 1)

    const comments = await app.inject({ method: 'GET', url: `/api/pages/${s.page.id}/comments`, headers: { cookie: s.user.cookie } })
    const cs = comments.json().comments as { body: string; viaClient: string | null }[]
    assert.equal(cs.find((x) => x.body === 'from the agent')?.viaClient, 'Claude Desktop')

    // a browser (cookie) comment stays unattributed
    const blockId = (await db.select().from(schema.comments).where(eq(schema.comments.pageId, s.page.id)))[0].blockId
    const human = await app.inject({
      method: 'POST',
      url: `/api/pages/${s.page.id}/comments`,
      headers: { cookie: s.user.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ blockId, body: 'human' }),
    })
    assert.equal(human.statusCode, 200, human.body)
    assert.equal(human.json().comment.viaClient, null)
  })

  it('MCP append alone records a throttled "AI edit" snapshot', async () => {
    const s = await setup('read write', 'Cursor')
    const m = await mcpFor(s)
    try {
      for (const md of ['one', 'two']) {
        const r = await m.tool('update_page', { pageId: s.page.id, markdown: md, mode: 'append' })
        assert.equal(r.isError, false, r.text)
      }
    } finally {
      await m.close()
    }
    const rows = await db.select().from(schema.pageSnapshots).where(eq(schema.pageSnapshots.pageId, s.page.id))
    const agent = rows.filter((r) => r.viaClient)
    assert.equal(agent.length, 1) // second append is inside the throttle window
    assert.equal(agent[0].label, 'AI edit')
    assert.equal(agent[0].viaClient, 'Cursor')
  })
})
