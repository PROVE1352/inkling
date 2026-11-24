// "Your agent is connected" (docs/adr/2390-*) against a real database and a real /mcp over HTTP: the
// checklist's "AI agent" item and `agentConnected` turn on with the first authenticated /mcp request of the
// person's agent (an agent connection token or an OAuth grant), not when a token is made or the address is
// copied; later requests write nothing (counted statements, unchanged updated_at), also after a restart
// (one conditional check, no row written); a connection used before this release shows as connected on
// the first read, so the app never sees it "appear"; an account that never opened the app gets a new-account
// row; ONBOARDING=off records nothing.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-onboarding-agent-${process.pid}`
delete process.env.ONBOARDING
delete process.env.ONBOARDING_EXISTING_USERS

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] onboarding: the agent connected', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { registerMcpRoutes } = await import('../mcp')
  const agent = await import('./agent')
  const collab = await import('../collab')

  const app = await h.buildTestApp()
  const mcpApp = Fastify()
  await registerMcpRoutes(mcpApp, app)
  await mcpApp.listen({ port: 0, host: '127.0.0.1' })
  const port = (mcpApp.server.address() as { port: number }).port
  after(async () => {
    await mcpApp.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type DTO = import('@inkling/shared').OnboardingDTO
  const req = (u: U, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload ? { payload } : {}) })
  const onboarding = async (u: U): Promise<DTO> => {
    const r = await req(u, 'GET', '/me/onboarding')
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as DTO
  }
  const aiDone = (d: DTO) => d.checklist.items.find((i) => i.id === 'ai')?.done === true
  const row = async (u: U) => (await db.select().from(schema.userOnboarding).where(eq(schema.userOnboarding.userId, u.id)))[0]
  /** One JSON-RPC request at /mcp with the bearer, as an agent sends it. */
  const mcp = async (secret: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(r.status, 200, await r.clone().text())
    await r.text()
  }
  const agentToken = async (u: U) => {
    const r = await req(u, 'POST', '/agent-tokens', { expiresInDays: 90, access: 'write', range: { kind: 'all' }, name: 'Test agent' })
    assert.equal(r.statusCode, 201, r.body)
    return (r.json() as { secret: string }).secret
  }
  const fresh = async (name: string) => {
    const u = await h.makeUser(name)
    await h.makeWorkspace(u)
    return u
  }

  it('an agent connection token: made and copied it is not connected; its first /mcp request is, once', async () => {
    const u = await fresh('token-agent')
    const d0 = await onboarding(u)
    assert.equal(d0.agentConnected, false)
    assert.equal(aiDone(d0), false)

    const secret = await agentToken(u)
    assert.equal((await req(u, 'PATCH', '/me/onboarding', { event: 'ai' })).statusCode, 400, 'the old "address copied" event is refused')
    const d1 = await onboarding(u)
    assert.equal(d1.agentConnected, false, 'a token that exists is not a connection')
    assert.equal(aiDone(d1), false, 'nor is copying')

    const before = agent.agentNoteStatements()
    await mcp(secret)
    const afterFirst = agent.agentNoteStatements()
    assert.equal(afterFirst - before, 1, 'one conditional update')
    const r1 = await row(u)
    const state1 = r1.state as { agentAt?: string; done?: Record<string, string> }
    assert.ok(state1.agentAt, 'recorded')
    assert.equal(state1.done?.ai, state1.agentAt, 'the checklist item with it')
    const d2 = await onboarding(u)
    assert.equal(d2.agentConnected, true)
    assert.equal(aiDone(d2), true)

    // later requests: nothing is run, nothing is written
    const r2 = await row(u)
    await mcp(secret)
    await mcp(secret)
    assert.equal(agent.agentNoteStatements(), afterFirst, 'no statement for a person already recorded')
    const r3 = await row(u)
    assert.equal(r3.updatedAt.getTime(), r2.updatedAt.getTime(), 'the row was not written')
    assert.deepEqual(r3.state, r2.state)

    // a restart forgets the memory: one check, which writes nothing, then nothing again
    agent.forgetAgentNotesForTests()
    await mcp(secret)
    const afterRestart = agent.agentNoteStatements()
    assert.equal(afterRestart - afterFirst, 2, 'the conditional update (no row) and the row check')
    await mcp(secret)
    assert.equal(agent.agentNoteStatements(), afterRestart)
    const r4 = await row(u)
    assert.equal(r4.updatedAt.getTime(), r2.updatedAt.getTime())
    assert.equal((r4.state as { agentAt?: string }).agentAt, state1.agentAt, 'the first time is kept')
  })

  it('an OAuth app: its first /mcp request connects too', async () => {
    const u = await fresh('oauth-agent')
    assert.equal((await onboarding(u)).agentConnected, false)
    const token = await h.mintToken(u)
    assert.equal((await onboarding(u)).agentConnected, false)
    await mcp(token)
    const d = await onboarding(u)
    assert.equal(d.agentConnected, true)
    assert.equal(aiDone(d), true)
  })

  it('a refused request (bad token) records nothing', async () => {
    const u = await fresh('refused')
    await onboarding(u)
    const before = agent.agentNoteStatements()
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(r.status, 401)
    await r.text()
    assert.equal(agent.agentNoteStatements(), before)
    assert.equal((await onboarding(u)).agentConnected, false)
  })

  it('connected before this release (a used grant, nothing recorded): connected from the first read on', async () => {
    const u = await fresh('connected-before')
    await h.mintToken(u)
    await db.execute(sql`UPDATE oauth_grants SET last_used_at = now() - interval '3 days' WHERE user_id = ${u.id}`)
    const d = await onboarding(u)
    assert.equal(d.agentConnected, true, 'the app never sees it change, so it never announces it')
    assert.equal(aiDone(d), true)
    assert.ok(((await row(u)).state as { agentAt?: string }).agentAt, 'recorded, so a revoked grant does not take it back')
    await db.execute(sql`DELETE FROM oauth_grants WHERE user_id = ${u.id}`)
    assert.equal((await onboarding(u)).agentConnected, true)
  })

  it('an account that never opened the app: a new-account row with the connection, the intro still to come', async () => {
    const u = await fresh('agent-first')
    const secret = await agentToken(u)
    assert.equal(await row(u), undefined)
    await mcp(secret)
    const state = (await row(u)).state as Record<string, unknown>
    assert.ok(state.agentAt)
    assert.equal(state.legacy, undefined)
    assert.equal(state.off, undefined)
    const d = await onboarding(u)
    assert.equal(d.intro, true, 'still a new account')
    assert.equal(d.agentConnected, true)
  })

  it('ONBOARDING=off: nothing is recorded, and the answer says not connected', async () => {
    const u = await fresh('agent-off')
    const secret = await agentToken(u)
    process.env.ONBOARDING = 'off'
    try {
      const before = agent.agentNoteStatements()
      await mcp(secret)
      assert.equal(agent.agentNoteStatements(), before)
      assert.equal(await row(u), undefined)
      const d = await onboarding(u)
      assert.equal(d.enabled, false)
      assert.equal(d.agentConnected, false)
    } finally {
      delete process.env.ONBOARDING
    }
  })
})
