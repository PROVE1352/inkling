// PATCH /pages/:id checks storage only after the edit check (0.22.1, contract §15, review N7,
// docs/adr/2547-*). The review: someone who may only read the page moved the workspace's cached use up
// (assertWorkspaceGrowth ran first) and read `used` and `limit` from the 413. Now a member without edit
// rights gets the edit refusal and the cache stays; and a page guest, who is not a member, never gets the
// workspace's numbers in a 413 (members can read them from GET /workspaces/:id/usage anyway).
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] PATCH /pages/:id: storage after the edit check; no workspace numbers for a guest', { skip: !process.env.DATABASE_URL }, () => {
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let schema: typeof import('../db/schema')
  let app: Awaited<ReturnType<typeof import('../mcpTools/testHarness').buildTestApp>>
  let closeDb: () => Promise<void>

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    schema = await import('../db/schema')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    app = await h.buildTestApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
    setTimeout(() => process.exit(0), 300).unref()
  })

  const rename = (u: { cookie: string }, id: string, title: string) =>
    app.inject({ method: 'PATCH', url: `/api/pages/${id}`, headers: { cookie: u.cookie }, payload: { title } })
  const cached = async (ws: string) =>
    Number(((await db.execute(sql`SELECT storage_bytes AS n FROM workspaces WHERE id = ${ws}`)) as unknown as { n: string }[])[0].n)

  const setup = async () => {
    const owner = await h.makeUser('n7-owner')
    const member = await h.makeUser('n7-member')
    const guest = await h.makeUser('n7-guest')
    await h.makeWorkspace(guest)
    const ws = await h.makeWorkspace(owner, [member])
    const locked = await h.makeDocPage(ws.id, owner.id, 'locked', [] as never)
    const open = await h.makeDocPage(ws.id, owner.id, 'shared with a guest', [] as never)
    // the member may only read `locked` (an edit lock with no extra editors)
    const lock = await app.inject({ method: 'PUT', url: `/api/pages/${locked.id}/lock`, headers: { cookie: owner.cookie }, payload: { locked: true, editorIds: [] } })
    assert.equal(lock.statusCode, 200, lock.body)
    // the guest may edit `open` (a page grant, no membership)
    const { bumpAcl } = await import('../aclVersion')
    await db.transaction(async (tx) => {
      await tx.insert(schema.pageGrants).values({ pageId: open.id, userId: guest.id, level: 'edit', createdBy: owner.id })
      await bumpAcl(tx, ws.id)
    })
    return { owner, member, guest, ws: ws.id, locked: locked.id, open: open.id }
  }

  it('a member who may only read: the edit refusal, and the cached use does not move', async () => {
    const x = await setup()
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      await db.execute(sql`UPDATE workspaces SET storage_bytes = 1000, over_storage = false, storage_checked_at = now() WHERE id = ${x.ws}`)
      const r = await rename(x.member, x.locked, 'z'.repeat(400))
      assert.equal(r.statusCode, 403, r.body)
      assert.equal(await cached(x.ws), 1000, 'the review: +400 before the refusal')
      // a full workspace: still the edit refusal, never the 413 with the workspace's numbers
      await db.execute(sql`UPDATE workspaces SET storage_bytes = ${L.mbToBytes(1)}, over_storage = true, storage_checked_at = now() WHERE id = ${x.ws}`)
      const full = await rename(x.member, x.locked, 'again')
      assert.equal(full.statusCode, 403, full.body)
      assert.equal((full.json() as { error: { used?: number } }).error.used, undefined)
    } finally {
      restore()
    }
  })

  it('a full workspace: the owner gets 413 with used and limit; a page guest gets 413 without them', async () => {
    const x = await setup()
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      await db.execute(sql`UPDATE workspaces SET storage_bytes = ${L.mbToBytes(1)}, over_storage = true, storage_checked_at = now() WHERE id = ${x.ws}`)
      const own = await rename(x.owner, x.open, 'owner rename')
      assert.equal(own.statusCode, 413, own.body)
      const oe = (own.json() as { error: { code: string; used?: number; limit?: number } }).error
      assert.equal(oe.code, 'LIMIT_STORAGE')
      assert.equal(oe.limit, L.mbToBytes(1))
      assert.equal(typeof oe.used, 'number')
      const g = await rename(x.guest, x.open, 'guest rename')
      assert.equal(g.statusCode, 413, g.body)
      const ge = (g.json() as { error: Record<string, unknown> }).error
      assert.equal(ge.code, 'LIMIT_STORAGE')
      assert.equal('used' in ge || 'limit' in ge, false, `guest error: ${g.body}`)
    } finally {
      restore()
    }
  })

  it('without a storage limit: renames go through and the cache never moves (0.22.0)', async () => {
    const x = await setup()
    await db.execute(sql`UPDATE workspaces SET storage_bytes = 1000, over_storage = true WHERE id = ${x.ws}`)
    assert.equal((await rename(x.owner, x.open, 'plain')).statusCode, 200)
    assert.equal((await rename(x.guest, x.open, 'plain guest')).statusCode, 200)
    assert.equal((await rename(x.member, x.locked, 'nope')).statusCode, 403)
    assert.equal(await cached(x.ws), 1000)
  })
})
