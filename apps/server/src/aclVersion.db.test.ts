// Workspace access version, version-keyed caches and the write gate (docs/adr/1071-*), the in-process
// agent context of MCP tools (docs/adr/1070-*), the single-page review score and the audit purge
// (docs/PERFORMANCE.md), against a real database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-acl-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('[db] access version, write gate and agent context', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { bumpAcl, gateWrite, recountLockedPages, reconcileAclVersions } = await import('./aclVersion')
  const { _lockWalks } = await import('./editLock')
  const { loadAgentContext } = await import('./mcpTools/agentContext')
  const { call } = await import('./mcpTools/core')
  const { computeReviewScores } = await import('./review')
  const { purgeOldAuditEvents } = await import('./housekeeping')
  const app = await h.buildTestApp()

  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const titleOf = async (id: string) => (await db.select({ t: schema.pages.title }).from(schema.pages).where(eq(schema.pages.id, id)))[0].t
  /** 'done' when `p` settles within `ms`, else 'waiting'. */
  const settles = (p: PromiseLike<unknown>, ms = 400) =>
    Promise.race([Promise.resolve(p).then(() => 'done' as const, () => 'done' as const), sleep(ms).then(() => 'waiting' as const)])

  let O: U, M: U, E: U
  let wsId: string
  before(async () => {
    O = await h.makeUser('Owner')
    M = await h.makeUser('Member')
    E = await h.makeUser('Editor')
    wsId = (await h.makeWorkspace(O, [M, E])).id
  })

  describe('no-lock fast path and version-keyed lock chains', () => {
    it('a workspace without locks never walks the tree on writes', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Plain', [para('x')] as never)).id
      const before = _lockWalks()
      for (let i = 0; i < 3; i++) assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: `Plain ${i}` })).statusCode, 200)
      assert.equal((await req(M, 'POST', `/pages/${P}/content`, { markdown: 'more', mode: 'append' })).statusCode, 200)
      assert.equal((await req(M, 'POST', `/pages/${P}/comments`, { body: 'hi', blockId: 'b1' })).statusCode, 200)
      assert.equal(_lockWalks(), before, 'no recursive lock walk without a locked page')
    })

    it('walks once per access version under a lock, and sees lock changes at once', async () => {
      const F = (await req(O, 'POST', '/pages', { workspaceId: wsId, kind: 'folder', title: 'Locked folder' })).json().page.id as string
      const D = (await h.makeDocPage(wsId, M.id, 'Under lock', [para('x')] as never, { parentId: F })).id
      assert.equal((await req(O, 'PUT', `/pages/${F}/lock`, { locked: true, editorIds: [E.id] })).statusCode, 200)
      const w0 = _lockWalks()
      assert.equal((await req(E, 'PATCH', `/pages/${D}`, { title: 'E1' })).statusCode, 200)
      assert.equal((await req(E, 'PATCH', `/pages/${D}`, { title: 'E2' })).statusCode, 200)
      assert.equal((await req(E, 'PATCH', `/pages/${D}`, { title: 'E3' })).statusCode, 200)
      assert.equal(_lockWalks() - w0, 1, 'one walk, then the cached chain of this version')
      // M is not an editor
      const m = await req(M, 'PATCH', `/pages/${D}`, { title: 'M' })
      assert.equal(m.statusCode, 403)
      assert.equal(code(m), 'PAGE_LOCKED')
      // E removed from the editors: refused on the very next write (no stale cached allow)
      assert.equal((await req(O, 'PUT', `/pages/${F}/lock`, { locked: true, editorIds: [] })).statusCode, 200)
      const e = await req(E, 'PATCH', `/pages/${D}`, { title: 'E4' })
      assert.equal(e.statusCode, 403, e.body)
      assert.equal(await titleOf(D), 'E3')
      // unlocked: M writes at once (no stale cached deny)
      assert.equal((await req(O, 'PUT', `/pages/${F}/lock`, { locked: false })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'M ok' })).statusCode, 200)
    })

    it('moving a page out of a locked folder takes effect at once', async () => {
      const F = (await req(O, 'POST', '/pages', { workspaceId: wsId, kind: 'folder', title: 'Fence' })).json().page.id as string
      const D = (await h.makeDocPage(wsId, M.id, 'Inside', [para('x')] as never, { parentId: F })).id
      assert.equal((await req(O, 'PUT', `/pages/${F}/lock`, { locked: true })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'no' })).statusCode, 403) // caches the chain
      assert.equal((await req(O, 'PATCH', `/pages/${D}`, { parentId: null })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'yes' })).statusCode, 200)
      // and back in: refused at once
      assert.equal((await req(O, 'PATCH', `/pages/${D}`, { parentId: F })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'no again' })).statusCode, 403)
    })

    it('a lock page owner change applies to the very next write', async () => {
      const F = (await req(O, 'POST', '/pages', { workspaceId: wsId, kind: 'folder', title: 'Owned fence' })).json().page.id as string
      const D = (await h.makeDocPage(wsId, M.id, 'Owned inside', [para('x')] as never, { parentId: F })).id
      await db.update(schema.pages).set({ ownerId: M.id }).where(eq(schema.pages.id, F))
      assert.equal((await req(O, 'PUT', `/pages/${F}/lock`, { locked: true })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'owner writes' })).statusCode, 200) // cached: allowed
      assert.equal((await req(O, 'PUT', `/pages/${F}/owner`, { ownerId: null })).statusCode, 200)
      assert.equal((await req(M, 'PATCH', `/pages/${D}`, { title: 'not owner' })).statusCode, 403)
    })

    it('boot reconciliation fixes a locked-page count written behind its back', async () => {
      const ws2 = (await h.makeWorkspace(O, [M])).id
      const P = (await h.makeDocPage(ws2, O.id, 'Sneaky', [para('x')] as never)).id
      assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'before' })).statusCode, 200) // creates the row (0 locks)
      // edit_locked written without a bump (not an API path): the live EXISTS still sees it
      await db.update(schema.pages).set({ editLocked: true }).where(eq(schema.pages.id, P))
      await db.insert(schema.pageAccessOverrides).values({ pageId: P, subject: 'everyone', deny: 1 })
      assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'after' })).statusCode, 403)
      assert.ok((await reconcileAclVersions()) >= 1)
      const [row] = await db.select().from(schema.workspaceAclVersions).where(eq(schema.workspaceAclVersions.workspaceId, ws2))
      assert.equal(row.lockedPages, 1)
    })
  })

  describe('write gate (no check-then-write race with access changes)', () => {
    it('a write that starts during a lock change waits for it and is refused', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Race A', [para('x')] as never)).id
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let locked!: () => void
      const lockedP = new Promise<void>((r) => (locked = r))
      // A lock change in progress (what applyLockChange does), not committed yet.
      const change = db.transaction(async (tx) => {
        await bumpAcl(tx, wsId)
        await tx.update(schema.pages).set({ editLocked: true }).where(eq(schema.pages.id, P))
        await tx.insert(schema.pageAccessOverrides).values({ pageId: P, subject: 'everyone', deny: 1 })
        await recountLockedPages(tx, wsId)
        locked()
        await held
      })
      await lockedP
      const patch = req(M, 'PATCH', `/pages/${P}`, { title: 'raced' })
      assert.equal(await settles(patch), 'waiting', 'the write waits for the lock change')
      release()
      await change
      const r = await patch
      assert.equal(r.statusCode, 403, r.body)
      assert.equal(code(r), 'PAGE_LOCKED')
      assert.equal(await titleOf(P), 'Race A')
    })

    it('a lock change waits for a write in progress; later writes see the lock', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Race B', [para('x')] as never)).id
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let gated!: () => void
      const gatedP = new Promise<void>((r) => (gated = r))
      // A write that already passed its check under the gate.
      const write = db.transaction(async (tx) => {
        const g = await gateWrite(tx, wsId, M.id)
        assert.equal(g.role, 'member')
        gated()
        await held
        await tx.update(schema.pages).set({ title: 'written before the lock' }).where(eq(schema.pages.id, P))
      })
      await gatedP
      const put = req(O, 'PUT', `/pages/${P}/lock`, { locked: true })
      assert.equal(await settles(put), 'waiting', 'the lock change waits for the write')
      release()
      await write
      assert.equal((await put).statusCode, 200)
      assert.equal(await titleOf(P), 'written before the lock')
      assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'after the lock' })).statusCode, 403)
    })

    it('concurrent writers do not wait for each other', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Shared gate', [para('x')] as never)).id
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let gated!: () => void
      const gatedP = new Promise<void>((r) => (gated = r))
      const write = db.transaction(async (tx) => {
        await gateWrite(tx, wsId, M.id)
        gated()
        await held
      })
      await gatedP
      assert.equal(await settles(req(E, 'PATCH', `/pages/${P}`, { title: 'parallel' }), 2_000), 'done')
      release()
      await write
      assert.equal(await titleOf(P), 'parallel')
    })
  })

  describe('agents: blocks and the in-process agent context', () => {
    it('a block applies to the very next agent call (no cached allow), unblock likewise', async () => {
      const P = (await h.makeDocPage(wsId, M.id, 'Agent page', [para('x')] as never)).id
      const mcp = await h.connectMcp(app, { ...M, via: 'Test Agent' }, await h.mintToken(M))
      try {
        assert.equal((await mcp.tool('read_page', { pageId: P })).isError, false)
        assert.equal((await mcp.tool('update_page', { pageId: P, markdown: 'a', mode: 'append' })).isError, false)
        const b = await req(O, 'POST', `/workspaces/${wsId}/agents/blocks`, { userId: M.id })
        assert.equal(b.statusCode, 200, b.body)
        const w = await mcp.tool('update_page', { pageId: P, markdown: 'b', mode: 'append' })
        assert.equal(w.isError, true)
        assert.match(w.text, /blocked this agent connection|not found/)
        assert.equal((await mcp.tool('rename_page', { pageId: P, title: 'blocked' })).isError, true)
        assert.equal((await mcp.tool('read_page', { pageId: P })).isError, true)
        assert.equal(await titleOf(P), 'Agent page')
        // the person is not blocked
        assert.equal((await req(M, 'PATCH', `/pages/${P}`, { title: 'person' })).statusCode, 200)
        const del = await req(O, 'DELETE', `/workspaces/${wsId}/agents/blocks/${b.json().block.id}`)
        assert.ok(del.statusCode < 300, del.body)
        assert.equal((await mcp.tool('rename_page', { pageId: P, title: 'unblocked' })).isError, false)
        assert.equal(await titleOf(P), 'unblocked')
      } finally {
        await mcp.close()
      }
    })

    it('the in-process agent context equals GET /pages/agent-context; tool output is byte-stable', async () => {
      const G = (await h.makeDocPage(wsId, M.id, 'Agents read only', [para('text')] as never)).id
      const X = (await h.makeDocPage(wsId, M.id, 'Free', [para('text')] as never)).id
      assert.equal((await req(O, 'PUT', `/pages/${G}/lock`, { locked: true, people: 'everyone', agents: 'read' })).statusCode, 200)
      const mcp = await h.connectMcp(app, { ...M, via: 'Test Agent' }, await h.mintToken(M))
      try {
        for (const ids of [[G], [X], [X, G]]) {
          const direct = await loadAgentContext(mcp.ctx, ids)
          const injected = (await call(mcp.ctx, 'GET', '/api/pages/agent-context', { query: { ids: ids.join(',') } })).json()
          assert.deepEqual(JSON.parse(JSON.stringify(direct)), injected)
        }
        const g = await mcp.tool('read_page', { pageId: G })
        assert.match(g.text, /^- can: read$/m, 'agent rules apply in process')
        assert.equal((await mcp.tool('read_page', { pageId: G })).text, g.text, 'same state, same bytes')
        assert.match((await mcp.tool('read_page', { pageId: X })).text, /^- can: read,comment,edit$/m)
        assert.equal((await mcp.tool('update_page', { pageId: G, markdown: 'x', mode: 'append' })).isError, true)
        // the person may still edit G
        assert.equal((await req(M, 'PATCH', `/pages/${G}`, { title: 'person edit' })).statusCode, 200)
      } finally {
        await mcp.close()
      }
    })

    it('an instruction designation shows up at once (applies: line), and goes away at once', async () => {
      const ws3 = (await h.makeWorkspace(O, [M])).id
      const P = (await h.makeDocPage(ws3, M.id, 'Work', [para('x')] as never)).id
      const I = (await h.makeDocPage(ws3, O.id, 'House rules', [para('be nice')] as never)).id
      const mcp = await h.connectMcp(app, { ...M, via: 'Test Agent' }, await h.mintToken(M))
      try {
        const before = (await mcp.tool('read_page', { pageId: P })).text
        assert.doesNotMatch(before, /^applies:/m)
        assert.equal((await req(O, 'PUT', `/pages/${I}/agent-instructions`, { mode: 'always' })).statusCode, 200)
        assert.match((await mcp.tool('read_page', { pageId: P })).text.split('\n')[0], /^applies: House rules/)
        assert.ok((await req(O, 'DELETE', `/pages/${I}/agent-instructions`)).statusCode < 300)
        assert.doesNotMatch((await mcp.tool('read_page', { pageId: P })).text, /^applies:/m)
      } finally {
        await mcp.close()
      }
    })
  })

  describe('review score of one page and the audit purge', () => {
    it('a single-page recompute gives the same row as the workspace run', async () => {
      const ws4 = (await h.makeWorkspace(O, [M])).id
      await db.update(schema.workspaces).set({ reviewIntervalDays: 30 }).where(eq(schema.workspaces.id, ws4))
      const A = (await h.makeDocPage(ws4, O.id, 'A', [para('a')] as never)).id
      const B = (await h.makeDocPage(ws4, O.id, 'B', [para('b')] as never)).id
      const Cc = (await h.makeDocPage(ws4, O.id, 'C', [para('c')] as never)).id
      await db.insert(schema.pageLinks).values([{ sourcePageId: A, targetPageId: B }])
      const day = (d: number) => new Date(Date.now() - d * 86_400_000)
      const change = (pageId: string, d: number) => ({
        workspaceId: ws4, pageId, anchor: 'intro', kind: 'modified', scope: 'shared', changedAt: day(d),
      })
      await db.insert(schema.pageChanges).values([change(A, 1), change(A, 3), change(B, 2), change(B, 5), change(B, 9), change(Cc, 4)])
      const rowOf = async (id: string) => {
        const [r] = await db.select().from(schema.pageReviewScores).where(eq(schema.pageReviewScores.pageId, id))
        return r
      }
      const now = new Date()
      await computeReviewScores(ws4, now)
      const whole = await rowOf(A)
      await db.delete(schema.pageReviewScores).where(eq(schema.pageReviewScores.pageId, A))
      await computeReviewScores(ws4, now, [A])
      assert.deepEqual(await rowOf(A), whole)
    })

    it('purges audit events per workspace retention only', async () => {
      const w1 = (await h.makeWorkspace(O)).id
      const w2 = (await h.makeWorkspace(O)).id
      await db.update(schema.workspaces).set({ auditRetentionDays: 10 }).where(eq(schema.workspaces.id, w1))
      await db.update(schema.workspaces).set({ auditRetentionDays: 100 }).where(eq(schema.workspaces.id, w2))
      const ev = (ws: string, d: number) => ({ workspaceId: ws, action: 'test.event', createdAt: new Date(Date.now() - d * 86_400_000) })
      await db.insert(schema.workspaceAuditEvents).values([ev(w1, 5), ev(w1, 20), ev(w1, 50), ev(w2, 20), ev(w2, 150)])
      await purgeOldAuditEvents(new Date())
      const left = async (ws: string) =>
        (
          await db.execute(sql`SELECT count(*)::int AS n FROM workspace_audit_events WHERE workspace_id = ${ws} AND action = 'test.event'`)
        )[0] as { n: number }
      assert.equal((await left(w1)).n, 1)
      assert.equal((await left(w2)).n, 1)
    })
  })
})
