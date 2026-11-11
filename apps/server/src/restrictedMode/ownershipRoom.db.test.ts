// LIMIT_WORKSPACES_PER_USER at transfer and restore (0.22 integration, contract §13, docs/adr/2528-*):
// the check runs inside transferOwnership's and restoreWorkspace's own transaction (one connection),
// so concurrent takeovers by the same person pass only as many as there is room for. The automatic
// handover when an account is deleted does not look at the limit.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] owned-workspace limit inside transfer and restore', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let closeDb: () => Promise<void>

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    app = await h.buildTestApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const call = (u: { cookie: string }, method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const owned = async (u: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = ${u} AND role = 'owner'`)) as unknown as { n: number }[])[0].n)
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

  it('eight owners transfer to the same person with one place left: exactly one passes', async () => {
    const target = await h.makeUser('own-target')
    await h.makeWorkspace(target) // owns one
    const owners = await Promise.all(Array.from({ length: 8 }, (_, i) => h.makeUser(`own-o${i}`)))
    const spaces = await Promise.all(owners.map((o) => h.makeWorkspace(o, [target])))
    const restore = L.setLimitsForTests({ workspacesPerUser: 2 })
    try {
      const res = await Promise.all(owners.map((o, i) => call(o, 'POST', `/api/workspaces/${spaces[i].id}/transfer`, { userId: target.id })))
      const ok = res.filter((r) => r.statusCode === 200)
      assert.equal(ok.length, 1, res.map((r) => r.statusCode).join(','))
      for (const r of res) if (r.statusCode !== 200) assert.equal(codeOf(r), 'LIMIT_WORKSPACES', r.body)
      assert.equal(await owned(target.id), 2)
    } finally {
      restore()
    }
  })

  it('a transfer and a promotion to owner of the same person at once: one passes', async () => {
    const target = await h.makeUser('own-race')
    await h.makeWorkspace(target)
    const a = await h.makeUser('own-ra')
    const b = await h.makeUser('own-rb')
    const wa = await h.makeWorkspace(a, [target])
    const wb = await h.makeWorkspace(b, [target])
    const restore = L.setLimitsForTests({ workspacesPerUser: 2 })
    try {
      const [t, p] = await Promise.all([
        call(a, 'POST', `/api/workspaces/${wa.id}/transfer`, { userId: target.id }),
        call(b, 'PATCH', `/api/workspaces/${wb.id}/members/${target.id}`, { role: 'owner' }),
      ])
      assert.deepEqual([t.statusCode, p.statusCode].sort(), [200, 403], `${t.body} ${p.body}`)
      assert.equal(await owned(target.id), 2)
    } finally {
      restore()
    }
  })

  it('a transfer to someone who already owns the workspace is not a takeover; without the limit all pass as before', async () => {
    const o = await h.makeUser('own-none')
    const xs = await Promise.all([1, 2, 3].map((i) => h.makeUser(`own-x${i}`)))
    const target = await h.makeUser('own-many')
    const spaces = await Promise.all(xs.map((x) => h.makeWorkspace(x, [target])))
    const res = await Promise.all(xs.map((x, i) => call(x, 'POST', `/api/workspaces/${spaces[i].id}/transfer`, { userId: target.id })))
    assert.deepEqual(res.map((r) => r.statusCode), [200, 200, 200])
    assert.equal(await owned(target.id), 3)
    void o
  })

  it('restore: refused inside its transaction when the owner is over; concurrent restores of two deleted workspaces both decide under the lock', async () => {
    const u = await h.makeUser('own-restore')
    const ids: string[] = []
    for (const name of ['r1', 'r2']) {
      const w = (await call(u, 'POST', '/api/workspaces', { name })).json().workspace
      assert.equal((await call(u, 'DELETE', `/api/workspaces/${w.id}`, { name })).statusCode, 204)
      ids.push(w.id)
    }
    // owns 2 (both deleted, both counted)
    const r2 = L.setLimitsForTests({ workspacesPerUser: 2 })
    try {
      const res = await Promise.all(ids.map((id) => call(u, 'POST', `/api/workspaces/${id}/restore`)))
      assert.deepEqual(res.map((r) => r.statusCode), [200, 200], res.map((r) => r.body).join(' '))
    } finally {
      r2()
    }
    for (const [i, id] of ids.entries()) await call(u, 'DELETE', `/api/workspaces/${id}`, { name: `r${i + 1}` })
    const r1 = L.setLimitsForTests({ workspacesPerUser: 1 })
    try {
      const res = await Promise.all(ids.map((id) => call(u, 'POST', `/api/workspaces/${id}/restore`)))
      for (const r of res) assert.equal(codeOf(r), 'LIMIT_WORKSPACES', r.body)
    } finally {
      r1()
    }
    // a non-owner gets the old answer (404), not a limit error, even while the owner is over
    const stranger = await h.makeUser('own-stranger')
    const r0 = L.setLimitsForTests({ workspacesPerUser: 1 })
    try {
      assert.equal((await call(stranger, 'POST', `/api/workspaces/${ids[0]}/restore`)).statusCode, 404)
    } finally {
      r0()
    }
  })

  it('deleting an account hands its shared workspace over even past the heir\'s limit', async () => {
    const { deleteAccount } = await import('../account/deletion')
    const leaver = await h.makeUser('own-leaver')
    const heir = await h.makeUser('own-heir')
    await h.makeWorkspace(heir)
    const shared = await h.makeWorkspace(leaver, [heir])
    const restore = L.setLimitsForTests({ workspacesPerUser: 1 })
    try {
      const res = await deleteAccount(leaver.id, { by: 'self' })
      assert.equal(res.transferredWorkspaces, 1)
      assert.equal(await owned(heir.id), 2)
      const [row] = (await db.execute(sql`SELECT role FROM workspace_members WHERE workspace_id = ${shared.id} AND user_id = ${heir.id}`)) as unknown as { role: string }[]
      assert.equal(row.role, 'owner')
    } finally {
      restore()
    }
  })
})
