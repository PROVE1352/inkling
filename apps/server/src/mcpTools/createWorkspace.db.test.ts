// create_workspace (docs/adr/2596-*): the web app's route as the connection's person; refused for
// connections narrowed to some workspaces, read-only ones, trial and guest-only accounts; capped per
// account and day; the person is told; the creating connection works in the workspace at once.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/createWorkspace.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-createws-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] create_workspace', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { createApiToken } = await import('../apiTokens')
  const { createAgentToken } = await import('../agentTokens')
  const { getBearerUser } = await import('../oauth')
  const { registerRequestGate } = await import('../requestGates')
  const trial = await import('../account/trial')
  const { AGENT_WORKSPACES_PER_DAY } = await import('../routes/workspaces')
  const { RANGED_CREATE_MESSAGE, GUEST_CREATE_MESSAGE } = await import('./workspaceTools')
  const app = await h.buildTestApp()
  let unregister: (() => void) | null = null
  try {
    unregister = registerRequestGate('trial-accounts', trial.trialGate)
  } catch {
    // already registered by another suite in this process
  }
  after(async () => {
    unregister?.()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const word = `cw${randomBytes(4).toString('hex')}`
  let person: Awaited<ReturnType<typeof h.makeUser>>
  let home: { id: string }

  before(async () => {
    person = await h.makeUser('Person')
    home = await h.makeWorkspace(person, [], `Home ${word}`)
  })

  const created = (text: string) => JSON.parse(text) as { id: string; name: string; role: string; url: string }

  it('a connection whose range is "all" creates one: the person owns it, is told, and the connection works there at once', async () => {
    const token = await h.mintToken(person, 'notes', 'Claude')
    const user = (await getBearerUser(token))!
    const mcp = await h.connectMcp(app, user, token)
    const r = await mcp.tool('create_workspace', { name: `Contest ${word}` })
    assert.equal(r.isError, false, r.text)
    const ws = created(r.text)
    assert.equal(ws.role, 'owner')
    assert.equal(ws.name, `Contest ${word}`)
    const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
    assert.equal(row.createdBy, person.id)
    assert.equal(row.createdVia, 'Claude')
    const [m] = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, person.id)))
    assert.equal(m.role, 'owner')
    assert.equal(m.agentsPending, false, 'not waiting: the person\'s own connection made it (docs/adr/2580-*)')
    const notes = await db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, person.id), eq(schema.notifications.workspaceId, ws.id)))
    assert.equal(notes.length, 1)
    assert.equal(notes[0].type, 'agent_workspace')
    assert.equal(notes[0].viaClient, 'Claude')
    const listed = await asCookieGet(`/api/notifications`)
    assert.ok(listed.includes('agent_workspace'), listed)
    // the same connection works in it right away
    const page = await mcp.tool('create_page', { workspaceId: ws.id, title: 'First page', markdown: 'hello' })
    assert.equal(page.isError, false, page.text)
    const found = await mcp.tool('list_workspaces')
    assert.ok(found.text.includes(ws.id), found.text)
    // an agent token whose range is "all" too
    const agent = (await createAgentToken(person, { name: `all ${word}`, expiresInDays: 30, access: 'write', range: { kind: 'all' } })).secret
    const agentMcp = await h.connectMcp(app, (await getBearerUser(agent))!, agent)
    const r2 = await agentMcp.tool('create_workspace', { name: `Second ${word}` })
    assert.equal(r2.isError, false, r2.text)
  })

  async function asCookieGet(url: string): Promise<string> {
    const r = await app.inject({ method: 'GET', url, headers: { cookie: person.cookie } })
    return r.body
  }

  it('a connection narrowed to some workspaces or a page tree is refused, with the reason and what the person can do', async () => {
    const before = (await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, person.id))).length
    for (const range of [{ kind: 'workspaces' as const, workspaceIds: [home.id] }]) {
      const secret = (await createAgentToken(person, { name: `narrow ${word}`, expiresInDays: 30, access: 'write', range })).secret
      const mcp = await h.connectMcp(app, (await getBearerUser(secret))!, secret)
      const r = await mcp.tool('create_workspace', { name: 'Escape' })
      assert.equal(r.isError, true)
      assert.ok(r.text.includes(RANGED_CREATE_MESSAGE), r.text)
      assert.match(r.text, /create the workspace in the web app and include it in this connection/)
    }
    const p = await h.makeDocPage(home.id, person.id, 'Root', [])
    const sub = (await createAgentToken(person, { name: `sub ${word}`, expiresInDays: 30, access: 'write', range: { kind: 'subtree', pageId: p.id } })).secret
    const subMcp = await h.connectMcp(app, (await getBearerUser(sub))!, sub)
    assert.equal((await subMcp.tool('create_workspace', { name: 'Escape' })).isError, true)
    // the route refuses it too, should a tool ever skip the check (tokenPolicy RANGED_DENY)
    const api = (await createApiToken(person.id, { name: 'narrow', expiresInDays: null, access: 'write', range: { kind: 'workspaces', workspaceIds: [home.id] } })).secret
    const direct = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { authorization: `Bearer ${api}` }, payload: { name: 'Escape' } })
    assert.equal(direct.statusCode, 403, direct.body)
    const afterCount = (await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, person.id))).length
    assert.equal(afterCount, before)
  })

  it('a read-only connection is refused', async () => {
    const token = await h.mintToken(person, 'notes:read')
    const mcp = await h.connectMcp(app, (await getBearerUser(token))!, token, { canWrite: false })
    const r = await mcp.tool('create_workspace', { name: 'Nope' })
    assert.equal(r.isError, true)
    assert.match(r.text, /read-only/)
  })

  it(`at most ${AGENT_WORKSPACES_PER_DAY} a day per account through agents; the person in the browser and their own API tokens are not counted`, async () => {
    const p2 = await h.makeUser('Busy')
    await h.makeWorkspace(p2, [])
    const token = await h.mintToken(p2, 'notes', 'Looping agent')
    const mcp = await h.connectMcp(app, (await getBearerUser(token))!, token)
    for (let i = 0; i < AGENT_WORKSPACES_PER_DAY; i++) {
      const r = await mcp.tool('create_workspace', { name: `Loop ${i}` })
      assert.equal(r.isError, false, r.text)
    }
    // another connection of the same account shares the allowance
    const other = await h.mintToken(p2, 'notes', 'Other agent')
    const otherMcp = await h.connectMcp(app, (await getBearerUser(other))!, other)
    const over = await otherMcp.tool('create_workspace', { name: 'One too many' })
    assert.equal(over.isError, true)
    assert.match(over.text, /at most 5 workspaces a day/)
    // deleting one does not give the allowance back
    const mine = await db.select().from(schema.workspaces).where(and(eq(schema.workspaces.createdBy, p2.id), eq(schema.workspaces.createdVia, 'Looping agent')))
    assert.equal(mine.length, AGENT_WORKSPACES_PER_DAY)
    await app.inject({ method: 'DELETE', url: `/api/workspaces/${mine[0].id}`, headers: { cookie: p2.cookie }, payload: { confirmName: mine[0].name } })
    assert.equal((await mcp.tool('create_workspace', { name: 'Again' })).isError, true)
    // the person and their API token still can
    const inApp = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: p2.cookie }, payload: { name: 'By hand' } })
    assert.equal(inApp.statusCode, 200, inApp.body)
    const api = (await createApiToken(p2.id, { name: 'script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
    const viaApi = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { authorization: `Bearer ${api}` }, payload: { name: 'By script' } })
    assert.equal(viaApi.statusCode, 200, viaApi.body)
    const [scripted] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, (viaApi.json() as { workspace: { id: string } }).workspace.id))
    assert.equal(scripted.createdVia, null)
  })

  it('a trial account and a guest-only account are refused', async () => {
    const t = await h.makeUser('Trial')
    await h.makeWorkspace(t, [])
    await db.update(schema.users).set({ trial: true }).where(eq(schema.users.id, t.id))
    trial._resetTrialRowsCache()
    const tt = await h.mintToken(t)
    const tm = await h.connectMcp(app, (await getBearerUser(tt))!, tt)
    const r = await tm.tool('create_workspace', { name: 'Second' })
    assert.equal(r.isError, true, r.text)
    assert.match(r.text, /trial/i)
    // only a guest of a page elsewhere
    const g = await h.makeUser('Guest only')
    const page = await h.makeDocPage(home.id, person.id, 'Shared', [])
    await db.insert(schema.pageGrants).values({ pageId: page.id, userId: g.id, level: 'edit', createdBy: person.id })
    const gt = await h.mintToken(g)
    const gm = await h.connectMcp(app, (await getBearerUser(gt))!, gt)
    const gr = await gm.tool('create_workspace', { name: 'Mine' })
    assert.equal(gr.isError, true)
    assert.ok(gr.text.includes(GUEST_CREATE_MESSAGE), gr.text)
  })

  it('is listed in the full profile only; core reaches it through more_tools like the other hidden tools', async () => {
    const token = await h.mintToken(person)
    const full = await h.connectMcp(app, person, token)
    assert.ok((await full.client.listTools()).tools.some((t) => t.name === 'create_workspace'))
    const core = await h.connectMcp(app, person, token, { profile: 'core' })
    assert.ok(!(await core.client.listTools()).tools.some((t) => t.name === 'create_workspace'))
    const tool = (await full.client.listTools()).tools.find((t) => t.name === 'create_workspace')!
    assert.equal(tool.annotations?.destructiveHint, false)
    assert.notEqual(tool.annotations?.idempotentHint, true)
  })
})
