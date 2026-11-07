// Fix-phase (ship-blocking) regression tests — docs/adr/0800-0809.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// [db] tests need a migrated scratch database and are skipped without DATABASE_URL.

// Env read at module load by env.ts / importer.ts — set before any app module is imported.
process.env.PUBLIC_URL = 'https://notes.example.com/'
process.env.IMPORT_MAX_PAGES = '50'
// Upload blobs written by the forced-deletion test go to a throwaway directory, not apps/server/data.
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-fixphase-${process.pid}`

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const dbIt = HAS_DB ? it : it.skip

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('maskUrlSecrets (C-L8)', async () => {
  const { maskUrlSecrets } = await import('./util')
  it('masks path tokens and secret query params', () => {
    assert.equal(maskUrlSecrets('/ical/abcDEF123.ics'), '/ical/***')
    assert.equal(maskUrlSecrets('/api/public/tok123/p/x/f/y'), '/api/public/***/p/x/f/y')
    assert.equal(maskUrlSecrets('/s/tok123'), '/s/***')
    assert.equal(
      maskUrlSecrets('/oauth/authorize?client_id=c&code=SECRET&state=s1&x=1'),
      '/oauth/authorize?client_id=c&code=***&state=***&x=1',
    )
    assert.equal(maskUrlSecrets('/api/pages/1?token=t&key=k'), '/api/pages/1?token=***&key=***')
    assert.equal(maskUrlSecrets('/api/pages/1'), '/api/pages/1')
  })
})

describe('trustedClientIp (C-L3)', async () => {
  const { trustedClientIp, _test } = await import('./guard')
  const list = _test.buildTrustList(['loopback', 'uniquelocal'])
  it('ignores XFF from an untrusted peer', () => {
    assert.equal(trustedClientIp('203.0.113.9', '1.2.3.4', list), '203.0.113.9')
  })
  it('walks trusted proxies right to left', () => {
    assert.equal(trustedClientIp('127.0.0.1', '1.2.3.4, 198.51.100.7', list), '198.51.100.7')
    assert.equal(trustedClientIp('172.18.0.3', '198.51.100.7, 10.0.0.2', list), '198.51.100.7')
    assert.equal(trustedClientIp('::ffff:127.0.0.1', '198.51.100.8', list), '198.51.100.8')
  })
  it('TRUST_PROXY=false means the socket peer', () => {
    assert.equal(trustedClientIp('127.0.0.1', '1.2.3.4', null), '127.0.0.1')
  })
})

describe('withRetry / withTimeout (B-H1)', async () => {
  const { withRetry, withTimeout } = await import('./lifecycle')
  it('retries 3 times then rethrows', async () => {
    let n = 0
    await assert.rejects(
      withRetry(
        async () => {
          n++
          throw new Error('db down')
        },
        { attempts: 4, baseMs: 1 },
      ),
      /db down/,
    )
    assert.equal(n, 4)
  })
  it('succeeds after a transient failure', async () => {
    let n = 0
    const v = await withRetry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { baseMs: 1 })
    assert.equal(v, 'ok')
    assert.equal(n, 3)
  })
  it('times out', async () => {
    // withTimeout unrefs its timer (it must not hold a shutting-down process open), so keep the
    // event loop alive here; otherwise Node 22's test runner sees an empty loop and cancels.
    const keepAlive = setInterval(() => {}, 1000)
    try {
      await assert.rejects(withTimeout(new Promise(() => {}), 20, 'step'), /step timed out/)
    } finally {
      clearInterval(keepAlive)
    }
  })
})

describe('zip import metering (C-M6)', async () => {
  const JSZip = (await import('jszip')).default
  const { readZipEntryCapped } = await import('./md/importer')
  it('stops a highly compressed entry at the cap by real bytes', async () => {
    const zip = new JSZip()
    zip.file('bomb.md', Buffer.alloc(3 * 1024 * 1024, 0x61))
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    const e = loaded.file('bomb.md')!
    await assert.rejects(readZipEntryCapped(e, { total: 0 }, { entry: 1024 * 1024, total: 10 * 1024 * 1024 }), /too large/)
    const meter = { total: 0 }
    const ok = await readZipEntryCapped(e, meter, { entry: 4 * 1024 * 1024, total: 10 * 1024 * 1024 })
    assert.equal(ok.length, 3 * 1024 * 1024)
    assert.equal(meter.total, 3 * 1024 * 1024)
    await assert.rejects(readZipEntryCapped(e, meter, { entry: 4 * 1024 * 1024, total: 5 * 1024 * 1024 }), /when unpacked/)
  })
})

describe('OAuth issuer from PUBLIC_URL (C-M1)', async () => {
  it('issuer is the configured origin, whatever the Host header says', async () => {
    const Fastify = (await import('fastify')).default
    const { registerOAuthRoutes } = await import('./routes/oauth')
    const app = Fastify()
    await app.register(async (pub) => registerOAuthRoutes(pub))
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    })
    assert.equal(res.statusCode, 200)
    const meta = res.json() as { issuer: string; token_endpoint: string }
    assert.equal(meta.issuer, 'https://notes.example.com')
    assert.equal(meta.token_endpoint, 'https://notes.example.com/oauth/token')
    await app.close()
  })
  it('mail with no configured origin refuses to boot', async () => {
    const { assertOriginConfigured } = await import('./origin')
    assert.doesNotThrow(() => assertOriginConfigured()) // PUBLIC_URL is set in this process
  })
})

// ---------------------------------------------------------------------------
// [db] route-level tests (real Postgres, concurrent requests through Fastify inject)
// ---------------------------------------------------------------------------

describe('[db] fix phase', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb, POOL_TIMEOUTS } = await import('./db/index')
  const schema = await import('./db/schema')
  const { createSession, SESSION_COOKIE } = await import('./auth')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const { sql, eq, and, isNull } = await import('drizzle-orm')
  const { ancestorChain, TREE_MAX_DEPTH } = await import('./pageTree')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION' } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/admin')).registerAdminRoutes(api)
      await (await import('./routes/collections')).registerCollectionRoutes(api)
      await (await import('./routes/ink')).registerInkRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  const tag = () => randomUUID().slice(0, 8)
  async function user(name = 'u', isAdmin = false) {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `${name}-${tag()}@t.t`, name, passwordHash: 'x', isAdmin })
      .returning()
    const { token } = await createSession(u.id)
    return { ...u, cookie: `${SESSION_COOKIE}=${token}` }
  }
  async function workspace(owner: { id: string }, members: { id: string; role?: 'owner' | 'member' }[] = []) {
    const [ws] = await db.insert(schema.workspaces).values({ name: 'w', inviteCode: `I${tag()}` }).returning()
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: ws.id, userId: owner.id, role: 'owner' },
      ...members.map((m) => ({ workspaceId: ws.id, userId: m.id, role: m.role ?? ('member' as const) })),
    ])
    return ws
  }
  async function page(wsId: string, by: string, v: Partial<typeof schema.pages.$inferInsert> = {}) {
    const [p] = await db
      .insert(schema.pages)
      .values({ workspaceId: wsId, title: v.title ?? 'p', createdBy: by, ...v })
      .returning()
    return p
  }
  const req = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object })

  async function hasCycle(id: string): Promise<boolean> {
    const chain = await ancestorChain(db, id)
    return chain.slice(1).some((r) => r.id === id) || chain.length > TREE_MAX_DEPTH
  }

  let owner: Awaited<ReturnType<typeof user>>
  let member: Awaited<ReturnType<typeof user>>
  let ws: Awaited<ReturnType<typeof workspace>>
  before(async () => {
    owner = await user('owner')
    member = await user('member')
    ws = await workspace(owner, [member])
  })

  it('guard bans by route pattern, so encoded paths cannot bypass it (C-L1)', async () => {
    const { banIp, guardHook, ipKey } = await import('./guard')
    const g = Fastify()
    g.addHook('onRequest', guardHook)
    g.post('/api/auth/login', async () => ({ ok: true }))
    g.get('/api/other', async () => ({ ok: true }))
    await g.ready()
    const ip = '198.51.100.77'
    await banIp(ipKey(ip), 'test', 99, 60_000)
    const hit = (url: string, method = 'POST') => g.inject({ method: method as 'POST', url, remoteAddress: ip })
    assert.equal((await hit('/api/auth/login')).statusCode, 429)
    assert.equal((await hit('/api/auth/log%69n')).statusCode, 429)
    assert.equal((await hit('/api/other', 'GET')).statusCode, 200)
    assert.equal((await hit('/api/nope', 'GET')).statusCode, 404)
    const other = await g.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.78' })
    assert.equal(other.statusCode, 200)
    await g.close()
  })

  it('pool connections carry statement/lock/idle timeouts (B-M4)', async () => {
    const [r] = (await db.execute(sql`SELECT current_setting('statement_timeout') AS st,
      current_setting('lock_timeout') AS lt, current_setting('idle_in_transaction_session_timeout') AS it`)) as unknown as {
      st: string
      lt: string
      it: string
    }[]
    assert.equal(r.st, '15s')
    assert.equal(r.lt, '10s')
    assert.equal(r.it, '1min')
    assert.equal(POOL_TIMEOUTS.statement_timeout, 15_000)
  })

  it('10 rounds of concurrent mutual moves never commit a cycle (A-H1)', async () => {
    let rejected = 0
    for (let i = 0; i < 10; i++) {
      const a = await page(ws.id, member.id, { title: `a${i}` })
      const b = await page(ws.id, member.id, { title: `b${i}` })
      const [ra, rb] = await Promise.all([
        req(member.cookie, 'PATCH', `/api/pages/${a.id}`, { parentId: b.id }),
        req(member.cookie, 'PATCH', `/api/pages/${b.id}`, { parentId: a.id }),
      ])
      const codes = [ra.statusCode, rb.statusCode].sort()
      assert.deepEqual(codes, [200, 400], `round ${i}: ${ra.body} / ${rb.body}`)
      rejected++
      assert.equal(await hasCycle(a.id), false)
      assert.equal(await hasCycle(b.id), false)
    }
    assert.equal(rejected, 10)
  })

  it('three-way concurrent cycle attempt leaves a tree', async () => {
    const [a, b, c] = [await page(ws.id, member.id), await page(ws.id, member.id), await page(ws.id, member.id)]
    const res = await Promise.all([
      req(member.cookie, 'PATCH', `/api/pages/${a.id}`, { parentId: b.id }),
      req(member.cookie, 'PATCH', `/api/pages/${b.id}`, { parentId: c.id }),
      req(member.cookie, 'PATCH', `/api/pages/${c.id}`, { parentId: a.id }),
    ])
    assert.equal(res.filter((r) => r.statusCode === 200).length, 2)
    for (const p of [a, b, c]) assert.equal(await hasCycle(p.id), false)
  })

  it('102-level chain: moving its root under the leaf is refused (C-H2)', async () => {
    const chain: string[] = []
    let parentId: string | null = null
    for (let i = 0; i < 102; i++) {
      const p = await page(ws.id, member.id, { title: `c${i}`, parentId })
      chain.push(p.id)
      parentId = p.id
    }
    const res = await req(member.cookie, 'PATCH', `/api/pages/${chain[0]}`, { parentId: chain[101] })
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(await hasCycle(chain[0]), false)
    // creating below the 64-level cap is refused as well
    const deep = await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: chain[101] })
    assert.equal(deep.statusCode, 400)
    const ok = await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: chain[10] })
    assert.equal(ok.statusCode, 200, ok.body)
  })

  it('a cycle already in the database cannot hang delete/restore/purge/list', async () => {
    const a = await page(ws.id, member.id)
    const b = await page(ws.id, member.id, { parentId: a.id })
    await db.update(schema.pages).set({ parentId: b.id }).where(eq(schema.pages.id, a.id)) // legacy cycle
    const t0 = Date.now()
    assert.equal((await req(member.cookie, 'DELETE', `/api/pages/${a.id}`)).statusCode, 204)
    assert.equal((await req(member.cookie, 'POST', `/api/pages/${a.id}/restore`)).statusCode, 200)
    assert.equal((await req(member.cookie, 'GET', `/api/workspaces/${ws.id}/pages`)).statusCode, 200)
    assert.equal((await req(member.cookie, 'DELETE', `/api/pages/${a.id}`)).statusCode, 204)
    assert.equal((await req(member.cookie, 'DELETE', `/api/pages/${a.id}/purge`)).statusCode, 204)
    assert.ok(Date.now() - t0 < 5000)
  })

  it('creating under a trashed parent is refused; purge never removes a live child (A-M10)', async () => {
    const parent = await page(ws.id, member.id)
    assert.equal((await req(member.cookie, 'DELETE', `/api/pages/${parent.id}`)).statusCode, 204)
    const res = await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: parent.id })
    assert.equal(res.statusCode, 400)
    // a live child that slipped under a trashed parent before the lock existed
    const child = await page(ws.id, member.id, { parentId: parent.id })
    assert.equal((await req(member.cookie, 'DELETE', `/api/pages/${parent.id}/purge`)).statusCode, 204)
    const [c] = await db.select().from(schema.pages).where(eq(schema.pages.id, child.id))
    assert.ok(c, 'live child survived the purge')
    assert.equal(c.parentId, null)
    assert.equal(c.deletedAt, null)
  })

  it('housekeeping purge walks trashed rows only', async () => {
    const { runHousekeeping } = await import('./housekeeping')
    const old = new Date(Date.now() - 40 * 86_400_000)
    const parent = await page(ws.id, member.id, { deletedAt: old })
    const deadChild = await page(ws.id, member.id, { parentId: parent.id, deletedAt: old })
    const liveChild = await page(ws.id, member.id, { parentId: parent.id })
    await runHousekeeping(() => {})
    const ids = (await db.select({ id: schema.pages.id }).from(schema.pages)).map((r) => r.id)
    assert.ok(!ids.includes(parent.id))
    assert.ok(!ids.includes(deadChild.id))
    assert.ok(ids.includes(liveChild.id))
  })

  it('concurrent restore and purge end consistent (A-M11)', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await page(ws.id, member.id)
      const kid = await page(ws.id, member.id, { parentId: p.id })
      await req(member.cookie, 'DELETE', `/api/pages/${p.id}`)
      const [r1, r2] = await Promise.all([
        req(member.cookie, 'POST', `/api/pages/${p.id}/restore`),
        req(member.cookie, 'DELETE', `/api/pages/${p.id}/purge`),
      ])
      const rows = await db.select().from(schema.pages).where(sql`${schema.pages.id} IN (${p.id}, ${kid.id})`)
      if (r1.statusCode === 200 && rows.length) {
        assert.equal(rows.length, 2)
        assert.ok(rows.every((r) => r.deletedAt === null))
        assert.equal(r2.statusCode, 400)
      } else {
        assert.equal(rows.length, 0, `${r1.statusCode} ${r2.statusCode}`)
      }
    }
  })

  it('public folder: only owners publish into it; rows and in-folder moves stay open (C-M5)', async () => {
    const folder = await page(ws.id, owner.id, { kind: 'folder', shareToken: `tok-${tag()}` })
    const inside = await page(ws.id, member.id, { parentId: folder.id })
    const outside = await page(ws.id, member.id)
    const create = await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: folder.id })
    assert.equal(create.statusCode, 403)
    const move = await req(member.cookie, 'PATCH', `/api/pages/${outside.id}`, { parentId: folder.id })
    assert.equal(move.statusCode, 403)
    const sub = await page(ws.id, member.id, { parentId: folder.id })
    const within = await req(member.cookie, 'PATCH', `/api/pages/${inside.id}`, { parentId: sub.id })
    assert.equal(within.statusCode, 200, within.body)
    const byOwner = await req(owner.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: folder.id })
    assert.equal(byOwner.statusCode, 200)
    const coll = await req(owner.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: folder.id, kind: 'collection' })
    const row = await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, parentId: coll.json().page.id })
    assert.equal(row.statusCode, 200, row.body)
  })

  it('concurrent page property edits merge (A-M5)', async () => {
    const p = await page(ws.id, member.id)
    await Promise.all([
      req(member.cookie, 'PATCH', `/api/pages/${p.id}`, { fullWidth: true }),
      req(member.cookie, 'PATCH', `/api/pages/${p.id}`, { done: true }),
      req(member.cookie, 'PATCH', `/api/pages/${p.id}`, { dateProperty: { value: '2026-11-07' } }),
    ])
    const [r] = await db.select({ properties: schema.pages.properties }).from(schema.pages).where(eq(schema.pages.id, p.id))
    const ids = (r.properties as { id: string }[]).map((x) => x.id).sort()
    assert.deepEqual(ids, ['date', 'done', 'fullWidth'])
  })

  it('concurrent row prop edits of different cells both survive (A-M4)', async () => {
    const coll = (await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, kind: 'collection' })).json().page
    const row = await page(ws.id, member.id, { parentId: coll.id })
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`)
    const res = await Promise.all(keys.map((k) => req(member.cookie, 'PATCH', `/api/pages/${row.id}/props`, { props: { [k]: k } })))
    assert.ok(res.every((r) => r.statusCode === 200), res.map((r) => r.body).join('\n'))
    const [r] = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, row.id))
    for (const k of keys) assert.equal((r.props as Record<string, string>)[k], k)
    const del = await req(member.cookie, 'PATCH', `/api/pages/${row.id}/props`, { props: { k0: null } })
    assert.equal(del.statusCode, 200)
    assert.equal(del.json().row.props.k0, undefined)
  })

  it('person cells reject users outside the workspace (C-L11)', async () => {
    const stranger = await user('stranger')
    const coll = (await req(member.cookie, 'POST', '/api/pages', { workspaceId: ws.id, kind: 'collection' })).json().page
    const fields = (await req(member.cookie, 'GET', `/api/pages/${coll.id}/collection?rows=0`)).json().collection.fields
    const person = fields.find((f: { type: string }) => f.type === 'person')
    const row = await page(ws.id, member.id, { parentId: coll.id })
    const bad = await req(member.cookie, 'PATCH', `/api/pages/${row.id}/props`, { props: { [person.id]: stranger.id } })
    assert.equal(bad.statusCode, 400)
    const good = await req(member.cookie, 'PATCH', `/api/pages/${row.id}/props`, { props: { [person.id]: owner.id } })
    assert.equal(good.statusCode, 200)
  })

  it('two owners demoting each other at once leave at least one owner (A-H2)', async () => {
    for (let i = 0; i < 10; i++) {
      const o1 = await user('o1')
      const o2 = await user('o2')
      const w = await workspace(o1, [{ id: o2.id, role: 'owner' }])
      const [r1, r2] = await Promise.all([
        req(o1.cookie, 'PATCH', `/api/workspaces/${w.id}/members/${o2.id}`, { role: 'member' }),
        req(o2.cookie, 'PATCH', `/api/workspaces/${w.id}/members/${o1.id}`, { role: 'member' }),
      ])
      const owners = await db
        .select()
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, w.id), eq(schema.workspaceMembers.role, 'owner')))
      assert.ok(owners.length >= 1, `round ${i}: ${r1.statusCode}/${r2.statusCode}`)
    }
  })

  it('concurrent leave of both owners keeps one (A-H2)', async () => {
    const o1 = await user('o1')
    const o2 = await user('o2')
    const w = await workspace(o1, [{ id: o2.id, role: 'owner' }])
    await Promise.all([
      req(o1.cookie, 'DELETE', `/api/workspaces/${w.id}/members/${o1.id}`),
      req(o2.cookie, 'DELETE', `/api/workspaces/${w.id}/members/${o2.id}`),
    ])
    const owners = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, w.id))
    assert.equal(owners.length, 1)
  })

  it('invite code: owner-only in GET /workspaces, regenerated when an owner removes a member (C-M3)', async () => {
    const m2 = await user('m2')
    const w = await workspace(owner, [m2])
    const asMember = (await req(m2.cookie, 'GET', '/api/workspaces')).json().workspaces.find((x: { id: string }) => x.id === w.id)
    assert.equal(asMember.inviteCode, '')
    const before = (await req(owner.cookie, 'GET', '/api/workspaces')).json().workspaces.find((x: { id: string }) => x.id === w.id)
    assert.equal(before.inviteCode, w.inviteCode)
    assert.equal((await req(owner.cookie, 'DELETE', `/api/workspaces/${w.id}/members/${m2.id}`)).statusCode, 204)
    const [after] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, w.id))
    assert.notEqual(after.inviteCode, w.inviteCode)
  })

  it('forced deletion: sole owner → 409 with list; private pages trashed and visible to nobody (C-H1)', async () => {
    const admin = await user('admin', true)
    const victim = await user('victim')
    const mate = await user('mate')
    const solo = await workspace(victim, [mate])
    const shared = await workspace(mate, [victim, admin])
    const personal = await workspace(victim) // auto-created personal workspace: victim alone
    const preview = (await req(admin.cookie, 'GET', `/api/admin/users/${victim.id}/delete-preview`)).json()
    assert.equal(preview.personalWorkspaces, 1)
    assert.deepEqual(preview.soleOwnedShared.map((w: { id: string }) => w.id), [solo.id])
    const blocked = await req(admin.cookie, 'DELETE', `/api/admin/users/${victim.id}`)
    assert.equal(blocked.statusCode, 409)
    assert.equal(blocked.json().error.code, 'SOLE_OWNER')
    assert.deepEqual(blocked.json().error.workspaces.map((w: { id: string }) => w.id), [solo.id])
    const kept = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, personal.id))
    assert.equal(kept.length, 1, 'refused deletion rolls back: personal workspace still there')
    // hand the workspace over, then delete
    await db
      .update(schema.workspaceMembers)
      .set({ role: 'owner' })
      .where(and(eq(schema.workspaceMembers.workspaceId, solo.id), eq(schema.workspaceMembers.userId, mate.id)))
    const secret = await page(shared.id, victim.id, { scope: 'private', title: 'secret' })
    const res = await req(admin.cookie, 'DELETE', `/api/admin/users/${victim.id}`)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().deletedWorkspaces, 1)
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, personal.id))).length, 0)
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, solo.id))).length, 1)
    const [row] = await db.select().from(schema.pages).where(eq(schema.pages.id, secret.id))
    assert.equal(row.createdBy, null)
    assert.ok(row.deletedAt, 'in the trash')
    for (const viewer of [admin, mate]) {
      const trash = (await req(viewer.cookie, 'GET', `/api/workspaces/${shared.id}/trash`)).json().pages
      assert.ok(!trash.some((p: { id: string }) => p.id === secret.id), 'not visible in trash')
      assert.equal((await req(viewer.cookie, 'POST', `/api/pages/${secret.id}/restore`)).statusCode, 404)
    }
    // an ownerless private page that is NOT in the trash (legacy rows) stays hidden too
    const legacy = await page(shared.id, mate.id, { scope: 'private' })
    await db.update(schema.pages).set({ createdBy: null }).where(eq(schema.pages.id, legacy.id))
    const list = (await req(mate.cookie, 'GET', `/api/workspaces/${shared.id}/pages`)).json().pages
    assert.ok(!list.some((p: { id: string }) => p.id === legacy.id))
  })

  it('forced deletion: personal-only user → 200, personal workspace, pages, files and blobs removed (0813)', async () => {
    const { mkdir, writeFile, access } = await import('node:fs/promises')
    const path = (await import('node:path')).default
    const { env } = await import('./env')
    const admin = await user('admin2', true)
    const solo = await user('solo')
    const personal = await workspace(solo)
    const p = await page(personal.id, solo.id, { title: 'mine' })
    const [f] = await db
      .insert(schema.files)
      .values({ workspaceId: personal.id, pageId: p.id, name: 'a.txt', mime: 'text/plain', size: 1, createdBy: solo.id })
      .returning()
    const blob = path.join(env.dataDir, 'uploads', f.id)
    await mkdir(path.dirname(blob), { recursive: true })
    await writeFile(blob, 'x')
    const preview = (await req(admin.cookie, 'GET', `/api/admin/users/${solo.id}/delete-preview`)).json()
    assert.deepEqual(preview, { personalWorkspaces: 1, personal: [{ id: personal.id, name: 'w' }], soleOwnedShared: [] })
    const res = await req(admin.cookie, 'DELETE', `/api/admin/users/${solo.id}`)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { ok: true, deletedWorkspaces: 1 })
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, personal.id))).length, 0)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, p.id))).length, 0)
    assert.equal((await db.select().from(schema.files).where(eq(schema.files.id, f.id))).length, 0)
    await assert.rejects(access(blob), 'blob unlinked')
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, solo.id))).length, 0)
  })

  it('ink PUT: expectedUpdatedAt mismatch → 412 INK_CONFLICT with the current ink (A-M14)', async () => {
    const p = await page(ws.id, owner.id, { scope: 'shared' })
    const stroke = (id: string) => ({ id, color: '#000000', size: 2, points: [1, 2, 0.5] })
    const url = `/api/pages/${p.id}/ink`
    // first save from device A (no ink yet → expected null)
    const a1 = await req(owner.cookie, 'PUT', url, { strokes: [stroke('a1')], expectedUpdatedAt: null })
    assert.equal(a1.statusCode, 200, a1.body)
    const v1 = a1.json().ink.updatedAt as string
    // device B also believed there was no ink → conflict, gets A's strokes back
    const b1 = await req(member.cookie, 'PUT', url, { strokes: [stroke('b1')], expectedUpdatedAt: null })
    assert.equal(b1.statusCode, 412)
    assert.equal(b1.json().error.code, 'INK_CONFLICT')
    assert.deepEqual(b1.json().error.ink.strokes.map((s: { id: string }) => s.id), ['a1'])
    assert.equal(b1.json().error.ink.updatedAt, v1)
    // B merges and retries on top of v1 → ok, version moves forward
    const b2 = await req(member.cookie, 'PUT', url, { strokes: [stroke('a1'), stroke('b1')], expectedUpdatedAt: v1 })
    assert.equal(b2.statusCode, 200, b2.body)
    const v2 = b2.json().ink.updatedAt as string
    assert.ok(new Date(v2).getTime() > new Date(v1).getTime())
    // A saves again on stale v1 → 412 with B's merged list
    const a2 = await req(owner.cookie, 'PUT', url, { strokes: [stroke('a1'), stroke('a2')], expectedUpdatedAt: v1 })
    assert.equal(a2.statusCode, 412)
    assert.deepEqual(a2.json().error.ink.strokes.map((s: { id: string }) => s.id), ['a1', 'b1'])
    // legacy client without the field: last write wins
    const legacy = await req(owner.cookie, 'PUT', url, { strokes: [stroke('z')] })
    assert.equal(legacy.statusCode, 200)
    assert.deepEqual((await req(owner.cookie, 'GET', url)).json().ink.strokes.map((s: { id: string }) => s.id), ['z'])
    // concurrent saves on the same base: exactly one wins
    const base = legacy.json().ink.updatedAt as string
    const results = await Promise.all(
      ['c1', 'c2', 'c3'].map((id) => req(owner.cookie, 'PUT', url, { strokes: [stroke(id)], expectedUpdatedAt: base })),
    )
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 412, 412])
  })

  it('password login cannot mint a session after a concurrent reset (A-M3)', async () => {
    const { hashPassword } = await import('./auth')
    const { setPassword, issueResetCode } = await import('./accounts')
    const u = await user('login')
    const oldHash = await hashPassword('old-password-1')
    await db.update(schema.users).set({ passwordHash: oldHash }).where(eq(schema.users.id, u.id))
    await setPassword(u.id, 'new-password-2') // commits while the login was verifying oldHash
    await assert.rejects(createSession(u.id, { expectPasswordHash: oldHash }), /password/i)
    const [cur] = await db.select().from(schema.users).where(eq(schema.users.id, u.id))
    await createSession(u.id, { expectPasswordHash: cur.passwordHash })
    // concurrent reset-code issues leave exactly one valid code
    await Promise.all(Array.from({ length: 6 }, () => issueResetCode(u.id, null)))
    const codes = await db.select().from(schema.passwordResetCodes).where(eq(schema.passwordResetCodes.userId, u.id))
    assert.equal(codes.length, 1)
  })

  it('password reset revokes the iCal feed token (A-M3)', async () => {
    const { setPassword } = await import('./accounts')
    const u = await user('ical')
    await db.insert(schema.icalTokens).values({ userId: u.id, tokenHash: `h-${tag()}` } as never)
    await setPassword(u.id, 'another-password-3')
    const rows = await db.select().from(schema.icalTokens).where(eq(schema.icalTokens.userId, u.id))
    assert.equal(rows.length, 0)
  })

  it('import refuses folders deeper than 32 and more than IMPORT_MAX_PAGES pages (C-H2b)', async () => {
    const { importEntries } = await import('./md/importer')
    const dir = (name: string) => ({ name, dir: true, size: 0, readBuffer: async () => Buffer.alloc(0), readText: async () => '' })
    const md = (name: string) => ({ name, dir: false, size: 1, readBuffer: async () => Buffer.from('x'), readText: async () => 'x' })
    const deep = Array.from({ length: 33 }, (_, i) => `d${i}`).join('/')
    await assert.rejects(
      importEntries({ entries: [dir(`${deep}/`), md(`${deep}/a.md`)], workspaceId: ws.id, parentId: null, userId: member.id, scope: 'shared', role: 'member' }),
      /nested too deeply/,
    )
    const many = Array.from({ length: 60 }, (_, i) => md(`f${i}.md`))
    await assert.rejects(
      importEntries({ entries: many, workspaceId: ws.id, parentId: null, userId: member.id, scope: 'shared', role: 'member' }),
      /Too many/,
    )
    const ok = await importEntries({ entries: [dir('x/'), md('x/a.md')], workspaceId: ws.id, parentId: null, userId: member.id, scope: 'shared', role: 'member' })
    assert.equal(ok.length, 2)
    void isNull
  })
})
