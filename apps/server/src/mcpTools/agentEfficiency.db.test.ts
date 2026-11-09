// Several agents at once (0.12, docs/adr/1550-* .. 1552-*): the find_context result cache (key =
// person + permission state + index markers + normalised query + budget; never shared between
// people), changes_since long-poll (wait, early return on a change, empty at the deadline, caps,
// client abort) and per-connection usage (calls, returned tokens, errors, cache hits, wait time
// left out of the latency), shown in "Connected agents" and the admin status.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent efficiency: context cache, changes_since wait, connection usage', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { sql, eq } = await import('drizzle-orm')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { bumpAcl } = await import('../aclVersion')
  const { sha256 } = await import('../oauth')
  const cache = await import('../context/contextCache')
  const wait = await import('../context/changeWait')
  const usage = await import('../connectionUsage')
  const { agentUsageSummary } = await import('../status/agentUsage')
  const { blocksToStateBuffer } = await import('../md/convert')

  const app = await h.buildTestApp()
  const closers: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of closers) await c()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Blocks = Parameters<typeof h.makeDocPage>[3]
  const doc = (sections: Record<string, string>): Blocks =>
    Object.entries(sections).flatMap(([hd, body]) => [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: hd, styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: body, styles: {} }] },
    ]) as Blocks
  async function newPage(wsId: string, owner: { id: string }, title: string, blocks: Blocks, extra: Record<string, unknown> = {}) {
    const pg = await h.makeDocPage(wsId, owner.id, title, blocks, extra)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg
  }
  async function rewrite(pageId: string, blocks: Blocks) {
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks as never) }).where(eq(schema.pageDocs.pageId, pageId))
    await reindexPageChunks(pageId, blocks as never)
  }
  /** An MCP connection of `u` as production builds it: ctx.user carries the grant (docs/adr/0947-*). */
  async function agent(u: U, clientName = 'Test Agent', scope: string | null = 'notes') {
    const token = await h.mintToken(u, scope, clientName)
    const [g] = await db
      .select({ id: schema.oauthGrants.id, clientId: schema.oauthGrants.clientId })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.accessHash, sha256(token)))
    const m = await h.connectMcp(app, u, token, { user: { ...u, via: clientName, grantId: g.id, clientId: g.clientId, scope: scope ?? '' } })
    closers.push(m.close)
    return { ...m, grantId: g.id }
  }
  const req = (u: U, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { cookie: u.cookie } })

  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const plan = await newPage(ws.id, alice, 'Rollout plan', doc({ Canary: 'canary rollout zebrafish to five percent first', Rollback: 'flip the flag back' }))
  await newPage(ws.id, alice, 'Alice private notes', doc({ Zebrafish: 'private zebrafish canary thoughts' }), { scope: 'private' })

  describe('find_context cache (docs/adr/1550-*)', () => {
    it('a repeat from the same connection is served from the cache with the same text', async () => {
      const A = await agent(alice)
      cache._resetContextCache()
      const first = await A.tool('find_context', { query: 'zebrafish canary' })
      assert.equal(first.isError, false, first.text)
      assert.match(first.text, /Rollout plan/)
      assert.equal(cache.contextCacheStats.misses, 1)
      const second = await A.tool('find_context', { query: 'zebrafish canary' })
      assert.equal(second.text, first.text)
      assert.equal(cache.contextCacheStats.hits, 1)
      // normalised query (case, width, spacing) and the same budget → the same entry
      await A.tool('find_context', { query: '  Zebrafish   CANARY ' })
      assert.equal(cache.contextCacheStats.hits, 2)
      // another budget → its own entry
      await A.tool('find_context', { query: 'zebrafish canary', budget: 600 })
      assert.equal(cache.contextCacheStats.misses, 2)
    })

    it('three connections of one person with the same permission state share one entry', async () => {
      cache._resetContextCache()
      const agents = [await agent(alice, 'Agent 1'), await agent(alice, 'Agent 2'), await agent(alice, 'Agent 3')]
      for (let round = 0; round < 3; round++) for (const a of agents) await a.tool('find_context', { query: 'zebrafish canary' })
      assert.equal(cache.contextCacheStats.misses, 1)
      assert.equal(cache.contextCacheStats.hits, 8)
    })

    it('another person never gets a cached result: own entry, own visibility', async () => {
      cache._resetContextCache()
      const A = await agent(alice)
      const B = await agent(bob)
      const a = await A.tool('find_context', { query: 'zebrafish' })
      assert.match(a.text, /Alice private notes/)
      const b = await B.tool('find_context', { query: 'zebrafish' })
      assert.equal(cache.contextCacheStats.misses, 2)
      assert.equal(cache.contextCacheStats.hits, 0)
      assert.doesNotMatch(b.text, /Alice private notes/)
      // the browser session of the same person is another kind of request (guest workspaces are
      // hidden from tokens, docs/adr/1253-*): its own entry, then hits of its own
      const r = await req(alice, `/context?q=${encodeURIComponent('zebrafish')}`)
      assert.equal(r.statusCode, 200)
      assert.equal(cache.contextCacheStats.misses, 3)
      await req(alice, `/context?q=${encodeURIComponent('zebrafish')}`)
      assert.equal(cache.contextCacheStats.hits, 1)
    })

    it('a range-limited connection has its own entry (range is part of the key)', async () => {
      cache._resetContextCache()
      const A = await agent(alice)
      await A.tool('find_context', { query: 'zebrafish canary' })
      const other = await h.makeWorkspace(alice)
      const token = await h.mintToken(alice, 'notes', 'Ranged')
      await db
        .update(schema.oauthGrants)
        .set({ rangeKind: 'workspaces', rangeWorkspaceIds: [other.id] })
        .where(eq(schema.oauthGrants.accessHash, sha256(token)))
      const R = await h.connectMcp(app, alice, token)
      closers.push(R.close)
      const r = await R.tool('find_context', { query: 'zebrafish canary' })
      assert.doesNotMatch(r.text, /Rollout plan/)
      assert.equal(cache.contextCacheStats.hits, 0)
    })

    it('an edit that reindexes the page invalidates at once', async () => {
      cache._resetContextCache()
      const A = await agent(alice)
      await A.tool('find_context', { query: 'zebrafish canary' })
      await rewrite(plan.id, doc({ Canary: 'canary rollout zebrafish to ten percent first', Rollback: 'flip the flag back' }))
      const after1 = await A.tool('find_context', { query: 'zebrafish canary' })
      assert.match(after1.text, /ten percent/)
      assert.equal(cache.contextCacheStats.hits, 0)
      assert.equal(cache.contextCacheStats.misses, 2)
    })

    it('a permission change (access version), trash and privacy changes invalidate', async () => {
      cache._resetContextCache()
      const B = await agent(bob)
      const extra = await newPage(ws.id, alice, 'Zebrafish handbook', doc({ Care: 'feed the zebrafish daily canary' }))
      assert.match((await B.tool('find_context', { query: 'zebrafish' })).text, /Zebrafish handbook/)
      await db.transaction((tx) => bumpAcl(tx, ws.id))
      await B.tool('find_context', { query: 'zebrafish' })
      assert.equal(cache.contextCacheStats.hits, 0)
      assert.equal(cache.contextCacheStats.misses, 2)
      // made private by its author: bob must not see it, even right after a cached answer
      await db.update(schema.pages).set({ scope: 'private', updatedAt: new Date() }).where(eq(schema.pages.id, extra.id))
      assert.doesNotMatch((await B.tool('find_context', { query: 'zebrafish' })).text, /Zebrafish handbook/)
      await db.update(schema.pages).set({ scope: 'shared', updatedAt: new Date() }).where(eq(schema.pages.id, extra.id))
      assert.match((await B.tool('find_context', { query: 'zebrafish' })).text, /Zebrafish handbook/)
      await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, extra.id))
      assert.doesNotMatch((await B.tool('find_context', { query: 'zebrafish' })).text, /Zebrafish handbook/)
    })

    it('removal from the workspace and an agent block take effect on the next call', async () => {
      cache._resetContextCache()
      const carol = await h.makeUser('carol')
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: carol.id, role: 'member' })
      const C = await agent(carol, 'Carol Agent')
      assert.match((await C.tool('find_context', { query: 'zebrafish canary' })).text, /Rollout plan/)
      await db.insert(schema.workspaceAgentBlocks).values({ workspaceId: ws.id, userId: carol.id, clientId: null, createdBy: alice.id })
      await db.transaction((tx) => bumpAcl(tx, ws.id))
      assert.doesNotMatch((await C.tool('find_context', { query: 'zebrafish canary' })).text, /Rollout plan/)
      await db.delete(schema.workspaceAgentBlocks).where(eq(schema.workspaceAgentBlocks.userId, carol.id))
      await db.delete(schema.workspaceMembers).where(sql`workspace_id = ${ws.id} AND user_id = ${carol.id}`)
      assert.doesNotMatch((await C.tool('find_context', { query: 'zebrafish canary' })).text, /Rollout plan/)
    })

    it('memory is bounded (entries and bytes)', () => {
      assert.ok(cache.CONTEXT_CACHE_MAX_ENTRIES <= 2_000)
      assert.ok(cache.CONTEXT_CACHE_MAX_BYTES <= 64 * 1024 * 1024)
      assert.ok(cache.contextCacheSize().bytes <= cache.CONTEXT_CACHE_MAX_BYTES)
    })
  })

  describe('changes_since wait (docs/adr/1551-*)', () => {
    const cursorOf = (t: string) => {
      const m = /(?:next cursor|cursor): (\S+)$/m.exec(t)
      assert.ok(m, `no cursor in:\n${t}`)
      return m[1]
    }

    it('returns as soon as a visible change is logged', async () => {
      const A = await agent(alice)
      const start = await A.tool('changes_since', { workspaceId: ws.id })
      const cursor = cursorOf(start.text)
      const t0 = Date.now()
      setTimeout(() => void newPage(ws.id, bob, 'Fresh page during wait', doc({ Intro: 'hello from bob' })), 300)
      const r = await A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 10 })
      const took = Date.now() - t0
      assert.equal(r.isError, false, r.text)
      assert.match(r.text, /Fresh page during wait/)
      assert.ok(took < 8_000, `took ${took} ms`)
      assert.ok(took >= 250, `returned before the change (${took} ms)`)
    })

    it('nothing visible: empty answer at the deadline, cursor still valid', async () => {
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      // a change in a workspace alice cannot see does not end the wait
      const stranger = await h.makeUser('stranger')
      const otherWs = await h.makeWorkspace(stranger)
      setTimeout(() => void newPage(otherWs.id, stranger, 'Invisible page', doc({ X: 'nothing for alice' })), 200)
      const t0 = Date.now()
      const r = await A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 1 })
      const took = Date.now() - t0
      assert.match(r.text, /No changes since the cursor\./)
      assert.ok(took >= 950 && took < 8_000, `took ${took} ms`)
      assert.match(r.text, /next cursor: \S+$/)
    })

    it('a change committed between the read and the wait is not missed', async () => {
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      await newPage(ws.id, bob, 'Committed before the wait', doc({ A: 'b' }))
      const t0 = Date.now()
      const r = await A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 10 })
      assert.match(r.text, /Committed before the wait/)
      assert.ok(Date.now() - t0 < 6_000)
    })

    it('a change no local consumer pass reports (another process applied it) still ends the wait', async () => {
      const { setOutboxAutorun } = await import('../outbox')
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      const p = A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 15 })
      await wait._whenWaiters(1)
      // no local pass runs: like a row taken by another process's consumer
      setOutboxAutorun(false)
      const before = wait.changeWaitStats.fallbacks
      const t0 = Date.now()
      try {
        const pg = await h.makeDocPage(ws.id, bob.id, 'Applied elsewhere', doc({ A: 'b' }))
        await reindexPageChunks(pg.id, doc({ A: 'b' }) as never)
        const r = await p
        assert.match(r.text, /Applied elsewhere/)
        assert.ok(Date.now() - t0 < 8_000)
        assert.equal(wait.changeWaitStats.fallbacks, before + 1)
      } finally {
        setOutboxAutorun(true)
      }
    })

    it('wait above the maximum is refused by the schema; without a cursor it is ignored', async () => {
      const A = await agent(alice)
      const r = await A.tool('changes_since', { workspaceId: ws.id, wait: wait.CHANGE_WAIT_MAX_SEC + 1 })
      assert.equal(r.isError, true)
      const t0 = Date.now()
      const s = await A.tool('changes_since', { workspaceId: ws.id, wait: 5 })
      assert.match(s.text, /Start tracking from here/)
      assert.ok(Date.now() - t0 < 2_000)
    })

    it('caps waiting calls per connection; extra calls answer at once with a note', async () => {
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      // long enough that none of them times out before the extra call, even under load
      const pending = Array.from({ length: wait.CHANGE_WAITERS_PER_CONNECTION }, () =>
        A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 20 }),
      )
      // every call has entered its wait (an event from the registry, not a sleep)
      await wait._whenWaiters(wait.CHANGE_WAITERS_PER_CONNECTION)
      const extra = await A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 3 })
      assert.match(extra.text, /^wait skipped: /m)
      assert.equal(wait.activeChangeWaiters(), wait.CHANGE_WAITERS_PER_CONNECTION)
      // end the four waits with a visible change instead of waiting 20 s
      await newPage(ws.id, bob, 'Ends the capped waits', doc({ A: 'b' }))
      for (const r of await Promise.all(pending)) assert.match(r.text, /Ends the capped waits/)
      await wait._whenWaiters(0)
    })

    it('shutdown releases every waiting call at once', async () => {
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      const t0 = Date.now()
      const p = A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 20 })
      await wait._whenWaiters(1)
      wait.releaseChangeWaiters()
      const r = await p
      assert.ok(Date.now() - t0 < 10_000)
      assert.doesNotMatch(r.text, /wait skipped/)
      assert.match(r.text, /No changes since the cursor\./)
      wait._resumeChangeWaits()
    })

    it('an aborted request stops waiting and frees its slot', async () => {
      const A = await agent(alice)
      const cursor = cursorOf((await A.tool('changes_since', { workspaceId: ws.id })).text)
      const ac = new AbortController()
      const p = A.client
        .callTool({ name: 'changes_since', arguments: { cursor, workspaceId: ws.id, wait: 20 } }, undefined, { signal: ac.signal })
        .catch(() => 'aborted')
      await wait._whenWaiters(1)
      ac.abort()
      assert.equal(await p, 'aborted')
      await wait._whenWaiters(0)
    })
  })

  describe('connection usage (docs/adr/1552-*)', () => {
    it('counts calls, returned tokens, errors and cache hits per connection; wait time is not latency', async () => {
      usage._resetUsage()
      cache._resetContextCache()
      const A = await agent(alice, 'Usage Agent')
      const r1 = await A.tool('find_context', { query: 'zebrafish canary' })
      await A.tool('find_context', { query: 'zebrafish canary' })
      const bad = await A.tool('read_page', { pageId: '00000000-0000-4000-8000-000000000000' })
      assert.equal(bad.isError, true)
      const cursor = /cursor: (\S+)$/m.exec((await A.tool('changes_since', { workspaceId: ws.id })).text)![1]
      await A.tool('changes_since', { cursor, workspaceId: ws.id, wait: 2 })
      const u = usage.usageFor(`grant:${A.grantId}`)
      assert.ok(u)
      assert.equal(u.calls, 5)
      assert.equal(u.errors, 1)
      assert.equal(u.cacheHits, 1)
      assert.ok(u.tokens >= 2 * Math.floor(r1.text.length / 4) * 0.5, `tokens ${u.tokens}`)
      assert.ok(u.waitMs >= 1_900, `waitMs ${u.waitMs}`)
      // the two-second wait is not in the latency statistics (with it, the max would exceed the wait)
      assert.ok(u.maxMs < u.waitMs, `max latency ${u.maxMs}, wait ${u.waitMs}`)
      assert.ok(u.lastUsedAt > Date.now() - 60_000)
    })

    it('per workspace: the Connected agents list shows numbers only for calls that reached it', async () => {
      usage._resetUsage()
      const A = await agent(alice, 'Listed Agent')
      await A.tool('find_context', { query: 'zebrafish canary', workspaceId: ws.id })
      await A.tool('read_page', { pageId: plan.id })
      const own = await h.makeWorkspace(alice)
      await A.tool('list_pages', { workspaceId: own.id })
      const res = await req(alice, `/workspaces/${ws.id}/agents`)
      assert.equal(res.statusCode, 200, res.body)
      const body = res.json() as { connections: { grantId: string; usage?: { calls: number; tokens: number; errors: number } | null }[]; usageSince: string }
      const row = body.connections.find((c) => c.grantId === A.grantId)
      assert.ok(row?.usage, JSON.stringify(body))
      assert.equal(row.usage.calls, 2)
      assert.ok(row.usage.tokens > 0)
      assert.ok(Date.parse(body.usageSince) <= Date.now())
      // nothing about content is kept
      assert.doesNotMatch(JSON.stringify(usage.usageFor(`grant:${A.grantId}`)), /zebrafish|Rollout/)
    })

    it('the admin status lists connections with their numbers and names', async () => {
      usage._resetUsage()
      const A = await agent(alice, 'Admin Listed Agent')
      await A.tool('find_context', { query: 'zebrafish canary' })
      const s = await agentUsageSummary()
      const row = s.connections.find((c) => c.id === A.grantId)
      assert.ok(row, JSON.stringify(s))
      assert.equal(row.kind, 'agent')
      assert.equal(row.name, 'Admin Listed Agent')
      assert.equal(row.user?.name, 'alice')
      assert.equal(row.calls, 1)
      assert.ok(s.totals.calls >= 1)
    })

    it('personal API tokens: REST calls counted by token, not MCP-internal requests', async () => {
      usage._resetUsage()
      const { createApiToken } = await import('../apiTokens')
      const Fastify = (await import('fastify')).default
      const { requireUser, getUser } = await import('../auth')
      const mini = Fastify()
      usage.registerUsageHooks(mini)
      mini.get('/api/me', { preHandler: requireUser }, async (r) => ({ id: getUser(r).id, pad: 'x'.repeat(400) }))
      mini.get('/api/fail', { preHandler: requireUser }, async (_r, reply) => reply.code(404).send({ error: 'no' }))
      await mini.ready()
      closers.push(() => mini.close())
      const t = await createApiToken(alice.id, { name: 'cli', expiresInDays: null, access: 'read', range: { kind: 'all' } as never })
      const auth = { authorization: `Bearer ${t.secret}` }
      assert.equal((await mini.inject({ url: '/api/me', headers: auth })).statusCode, 200)
      assert.equal((await mini.inject({ url: '/api/fail', headers: auth })).statusCode, 404)
      const u = usage.usageFor(`token:${t.id}`)
      assert.ok(u)
      assert.equal(u.calls, 2)
      assert.equal(u.errors, 1)
      assert.ok(u.tokens >= 100)
      const s = await agentUsageSummary()
      const row = s.connections.find((c) => c.id === t.id)
      assert.equal(row?.kind, 'token')
      assert.equal(row?.name, 'cli')
    })
  })
})
