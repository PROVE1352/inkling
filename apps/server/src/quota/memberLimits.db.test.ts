// LIMIT_MEMBERS_PER_WORKSPACE and LIMIT_WORKSPACES_PER_USER (docs/adr/2505-*): joining by invite link,
// direct add, creating a workspace, taking over ownership (transfer, role change), restoring a
// deleted workspace. Just below succeeds, at the limit refused, concurrent requests pass only as many
// as there is room for.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] member and owned-workspace limits', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let closeDb: () => Promise<void>
  let reveal: (ws: { id: string; inviteCodeEnc: string | null }) => string

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    ;({ revealInviteCode: reveal } = await import('../helpers'))
    app = await h.buildTestApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const call = (u: { cookie: string }, method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const members = async (ws: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = ${ws}`)) as unknown as { n: number }[])[0].n)
  const owned = async (u: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = ${u} AND role = 'owner'`)) as unknown as { n: number }[])[0].n)

  it('join by invite link: below the limit joins, at the limit LIMIT_MEMBERS, a member re-joining is not refused', async () => {
    const o = await h.makeUser('ml-owner')
    const a = await h.makeUser('ml-a')
    const b = await h.makeUser('ml-b')
    const ws = await h.makeWorkspace(o)
    const restore = L.setLimitsForTests({ membersPerWorkspace: 2 })
    try {
      const code = reveal(ws)
      assert.equal((await call(a, 'POST', '/api/workspaces/join', { inviteCode: code })).statusCode, 200)
      const r = await call(b, 'POST', '/api/workspaces/join', { inviteCode: code })
      assert.equal(r.statusCode, 403, r.body)
      assert.deepEqual(
        { code: r.json().error.code, limit: r.json().error.limit, used: r.json().error.used },
        { code: 'LIMIT_MEMBERS', limit: 2, used: 2 },
      )
      assert.equal((await call(a, 'POST', '/api/workspaces/join', { inviteCode: code })).statusCode, 200, 'idempotent re-join')
      assert.equal(await members(ws.id), 2)
    } finally {
      restore()
    }
  })

  it('join: concurrent requests, only as many as there is room for', async () => {
    const o = await h.makeUser('ml-race-owner')
    const ws = await h.makeWorkspace(o)
    const people = await Promise.all(Array.from({ length: 6 }, (_, i) => h.makeUser(`ml-race-${i}`)))
    const restore = L.setLimitsForTests({ membersPerWorkspace: 3 })
    try {
      const code = reveal(ws)
      const res = await Promise.all(people.map((p) => call(p, 'POST', '/api/workspaces/join', { inviteCode: code })))
      assert.equal(res.filter((r) => r.statusCode === 200).length, 2)
      assert.equal(await members(ws.id), 3)
    } finally {
      restore()
    }
  })

  it('direct add: at the limit LIMIT_MEMBERS', async () => {
    const o = await h.makeUser('ml-add-owner')
    const a = await h.makeUser('ml-add-a')
    const b = await h.makeUser('ml-add-b')
    const ws = await h.makeWorkspace(o)
    await h.makeWorkspace(o, [a, b]) // a and b share a workspace with o: candidates for direct add
    const restore = L.setLimitsForTests({ membersPerWorkspace: 2 })
    try {
      assert.equal((await call(o, 'POST', `/api/workspaces/${ws.id}/members`, { userId: a.id })).statusCode, 200)
      const r = await call(o, 'POST', `/api/workspaces/${ws.id}/members`, { userId: b.id })
      assert.equal(r.json().error?.code, 'LIMIT_MEMBERS', r.body)
      assert.equal(await members(ws.id), 2)
    } finally {
      restore()
    }
  })

  it('create a workspace: below the limit, at the limit LIMIT_WORKSPACES (deleted ones count), concurrent creates', async () => {
    const u = await h.makeUser('wl-create')
    await h.makeWorkspace(u) // the sign-up workspace
    const restore = L.setLimitsForTests({ workspacesPerUser: 3 })
    try {
      const made = (await call(u, 'POST', '/api/workspaces', { name: 'two' })).json().workspace
      assert.ok(made?.id)
      // delete it: still counted while restorable
      assert.equal((await call(u, 'DELETE', `/api/workspaces/${made.id}`, { name: 'two' })).statusCode < 300, true)
      const res = await Promise.all(Array.from({ length: 4 }, (_, i) => call(u, 'POST', '/api/workspaces', { name: `c${i}` })))
      assert.equal(res.filter((r) => r.statusCode === 200).length, 1)
      const refused = res.find((r) => r.statusCode === 403)!
      assert.equal(refused.json().error.code, 'LIMIT_WORKSPACES')
      assert.match(refused.json().error.message, /permanently delete/)
      assert.equal(await owned(u.id), 3)
    } finally {
      restore()
    }
  })

  it('ownership: a transfer or a promotion past the new owner\'s limit is refused; restoring when over is refused', async () => {
    const o = await h.makeUser('wl-o')
    const x = await h.makeUser('wl-x')
    await h.makeWorkspace(x) // x owns one already
    const ws = await h.makeWorkspace(o, [x])
    const restore = L.setLimitsForTests({ workspacesPerUser: 1 })
    try {
      const t = await call(o, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: x.id })
      assert.equal(t.json().error?.code, 'LIMIT_WORKSPACES', t.body)
      const p = await call(o, 'PATCH', `/api/workspaces/${ws.id}/members/${x.id}`, { role: 'owner' })
      assert.equal(p.json().error?.code, 'LIMIT_WORKSPACES', p.body)
      assert.equal(await owned(x.id), 1)
      // a demotion or another role change is not a takeover
      assert.equal((await call(o, 'PATCH', `/api/workspaces/${ws.id}/members/${x.id}`, { role: 'admin' })).statusCode, 200)
    } finally {
      restore()
    }
    // restore: counted already, refused only when the owner is over the limit
    const u = await h.makeUser('wl-restore')
    const w1 = await h.makeWorkspace(u, [], 'keep')
    const w2 = (await call(u, 'POST', '/api/workspaces', { name: 'gone' })).json().workspace
    await call(u, 'DELETE', `/api/workspaces/${w2.id}`, { name: 'gone' })
    void w1
    const r2 = L.setLimitsForTests({ workspacesPerUser: 2 })
    try {
      assert.equal((await call(u, 'POST', `/api/workspaces/${w2.id}/restore`)).statusCode, 200)
      await call(u, 'DELETE', `/api/workspaces/${w2.id}`, { name: 'gone' })
    } finally {
      r2()
    }
    const r1 = L.setLimitsForTests({ workspacesPerUser: 1 })
    try {
      const r = await call(u, 'POST', `/api/workspaces/${w2.id}/restore`)
      assert.equal(r.json().error?.code, 'LIMIT_WORKSPACES', r.body)
    } finally {
      r1()
    }
  })

  it('no limits: the same answers as before', async () => {
    const u = await h.makeUser('wl-none')
    for (let i = 0; i < 3; i++) assert.equal((await call(u, 'POST', '/api/workspaces', { name: `n${i}` })).statusCode, 200)
  })
})
