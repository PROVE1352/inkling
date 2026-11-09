// Connection range and personal API tokens (docs/adr/1200-*, 1201-*, 1202-*): a token limited to a
// subtree or to some workspaces must not see anything outside it on any path (lists, search,
// find_context, read_pages, backlinks, graph, query, changes, activity, inbox, notifications, MCP
// tools), must not create or move pages outside it, and API tokens follow the session-only, 2FA,
// read-only and revocation rules.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.AUTH_GUARD_MAX_FAILURES ||= '1000'
process.env.AUTH_GUARD_ACCOUNT_FAILURES ||= '1000'

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('[db] connection range and API tokens', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('./errors')
  const collab = await import('./collab')
  const changeLog = await import('./context/changeLog')
  const { setPassword } = await import('./accounts')
  const { _resetAgentTouches } = await import('./agentAccess')

  // Every /api route module the tokens can reach, plus the OAuth root routes (token exchange).
  // Every registered route, to check that the bearer route tables name real routes.
  const registered: { method: string; url: string }[] = []
  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) registered.push({ method: String(m), url: r.url })
    })
    await app.register(import('@fastify/cookie'))
    await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) {
        return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      }
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: String(err.issues[0]?.message) } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
      console.error(err)
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        const r = (m: Promise<Record<string, unknown>>, fn: string) => m.then((x) => (x[fn] as (a: FastifyInstance) => Promise<void>)(api))
        await r(import('./routes/auth'), 'registerAuthRoutes')
        await r(import('./routes/admin'), 'registerAdminRoutes')
        await r(import('./routes/workspaces'), 'registerWorkspaceRoutes')
        await r(import('./routes/graph'), 'registerGraphRoutes')
        await r(import('./routes/workspaceAdmin'), 'registerWorkspaceAdminRoutes')
        await r(import('./routes/pages'), 'registerPageRoutes')
        await r(import('./routes/pageContent'), 'registerPageContentRoutes')
        await r(import('./routes/editLock'), 'registerEditLockRoutes')
        await r(import('./routes/context'), 'registerContextRoutes')
        await r(import('./routes/changes'), 'registerChangeRoutes')
        await r(import('./routes/catchUp'), 'registerCatchUpRoutes')
        await r(import('./routes/tasks'), 'registerTaskRoutes')
        await r(import('./routes/templates'), 'registerTemplateRoutes')
        await r(import('./routes/collections'), 'registerCollectionRoutes')
        await r(import('./routes/exportImport'), 'registerExportImportRoutes')
        await r(import('./routes/comments'), 'registerCommentRoutes')
        await r(import('./routes/notifications'), 'registerNotificationRoutes')
        await r(import('./routes/activity'), 'registerActivityRoutes')
        await r(import('./routes/inbox'), 'registerInboxRoutes')
        await r(import('./routes/oauth'), 'registerOAuthApiRoutes')
        await r(import('./routes/apiTokens'), 'registerApiTokenRoutes')
        await r(import('./routes/query'), 'registerQueryRoutes')
        await r(import('./routes/ical'), 'registerIcalApiRoutes')
        await r(import('./routes/webhooks'), 'registerWebhookRoutes')
        await r(import('./routes/bookmarks'), 'registerBookmarkRoutes')
        await r(import('./routes/notion'), 'registerNotionRoutes')
        // experimental (sheets-sync): registered here so the route table check covers it
        await r(import('./routes/sheetSync'), 'registerSheetSyncRoutes')
      },
      { prefix: '/api' },
    )
    await app.register(async (pub) => {
      await (await import('./routes/oauth')).registerOAuthRoutes(pub)
    })
    await app.ready()
    return app
  }

  const app = await buildApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const asCookie = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const asToken = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  async function makePat(u: U, body: Record<string, unknown>): Promise<string> {
    const res = await asCookie(u, 'POST', '/api/tokens', { name: 'test', expiresInDays: 30, access: 'write', ...body })
    assert.equal(res.statusCode, 201, res.body)
    return (res.json() as { secret: string }).secret
  }

  let owner: U
  let ws1: { id: string }
  let ws2: { id: string }
  const id: Record<string, string> = {}
  // Unique words so every hit can be traced to one page.
  const W = `zq${randomBytes(4).toString('hex')}`

  before(async () => {
    owner = await h.makeUser('owner')
    ws1 = await h.makeWorkspace(owner)
    ws2 = await h.makeWorkspace(owner)
    const setup = await h.connectMcp(app, owner, await h.mintToken(owner))
    const create = async (key: string, workspaceId: string, title: string, markdown: string, parentId?: string) => {
      const r = await setup.tool('create_page', { workspaceId, title, markdown, ...(parentId ? { parentId } : {}) })
      assert.equal(r.isError, false, r.text)
      id[key] = (JSON.parse(r.text) as { id: string }).id
    }
    // ws1:  Outside ── OutsideChild           (out of range)
    //       Root ── Inner ── Deep             (the subtree range)
    await create('outside', ws1.id, `Outside ${W}`, `outside body ${W} alpha`)
    await create('outsideChild', ws1.id, `OutsideChild ${W}`, `secret outside ${W} links to [[Inner ${W}]]`, id.outside)
    await create('root', ws1.id, `Root ${W}`, `root body ${W}`)
    await create('inner', ws1.id, `Inner ${W}`, `inner body ${W} links to [[Outside ${W}]]`, id.root)
    await create('deep', ws1.id, `Deep ${W}`, `deep body ${W}`, id.inner)
    await create('other', ws2.id, `Other ${W}`, `other workspace ${W}`)
    await setup.close()
    await changeLog.drainChangeLog()
  })

  const outsideIds = () => [id.outside, id.outsideChild, id.other]
  const assertNoOutside = (body: string, what: string) => {
    for (const k of ['outside', 'outsideChild', 'other']) {
      assert.ok(!body.includes(id[k]), `${what}: leaks the id of ${k}`)
    }
    // `Outside ${W}` itself appears in Inner's own body as the text of its [[link]] (stored page
    // content, shown as written, like links to any invisible page), so it is checked separately.
    assert.ok(!body.includes(`OutsideChild ${W}`) && !body.includes(`Other ${W}`), `${what}: leaks a title`)
    assert.ok(!body.includes('secret outside') && !body.includes('other workspace') && !body.includes('outside body'), `${what}: leaks body text`)
  }

  describe('subtree range (API token)', () => {
    let pat: string
    before(async () => {
      pat = await makePat(owner, { range: { kind: 'subtree', pageId: id.root } })
    })

    it('GET /workspaces lists only the root workspace', async () => {
      const res = await asToken(pat, 'GET', '/api/workspaces')
      assert.equal(res.statusCode, 200)
      const ids = (res.json() as { workspaces: { id: string; inviteCode: string }[] }).workspaces.map((w) => w.id)
      assert.deepEqual(ids, [ws1.id])
      assert.ok((res.json() as { workspaces: { inviteCode: string }[] }).workspaces.every((w) => w.inviteCode === ''), 'no invite codes for tokens')
    })

    it('another workspace answers 403 OUT_OF_RANGE', async () => {
      const res = await asToken(pat, 'GET', `/api/workspaces/${ws2.id}/pages`)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().error.code, 'OUT_OF_RANGE')
    })

    it('page list: only the subtree', async () => {
      const res = await asToken(pat, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.equal(res.statusCode, 200)
      const got = (res.json() as { pages: { id: string }[] }).pages.map((p) => p.id).sort()
      assert.deepEqual(got, [id.root, id.inner, id.deep].sort())
    })

    it('search', async () => {
      const res = await asToken(pat, 'GET', `/api/workspaces/${ws1.id}/search?q=${W}`)
      assert.equal(res.statusCode, 200)
      assertNoOutside(res.body, 'search')
      assert.ok(res.body.includes(id.inner))
    })

    it('find_context (GET /context), all workspaces and one', async () => {
      for (const url of [`/api/context?q=${W}`, `/api/context?q=${W}&workspaceId=${ws1.id}`]) {
        const res = await asToken(pat, 'GET', url)
        assert.equal(res.statusCode, 200, res.body)
        assertNoOutside(res.body, url)
        assert.ok(res.body.includes(id.inner), `${url} finds the inner page`)
      }
    })

    it('read_pages and single-page routes', async () => {
      const res = await asToken(pat, 'GET', `/api/pages/read?ids=${id.inner},${id.outsideChild},${id.other}`)
      assert.equal(res.statusCode, 200)
      const rp = res.json() as { pages: { id: string }[]; missing: string[] }
      assert.deepEqual(rp.pages.map((p) => p.id), [id.inner])
      // the requested ids come back as "missing", exactly like pages that do not exist
      assert.deepEqual([...rp.missing].sort(), [id.outsideChild, id.other].sort())
      assertNoOutside(JSON.stringify(rp.pages), 'read_pages')
      for (const url of [`/api/pages/${id.outsideChild}/export?format=md`, `/api/pages/${id.outside}/outline`, `/api/pages/${id.outside}/comments`]) {
        const r = await asToken(pat, 'GET', url)
        assert.ok([403, 404].includes(r.statusCode), `${url}: ${r.statusCode}`)
        assertNoOutside(r.body, url)
      }
    })

    it('a link to an out-of-range page shows its stored text, never the current title', async () => {
      await asCookie(owner, 'PATCH', `/api/pages/${id.outside}`, { title: `Renamed outside ${W}` })
      const res = await asToken(pat, 'GET', `/api/pages/read?ids=${id.inner}`)
      assert.ok(res.body.includes(`Outside ${W}`), 'the link text as written in Inner')
      assert.ok(!res.body.includes(`Renamed outside ${W}`), 'the target is not looked up')
      assert.ok(!res.body.includes(id.outside), 'no target id')
      const ex = await asToken(pat, 'GET', `/api/pages/${id.inner}/export?format=md`)
      assert.ok(!ex.body.includes(`Renamed outside ${W}`) && !ex.body.includes(id.outside))
      await asCookie(owner, 'PATCH', `/api/pages/${id.outside}`, { title: `Outside ${W}` })
    })

    it('backlinks, graph, tags, trash', async () => {
      const bl = await asToken(pat, 'GET', `/api/pages/${id.inner}/backlinks`)
      assert.equal(bl.statusCode, 200)
      assertNoOutside(bl.body, 'backlinks (OutsideChild links to Inner)')
      for (const url of [`/api/workspaces/${ws1.id}/graph`, `/api/workspaces/${ws1.id}/tags`, `/api/workspaces/${ws1.id}/trash`]) {
        const r = await asToken(pat, 'GET', url)
        assert.equal(r.statusCode, 200, `${url} ${r.body}`)
        assertNoOutside(r.body, url)
      }
    })

    it('query block: rows, FROM [[title]] oracle, and the result cache', async () => {
      // The browser runs the same queries first, so a cache keyed without the range would answer.
      for (const source of ['LIST', `LIST FROM [[Outside ${W}]]`]) {
        const c = await asCookie(owner, 'POST', `/api/workspaces/${ws1.id}/query`, { source })
        assert.equal(c.statusCode, 200, c.body)
        const res = await asToken(pat, 'POST', `/api/workspaces/${ws1.id}/query`, { source })
        assert.equal(res.statusCode, 200, res.body)
        assertNoOutside(res.body, `query ${source}`)
        if (source.startsWith('LIST FROM')) assert.ok(!res.body.includes(id.inner), 'FROM [[out-of-range title]] must not match')
      }
    })

    it('changes_since and activity', async () => {
      const start = await asToken(pat, 'GET', '/api/changes')
      assert.equal(start.statusCode, 200, start.body)
      const cursor = (start.json() as { cursor: string }).cursor
      for (const k of ['outsideChild', 'inner']) {
        const r = await asCookie(owner, 'PATCH', `/api/pages/${id[k]}`, { title: `${k === 'inner' ? 'Inner' : 'OutsideChild'} ${W} v2` })
        assert.equal(r.statusCode, 200, r.body)
      }
      await changeLog.drainChangeLog()
      const res = await asToken(pat, 'GET', `/api/changes?cursor=${encodeURIComponent(cursor)}`)
      assert.equal(res.statusCode, 200)
      assertNoOutside(res.body, 'changes_since')
      assert.ok(!res.body.includes('OutsideChild'), 'changes_since leaks the renamed title')
      assert.ok(res.body.includes(id.inner))
      const act = await asToken(pat, 'GET', `/api/workspaces/${ws1.id}/activity`)
      assert.equal(act.statusCode, 200)
      assertNoOutside(act.body, 'activity')
      // rename back
      await asCookie(owner, 'PATCH', `/api/pages/${id.outsideChild}`, { title: `OutsideChild ${W}` })
      await asCookie(owner, 'PATCH', `/api/pages/${id.inner}`, { title: `Inner ${W}` })
    })

    it('inbox and notifications (and marking them read)', async () => {
      await db.insert(schema.notifications).values([
        { userId: owner.id, type: 'doc_mention', pageId: id.outsideChild, workspaceId: ws1.id, excerpt: 'secret outside mention' },
        { userId: owner.id, type: 'doc_mention', pageId: id.inner, workspaceId: ws1.id, excerpt: 'inner mention' },
        { userId: owner.id, type: 'doc_mention', pageId: id.other, workspaceId: ws2.id, excerpt: 'other workspace mention' },
      ] as never)
      const inbox = await asToken(pat, 'GET', '/api/inbox')
      assert.equal(inbox.statusCode, 200, inbox.body)
      assertNoOutside(inbox.body, 'inbox')
      assert.ok(inbox.body.includes(id.inner))
      const n = await asToken(pat, 'GET', '/api/notifications')
      assert.equal(n.statusCode, 200)
      assertNoOutside(n.body, 'notifications')
      assert.ok(n.body.includes(id.inner))
      const mark = await asToken(pat, 'POST', '/api/notifications/read', {})
      assert.equal(mark.statusCode, 200)
      const [still] = (await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${owner.id} AND read = '0' AND page_id = ANY(${`{${outsideIds().join(',')}}`}::uuid[])`)) as unknown as { n: number }[]
      assert.equal(still.n, 2, 'out-of-range notifications stay unread')
      const ack = await asToken(pat, 'POST', '/api/inbox/ack', { cursor: '999999999999' })
      assert.equal(ack.statusCode, 200)
      const [unacked] = (await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${owner.id} AND acked_at IS NULL AND page_id = ANY(${`{${outsideIds().join(',')}}`}::uuid[])`)) as unknown as { n: number }[]
      assert.equal(unacked.n, 2, 'out-of-range inbox items stay unacknowledged')
    })

    it('creating: under the subtree yes; top level, outside parents, duplicating the root no', async () => {
      const ok = await asToken(pat, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.inner, title: 'made by token' })
      assert.equal(ok.statusCode, 200, ok.body)
      const top = await asToken(pat, 'POST', '/api/pages', { workspaceId: ws1.id, title: 'top' })
      assert.equal(top.statusCode, 403)
      assert.equal(top.json().error.code, 'OUT_OF_RANGE')
      const under = await asToken(pat, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.outside, title: 'x' })
      assert.ok([400, 403, 404].includes(under.statusCode), `under outside parent: ${under.statusCode}`)
      const dup = await asToken(pat, 'POST', `/api/pages/${id.root}/duplicate`)
      assert.equal(dup.statusCode, 403, dup.body)
      // the quick task goes into a top-level "Tasks" document: refused, nothing created
      const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(eq(schema.pages.workspaceId, ws1.id))
      const tasks = await asToken(pat, 'POST', `/api/workspaces/${ws1.id}/tasks`, { title: 'buy milk', date: '2026-11-07' })
      assert.equal(tasks.statusCode, 403, tasks.body)
      const afterCount = await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(eq(schema.pages.workspaceId, ws1.id))
      assert.equal(afterCount[0].n, before[0].n)
    })

    it('moving: not out of the subtree, not into it from outside', async () => {
      const toTop = await asToken(pat, 'PATCH', `/api/pages/${id.deep}`, { parentId: null })
      assert.equal(toTop.statusCode, 403)
      assert.equal(toTop.json().error.code, 'OUT_OF_RANGE')
      const out = await asToken(pat, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.outside })
      assert.ok([400, 403, 404].includes(out.statusCode), `move out: ${out.statusCode}`)
      const rootOut = await asToken(pat, 'PATCH', `/api/pages/${id.root}`, { parentId: id.outside })
      assert.ok([400, 403, 404].includes(rootOut.statusCode), `move root: ${rootOut.statusCode}`)
      const into = await asToken(pat, 'PATCH', `/api/pages/${id.outsideChild}`, { parentId: id.inner })
      assert.equal(into.statusCode, 404)
      const [d] = await db.select({ parentId: schema.pages.parentId }).from(schema.pages).where(eq(schema.pages.id, id.deep))
      assert.equal(d.parentId, id.inner)
      // inside the subtree is fine
      const inside = await asToken(pat, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.root })
      assert.equal(inside.statusCode, 200, inside.body)
      await asToken(pat, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.inner })
    })

    it('a page moved out by someone else leaves the range at once', async () => {
      const moved = await asCookie(owner, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.outside })
      assert.equal(moved.statusCode, 200, moved.body)
      const found = async () => ((await asToken(pat, 'GET', `/api/pages/read?ids=${id.deep}`)).json() as { pages: unknown[] }).pages.length
      assert.equal(await found(), 0)
      await asCookie(owner, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.inner })
      assert.equal(await found(), 1)
    })

    it('database rows and row templates follow the collection\'s place in the range', async () => {
      const mkColl = async (parentId: string) => {
        const r = await asCookie(owner, 'POST', '/api/pages', { workspaceId: ws1.id, parentId, kind: 'collection', title: 'DB' })
        assert.equal(r.statusCode, 200, r.body)
        return (r.json() as { id?: string; page?: { id: string } }).id ?? (r.json() as { page: { id: string } }).page.id
      }
      const inside = await mkColl(id.inner)
      const outside = await mkColl(id.outside)
      const okRow = await asToken(pat, 'POST', `/api/pages/${inside}/collection/rows`, {})
      assert.ok(okRow.statusCode < 300, `row inside: ${okRow.statusCode} ${okRow.body}`)
      for (const [m, url] of [
        ['POST', `/api/pages/${outside}/collection/rows`],
        ['GET', `/api/pages/${outside}/collection/row-templates`],
        ['POST', `/api/pages/${outside}/collection/row-templates`],
      ] as const) {
        const r = await asToken(pat, m, url, m === 'POST' ? {} : undefined)
        assert.equal(r.statusCode, 404, `${m} ${url}: ${r.statusCode} ${r.body}`)
        assertNoOutside(r.body, url)
      }
      // a template of an out-of-range collection is not found by id either
      const made = await asCookie(owner, 'POST', `/api/pages/${outside}/collection/row-templates`, { name: 'T' })
      if (made.statusCode < 300) {
        const tid = (made.json() as { template?: { id: string }; id?: string }).template?.id ?? (made.json() as { id: string }).id
        for (const m of ['GET', 'PATCH', 'DELETE'] as const) {
          const r = await asToken(pat, m, `/api/collection-row-templates/${tid}`, m === 'PATCH' ? { name: 'x' } : undefined)
          assert.equal(r.statusCode, 404, `${m} template: ${r.statusCode}`)
        }
      }
      // read-only tokens: every write route is refused by method, new routes included
      const ro = await makePat(owner, { access: 'read', range: { kind: 'all' } })
      for (const [m, url] of [
        ['POST', `/api/pages/${inside}/collection/rows`],
        ['POST', `/api/pages/${inside}/collection/row-templates`],
        ['PATCH', '/api/collection-row-templates/00000000-0000-4000-8000-000000000000'],
        ['DELETE', '/api/collection-row-templates/00000000-0000-4000-8000-000000000000'],
      ] as const) {
        const r = await asToken(ro, m, url, m === 'DELETE' ? undefined : {})
        assert.equal(r.statusCode, 403, `read-only ${m} ${url}`)
      }
    })

    it('workspace-wide routes: templates and member candidates refused', async () => {
      for (const [m, url] of [
        ['GET', `/api/workspaces/${ws1.id}/templates`],
        ['GET', `/api/workspaces/${ws1.id}/member-candidates?q=a`],
        ['POST', '/api/workspaces'],
      ] as const) {
        const r = await asToken(pat, m, url, m === 'POST' ? { name: 'x' } : undefined)
        assert.equal(r.statusCode, 403, `${m} ${url}`)
        assert.equal(r.json().error.code, 'OUT_OF_RANGE', url)
      }
    })

    it('a lock above the root does not reveal its title', async () => {
      // A locked folder above a second range root
      const s = await h.connectMcp(app, owner, await h.mintToken(owner))
      const lockedTitle = `LockedAbove ${W}`
      const f = JSON.parse((await s.tool('create_page', { workspaceId: ws1.id, title: lockedTitle, markdown: 'x' })).text).id as string
      const g = JSON.parse((await s.tool('create_page', { workspaceId: ws1.id, title: 'Under lock', markdown: 'y', parentId: f })).text).id as string
      await s.close()
      await db.update(schema.pages).set({ editLocked: true }).where(eq(schema.pages.id, f))
      const { bumpAcl } = await import('./aclVersion')
      await db.transaction(async (tx) => bumpAcl(tx, ws1.id))
      const pat2 = await makePat(owner, { range: { kind: 'subtree', pageId: g } })
      const res = await asToken(pat2, 'GET', `/api/pages/${g}/lock`)
      assert.equal(res.statusCode, 200, res.body)
      assert.ok(!res.body.includes(lockedTitle), 'lock root title hidden')
      const full = await asCookie(owner, 'GET', `/api/pages/${g}/lock`)
      assert.ok(full.body.includes(lockedTitle), 'the browser still sees it')
    })
  })

  describe('workspace range (API token)', () => {
    it('only the chosen workspaces, everywhere', async () => {
      const pat = await makePat(owner, { range: { kind: 'workspaces', workspaceIds: [ws2.id] } })
      const list = await asToken(pat, 'GET', '/api/workspaces')
      assert.deepEqual((list.json() as { workspaces: { id: string }[] }).workspaces.map((w) => w.id), [ws2.id])
      const ws1Pages = await asToken(pat, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.equal(ws1Pages.statusCode, 403)
      assert.equal(ws1Pages.json().error.code, 'OUT_OF_RANGE')
      const read = await asToken(pat, 'GET', `/api/pages/read?ids=${id.inner},${id.other}`)
      assert.deepEqual((read.json() as { pages: { id: string }[] }).pages.map((p) => p.id), [id.other])
      const ctx = await asToken(pat, 'GET', `/api/context?q=${W}`)
      assert.equal(ctx.statusCode, 200)
      assert.ok(ctx.body.includes(id.other) && !ctx.body.includes(id.inner) && !ctx.body.includes(id.outside))
      const n = await asToken(pat, 'GET', '/api/notifications')
      assert.ok(!n.body.includes(id.inner) && !n.body.includes(id.outsideChild))
      const top = await asToken(pat, 'POST', '/api/pages', { workspaceId: ws2.id, title: 'top-level in range' })
      assert.equal(top.statusCode, 200, 'a workspace range may create at the top level')
    })
  })

  describe('OAuth grant with a range (MCP tools)', () => {
    it('subtree grant: tools see only the subtree, and are told so', async () => {
      const token = await h.mintToken(owner)
      await db
        .update(schema.oauthGrants)
        .set({ rangeKind: 'subtree', rangePageId: id.root })
        .where(eq(schema.oauthGrants.accessHash, sha(token)))
      const { getBearerUser } = await import('./oauth')
      const user = (await getBearerUser(token))!
      assert.equal(user.range?.kind, 'subtree')
      const mcp = await h.connectMcp(app, user, token)
      try {
        const lw = await mcp.tool('list_workspaces')
        assert.ok(lw.text.includes(ws1.id) && !lw.text.includes(ws2.id), lw.text)
        for (const [tool, args] of [
          ['search', { query: W }],
          ['find_context', { query: W }],
          ['list_pages', { workspaceId: ws1.id }],
          ['read_pages', { ids: [id.inner, id.outsideChild] }],
          ['changes_since', {}],
          ['inbox', {}],
          ['catch_up', { since: '2000-01-01', peek: true }],
        ] as const) {
          const r = await mcp.tool(tool, args as Record<string, unknown>)
          assertNoOutside(r.text, `MCP ${tool}`)
        }
        const rp = await mcp.tool('read_page', { pageId: id.outsideChild })
        assert.equal(rp.isError, true)
        assertNoOutside(rp.text, 'read_page outside')
        const inner = await mcp.tool('read_page', { pageId: id.inner })
        assert.equal(inner.isError, false, inner.text)
        const top = await mcp.tool('create_page', { workspaceId: ws1.id, title: 'top', markdown: 'x' })
        assert.equal(top.isError, true)
        assert.match(top.text, /OUT_OF_RANGE/)
        const other = await mcp.tool('list_pages', { workspaceId: ws2.id })
        assert.equal(other.isError, true)
        const instr = await mcp.client.getInstructions()
        assert.match(String(instr), /only sees one page and the pages under it/)
      } finally {
        await mcp.close()
      }
    })

    it('consent stores the range on the code, the exchange copies it to the grant, PATCH changes it', async () => {
      const clientId = `test-range-${randomBytes(4).toString('hex')}`
      await db.insert(schema.oauthClients).values({ id: clientId, name: 'Range Client', redirectUris: ['https://example.com/cb'] })
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const auth = await asCookie(owner, 'POST', '/api/oauth/authorize', {
        client_id: clientId,
        redirect_uri: 'https://example.com/cb',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'allow',
        access: 'read',
        range: { kind: 'workspaces', workspaceIds: [ws2.id] },
      })
      assert.equal(auth.statusCode, 200, auth.body)
      const code = new URL((auth.json() as { redirectTo: string }).redirectTo).searchParams.get('code')!
      const tok = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://example.com/cb', client_id: clientId }).toString(),
      })
      assert.equal(tok.statusCode, 200, tok.body)
      const [g] = await db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.clientId, clientId))
      assert.equal(g.rangeKind, 'workspaces')
      assert.deepEqual(g.rangeWorkspaceIds, [ws2.id])
      // someone else's workspace cannot be chosen
      const stranger = await h.makeUser('stranger')
      const theirs = await h.makeWorkspace(stranger)
      const bad = await asCookie(owner, 'PATCH', `/api/oauth/grants/${g.id}`, { range: { kind: 'workspaces', workspaceIds: [theirs.id] } })
      assert.equal(bad.statusCode, 400)
      assert.equal(bad.json().error.code, 'INVALID_RANGE')
      const ok = await asCookie(owner, 'PATCH', `/api/oauth/grants/${g.id}`, { range: { kind: 'subtree', pageId: id.root } })
      assert.equal(ok.statusCode, 200, ok.body)
      const list = await asCookie(owner, 'GET', '/api/oauth/grants')
      const mine = (list.json() as { grants: { id: string; range: { kind: string; page?: { title: string } } }[] }).grants.find((x) => x.id === g.id)!
      assert.equal(mine.range.kind, 'subtree')
      assert.equal(mine.range.page?.title, `Root ${W}`)
      // a token cannot change a range
      const viaToken = await asToken(await makePat(owner, { range: { kind: 'all' } }), 'PATCH', `/api/oauth/grants/${g.id}`, { range: { kind: 'all' } })
      assert.equal(viaToken.statusCode, 403)
    })

    it('a grant whose subtree root is gone sees nothing (never everything)', async () => {
      const token = await h.mintToken(owner)
      await db
        .update(schema.oauthGrants)
        .set({ rangeKind: 'subtree', rangePageId: '00000000-0000-4000-8000-000000000000' })
        .where(eq(schema.oauthGrants.accessHash, sha(token)))
      const res = await app.inject({
        method: 'GET',
        url: '/api/workspaces',
        headers: { authorization: `Bearer ${token}`, [(await import('./oauth')).MCP_INTERNAL_HEADER]: (await import('./oauth')).MCP_INTERNAL_SECRET },
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual((res.json() as { workspaces: unknown[] }).workspaces, [])
    })
  })

  describe('API tokens', () => {
    it('made once, stored as a hash, listed without the secret', async () => {
      const res = await asCookie(owner, 'POST', '/api/tokens', { name: 'ci', expiresInDays: 90, access: 'read', range: { kind: 'all' } })
      assert.equal(res.statusCode, 201)
      const { secret, token } = res.json() as { secret: string; token: { id: string; prefix: string; expiresAt: string } }
      assert.match(secret, /^ink_pat_[A-Za-z0-9_-]{43}$/)
      assert.equal(token.prefix, secret.slice(0, 12))
      const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, token.id))
      assert.equal(row.tokenHash, sha(secret))
      const list = await asCookie(owner, 'GET', '/api/tokens')
      assert.ok(!list.body.includes(secret))
      assert.ok(!list.body.includes(row.tokenHash))
      const me = await asToken(secret, 'GET', '/api/auth/me')
      assert.equal(me.statusCode, 200)
      const [used] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, token.id))
      assert.ok(used.lastUsedAt, 'last use recorded')
      assert.ok(used.lastUsedIp, 'last IP recorded')
    })

    it('read-only tokens cannot write; bearer-read-only routes still work', async () => {
      const pat = await makePat(owner, { access: 'read', range: { kind: 'all' } })
      const w = await asToken(pat, 'POST', '/api/pages', { workspaceId: ws1.id, title: 'nope' })
      assert.equal(w.statusCode, 403)
      assert.match(w.json().error.message, /read-only/)
      const q = await asToken(pat, 'POST', `/api/workspaces/${ws1.id}/query`, { source: 'LIST' })
      assert.equal(q.statusCode, 200)
    })

    it('every entry of the bearer route tables names a registered route', async () => {
      const { SESSION_ONLY, RANGED_DENY, SUBTREE_DENY } = await import('./tokenPolicy')
      for (const rule of [...SESSION_ONLY, ...RANGED_DENY, ...SUBTREE_DENY]) {
        const hit = registered.some((r) => r.url === rule.url && (rule.method === '*' || r.method === rule.method))
        assert.ok(hit, `${rule.method} ${rule.url} is not a registered route (typo or renamed route?)`)
      }
    })

    it('session-only routes refuse every token', async () => {
      const pat = await makePat(owner, { range: { kind: 'all' } })
      for (const [m, url, body] of [
        ['GET', '/api/tokens', undefined],
        ['POST', '/api/tokens', { name: 'x', expiresInDays: null, access: 'write', range: { kind: 'all' } }],
        ['GET', '/api/oauth/grants', undefined],
        ['POST', '/api/auth/change-password', { currentPassword: 'x', newPassword: 'yyyyyyyyyy' }],
        ['POST', '/api/me/ical', {}],
        ['GET', `/api/workspaces/${ws1.id}/webhooks`, undefined],
        ['POST', `/api/workspaces/${ws1.id}/members`, { userId: owner.id }],
        ['POST', `/api/workspaces/${ws1.id}/invite/regenerate`, {}],
        ['DELETE', `/api/workspaces/${ws2.id}`, undefined],
        ['POST', `/api/pages/${id.root}/share`, {}],
        ['DELETE', `/api/pages/${id.root}/purge`, undefined],
        ['GET', '/api/admin/users', undefined],
        ['PUT', `/api/workspaces/${ws1.id}/settings/two-factor`, { required: true }],
        ['PUT', `/api/pages/${id.root}/lock`, { locked: true }],
      ] as const) {
        const r = await asToken(pat, m, url, body)
        assert.equal(r.statusCode, 403, `${m} ${url}: ${r.statusCode} ${r.body}`)
      }
      // and OAuth access tokens are still refused outside /mcp
      const at = await h.mintToken(owner)
      const r = await asToken(at, 'GET', '/api/workspaces')
      assert.equal(r.statusCode, 401)
    })

    it('expired, revoked and unknown tokens are 401', async () => {
      const pat = await makePat(owner, { range: { kind: 'all' } })
      await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.tokenHash, sha(pat)))
      assert.equal((await asToken(pat, 'GET', '/api/workspaces')).statusCode, 401)
      const pat2 = await makePat(owner, { range: { kind: 'all' } })
      const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, sha(pat2)))
      assert.equal((await asCookie(owner, 'DELETE', `/api/tokens/${row.id}`)).statusCode, 204)
      assert.equal((await asToken(pat2, 'GET', '/api/workspaces')).statusCode, 401)
      assert.equal((await asToken(`ink_pat_${randomBytes(32).toString('base64url')}`, 'GET', '/api/workspaces')).statusCode, 401)
      // a stored hash presented as the token does not match
      assert.equal((await asToken(row.tokenHash, 'GET', '/api/workspaces')).statusCode, 401)
    })

    it('a workspace that requires 2FA refuses the token of an owner without 2FA', async () => {
      const u = await h.makeUser('no2fa')
      const w = await h.makeWorkspace(u)
      const pat = await makePat(u, { range: { kind: 'all' } })
      assert.equal((await asToken(pat, 'GET', `/api/workspaces/${w.id}/pages`)).statusCode, 200)
      await db.execute(sql`UPDATE workspaces SET two_factor_required_at = now() - interval '8 days', two_factor_grace_days = 0 WHERE id = ${w.id}`)
      const res = await asToken(pat, 'GET', `/api/workspaces/${w.id}/pages`)
      assert.equal(res.statusCode, 403)
      assert.equal(res.json().error.code, 'TWO_FACTOR_REQUIRED')
      // an OIDC-created account satisfies it (docs/adr/1162-*)
      await db.update(schema.users).set({ origin: 'oidc' } as never).where(eq(schema.users.id, u.id))
      assert.equal((await asToken(pat, 'GET', `/api/workspaces/${w.id}/pages`)).statusCode, 200)
    })

    it('setting the password revokes every API token (like OAuth grants)', async () => {
      const u = await h.makeUser('pw')
      const pat = await makePat(u, { range: { kind: 'all' } })
      await setPassword(u.id, 'new-password-123456')
      assert.equal((await asToken(pat, 'GET', '/api/workspaces')).statusCode, 401)
    })

    it('instance admin lists and revokes a user\'s tokens; a token cannot', async () => {
      const admin = await h.makeUser('admin')
      await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin.id))
      const u = await h.makeUser('member')
      const pat = await makePat(u, { range: { kind: 'all' } })
      const list = await asCookie(admin, 'GET', `/api/admin/users/${u.id}/api-tokens`)
      assert.equal(list.statusCode, 200)
      assert.equal((list.json() as { tokens: unknown[] }).tokens.length, 1)
      assert.ok(!list.body.includes(pat))
      const viaPat = await asToken(pat, 'DELETE', `/api/admin/users/${u.id}/api-tokens`)
      assert.equal(viaPat.statusCode, 403)
      const del = await asCookie(admin, 'DELETE', `/api/admin/users/${u.id}/api-tokens`)
      assert.equal(del.json().revoked, 1)
      assert.equal((await asToken(pat, 'GET', '/api/workspaces')).statusCode, 401)
    })

    it('a range naming a page the owner cannot see is refused', async () => {
      const stranger = await h.makeUser('stranger2')
      const res = await asCookie(stranger, 'POST', '/api/tokens', { name: 'x', expiresInDays: 30, access: 'read', range: { kind: 'subtree', pageId: id.root } })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error.code, 'INVALID_RANGE')
    })
  })

  // keep the agent touch throttle from leaking between suites
  after(() => _resetAgentTouches())
})
