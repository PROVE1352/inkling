// Guests and people with access to a page tree (docs/adr/1250-*, 1251-*, 1252-*, 1253-*): a guest must
// not see anything of the workspace outside the pages shared with them on any path (workspace list,
// page tree, search, graph, backlinks, members, comments, files, collaboration socket, exports,
// changes, activity, inbox, query, settings, MCP and API tokens), may do only what their level allows,
// and member rows narrow or widen members the same way. Every row change bumps the access version.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.AUTH_GUARD_MAX_FAILURES ||= '1000'
process.env.AUTH_GUARD_ACCOUNT_FAILURES ||= '1000'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

process.env.DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'ink-guests-'))
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })

const HAS_DB = !!process.env.DATABASE_URL

function varUint(n: number): number[] {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return out
}
const varBytes = (b: Uint8Array): number[] => [...varUint(b.length), ...b]
const varString = (s: string) => varBytes(new TextEncoder().encode(s))
function readVarUint(b: Uint8Array, pos: { i: number }): number {
  let n = 0
  let shift = 0
  for (;;) {
    const x = b[pos.i++]
    n |= (x & 0x7f) << shift
    if (x < 0x80) return n >>> 0
    shift += 7
  }
}
function readVarString(b: Uint8Array, pos: { i: number }): string {
  const len = readVarUint(b, pos)
  const s = new TextDecoder().decode(b.subarray(pos.i, pos.i + len))
  pos.i += len
  return s
}

describe('[db] guests and page access', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('./errors')
  const collab = await import('./collab')
  const changeLog = await import('./context/changeLog')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
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
        await r(import('./routes/workspaces'), 'registerWorkspaceRoutes')
        await r(import('./routes/graph'), 'registerGraphRoutes')
        await r(import('./routes/workspaceAdmin'), 'registerWorkspaceAdminRoutes')
        await r(import('./routes/pages'), 'registerPageRoutes')
        await r(import('./routes/pageContent'), 'registerPageContentRoutes')
        await r(import('./routes/editLock'), 'registerEditLockRoutes')
        await r(import('./routes/pageAccess'), 'registerPageAccessRoutes')
        await r(import('./routes/context'), 'registerContextRoutes')
        await r(import('./routes/changes'), 'registerChangeRoutes')
        await r(import('./routes/tasks'), 'registerTaskRoutes')
        await r(import('./routes/templates'), 'registerTemplateRoutes')
        await r(import('./routes/collections'), 'registerCollectionRoutes')
        await r(import('./routes/exportImport'), 'registerExportImportRoutes')
        await r(import('./routes/comments'), 'registerCommentRoutes')
        await r(import('./routes/notifications'), 'registerNotificationRoutes')
        await r(import('./routes/activity'), 'registerActivityRoutes')
        await r(import('./routes/inbox'), 'registerInboxRoutes')
        await r(import('./routes/later'), 'registerLaterRoutes')
        await r(import('./routes/threads'), 'registerThreadRoutes')
        await r(import('./routes/oauth'), 'registerOAuthApiRoutes')
        await r(import('./routes/apiTokens'), 'registerApiTokenRoutes')
        await r(import('./routes/query'), 'registerQueryRoutes')
        await r(import('./routes/webhooks'), 'registerWebhookRoutes')
        await r(import('./routes/bookmarks'), 'registerBookmarkRoutes')
        await r(import('./routes/snapshots'), 'registerSnapshotRoutes')
        await r(import('./routes/largePages'), 'registerLargePageRoutes')
        await r(import('./routes/files'), 'registerFileRoutes')
        await r(import('./routes/splitPage'), 'registerSplitPageRoutes')
        await r(import('./routes/clip'), 'registerClipRoutes')
      },
      { prefix: '/api' },
    )
    await app.register(async (pub) => {
      await (await import('./routes/oauth')).registerOAuthRoutes(pub)
      await (await import('./routes/files')).registerFileDownloadRoute(pub)
    })
    await app.ready()
    return app
  }

  const app = await buildApp()
  let server: ReturnType<typeof createServer>
  let port = 0
  before(async () => {
    server = createServer((_r, s) => s.end())
    collab.attachCollab(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const asToken = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const grant = async (by: U, pageId: string, who: { userId?: string; email?: string }, level: string) => {
    const res = await as(by, 'PUT', `/api/pages/${pageId}/access`, { ...who, level })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }

  /** Connects to the collaboration socket; 'denied' when authentication fails, else the scope and whether an update was applied. */
  async function pushUpdate(u: U, pageId: string, key: string): Promise<{ scope: string; applied: boolean } | 'denied'> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers: { cookie: u.cookie } })
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res())
      ws.once('error', rej)
    })
    const doc = new Y.Doc()
    doc.getMap('guesttest').set(key, 'x')
    const update = Y.encodeStateAsUpdate(doc)
    let scope = ''
    const result = await new Promise<{ scope: string; applied: boolean } | 'denied'>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 5000)
      ws.on('close', () => {
        clearTimeout(timer)
        resolve('denied')
      })
      ws.on('message', (data: Buffer) => {
        const b = new Uint8Array(data)
        const pos = { i: 0 }
        readVarString(b, pos)
        const type = readVarUint(b, pos)
        if (type === 2) {
          const sub = readVarUint(b, pos)
          if (sub === 1) {
            // AuthMessageType.PermissionDenied
            clearTimeout(timer)
            resolve('denied')
          } else if (sub === 2) {
            scope = readVarString(b, pos)
            ws.send(new Uint8Array([...varString(pageId), ...varUint(0), ...varUint(2), ...varBytes(update)]))
          }
        } else if (type === 8) {
          clearTimeout(timer)
          resolve({ scope, applied: readVarUint(b, pos) === 1 })
        }
      })
      ws.send(new Uint8Array([...varString(pageId), ...varUint(2), ...varUint(0), ...varString('')]))
    })
    ws.close()
    return result
  }

  let O: U // owner of ws1
  let M: U // member of ws1
  let G: U // guest in ws1 (owner of its own workspace)
  let X: U // nobody in ws1
  let ws1: { id: string }
  let ws2: { id: string }
  let gHome: { id: string }
  const id: Record<string, string> = {}
  const W = `zg${randomBytes(4).toString('hex')}`

  before(async () => {
    O = await h.makeUser('owner')
    M = await h.makeUser('member')
    G = await h.makeUser('guest')
    X = await h.makeUser('stranger')
    ws1 = await h.makeWorkspace(O, [M])
    ws2 = await h.makeWorkspace(O)
    gHome = await h.makeWorkspace(G)
    const setup = await h.connectMcp(app, O, await h.mintToken(O))
    const create = async (key: string, workspaceId: string, title: string, markdown: string, parentId?: string) => {
      const r = await setup.tool('create_page', { workspaceId, title, markdown, ...(parentId ? { parentId } : {}) })
      assert.equal(r.isError, false, r.text)
      id[key] = (JSON.parse(r.text) as { id: string }).id
    }
    // ws1:  Outside ── OutsideChild (links to Inner)
    //       Root (G: edit) ── Inner ── Deep
    //       ViewRoot (G: view)
    //       CommentRoot (G: comment)
    await create('root', ws1.id, `Root ${W}`, `root body ${W}`)
    await create('inner', ws1.id, `Inner ${W}`, `inner body ${W} links to [[Outside ${W}]]`, id.root)
    await create('deep', ws1.id, `Deep ${W}`, `deep body ${W} links to [[Inner ${W}]]`, id.inner)
    await create('outside', ws1.id, `Outside ${W}`, `outside body ${W} alpha`)
    await create('outsideChild', ws1.id, `OutsideChild ${W}`, `secret outside ${W} links to [[Inner ${W}]]`, id.outside)
    await create('viewRoot', ws1.id, `ViewRoot ${W}`, `view body ${W}`)
    await create('commentRoot', ws1.id, `CommentRoot ${W}`, `comment body ${W}`)
    await create('other', ws2.id, `Other ${W}`, `other workspace ${W}`)
    await setup.close()
    await changeLog.drainChangeLog()
    await collab.flushDocIndexes()
    await grant(O, id.root, { userId: G.id }, 'edit')
    await grant(O, id.viewRoot, { userId: G.id }, 'view')
    await grant(O, id.commentRoot, { userId: G.id }, 'comment')
  })

  const assertNoOutside = (body: string, what: string) => {
    for (const k of ['outside', 'outsideChild', 'other']) {
      assert.ok(!body.includes(id[k]), `${what}: leaks the id of ${k}`)
    }
    // `Outside ${W}` appears in Inner's own body as the text of its [[link]] (stored content, as for ranges).
    assert.ok(!body.includes(`OutsideChild ${W}`) && !body.includes(`Other ${W}`), `${what}: leaks a title`)
    assert.ok(!body.includes('secret outside') && !body.includes('other workspace') && !body.includes('outside body'), `${what}: leaks body text`)
    assert.ok(!body.includes(M.email) && !body.includes(O.email), `${what}: leaks a member's email`)
  }

  describe('what a guest sees', () => {
    it('GET /workspaces lists the guest workspace as role guest, no rights, no invite code', async () => {
      const res = await as(G, 'GET', '/api/workspaces')
      assert.equal(res.statusCode, 200)
      const list = (res.json() as { workspaces: { id: string; role: string; inviteCode: string; can: Record<string, boolean> }[] }).workspaces
      const g = list.find((w) => w.id === ws1.id)
      assert.ok(g, 'guest workspace listed')
      assert.equal(g.role, 'guest')
      assert.equal(g.inviteCode, '')
      assert.ok(Object.values(g.can).every((v) => v === false))
      assert.ok(!list.some((w) => w.id === ws2.id))
      assert.ok(list.some((w) => w.id === gHome.id && w.role === 'owner'), 'own workspace stays')
    })

    it('page tree: only the shared subtrees, their tops without a parent', async () => {
      const res = await as(G, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.equal(res.statusCode, 200)
      const pages = (res.json() as { pages: { id: string; parentId: string | null }[] }).pages
      assert.deepEqual(pages.map((p) => p.id).sort(), [id.root, id.inner, id.deep, id.viewRoot, id.commentRoot].sort())
      assert.equal(pages.find((p) => p.id === id.root)?.parentId, null)
      assert.equal(pages.find((p) => p.id === id.inner)?.parentId, id.root)
      assertNoOutside(res.body, 'page tree')
    })

    it('a member and a stranger: the member sees everything, the stranger nothing', async () => {
      const m = await as(M, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.equal(m.statusCode, 200)
      assert.ok(m.body.includes(id.outside))
      assert.equal((await as(X, 'GET', `/api/workspaces/${ws1.id}/pages`)).statusCode, 403)
    })

    it('workspace-wide routes stay member-only (403) for a guest', async () => {
      const routes: [string, string, unknown?][] = [
        ['GET', `/api/workspaces/${ws1.id}/search?q=${W}`],
        ['GET', `/api/workspaces/${ws1.id}/graph`],
        ['GET', `/api/workspaces/${ws1.id}/graph/islands`],
        ['GET', `/api/workspaces/${ws1.id}/tags`],
        ['GET', `/api/workspaces/${ws1.id}/trash`],
        ['GET', `/api/workspaces/${ws1.id}/members`],
        ['GET', `/api/workspaces/${ws1.id}/member-candidates?q=o`],
        ['GET', `/api/workspaces/${ws1.id}/settings`],
        ['GET', `/api/workspaces/${ws1.id}/activity`],
        ['GET', `/api/workspaces/${ws1.id}/export`],
        ['GET', `/api/workspaces/${ws1.id}/templates`],
        ['GET', `/api/workspaces/${ws1.id}/bookmarks`],
        ['GET', `/api/workspaces/${ws1.id}/shared`],
        ['GET', `/api/workspaces/${ws1.id}/due`],
        ['GET', `/api/workspaces/${ws1.id}/agent-instructions`],
        ['GET', `/api/workspaces/${ws1.id}/large-pages`],
        ['GET', `/api/workspaces/${ws1.id}/webhooks`],
        ['GET', `/api/workspaces/${ws1.id}/audit`],
        ['GET', `/api/workspaces/${ws1.id}/guests`],
        ['GET', `/api/workspaces/${ws1.id}/notification-level`],
        ['GET', `/api/changes?workspaceId=${ws1.id}`],
        ['GET', `/api/context?workspaceId=${ws1.id}&q=${W}`],
        ['GET', `/api/inbox?workspaceId=${ws1.id}`],
        ['POST', `/api/workspaces/${ws1.id}/query`, { query: `LIST FROM "/"` }],
        ['POST', `/api/workspaces/${ws1.id}/tasks`, { text: 'x' }],
        ['POST', `/api/workspaces/${ws1.id}/import-folder`, { files: [] }],
      ]
      for (const [method, url, body] of routes) {
        const res = await as(G, method, url, body)
        assert.ok(res.statusCode === 403 || res.statusCode === 400, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 200)}`)
        assertNoOutside(res.body, url)
      }
    })

    it('cross-workspace feeds leave the guest workspace out', async () => {
      for (const url of [`/api/context?q=${W}`, '/api/changes', '/api/inbox', '/api/notifications', `/api/pages/read?ids=${id.root},${id.outside}`]) {
        const res = await as(G, 'GET', url)
        // read_pages names the ids it was asked for as not found (an echo of the request, not a leak)
        if (!url.startsWith('/api/pages/read')) assertNoOutside(res.body, url)
        assert.ok(!res.body.includes(`outside body ${W}`) && !res.body.includes(`OutsideChild ${W}`), `${url}: outside content`)
        assert.ok(!res.body.includes(`root body ${W}`), `${url}: body text of the guest workspace through a member-wide feed`)
      }
    })

    it('single pages outside the shared trees do not exist (404) on every page route', async () => {
      for (const target of [id.outside, id.outsideChild, id.other]) {
        for (const url of [
          `/api/pages/${target}/lock`,
          `/api/pages/${target}/comments`,
          `/api/pages/${target}/backlinks`,
          `/api/pages/${target}/export`,
          `/api/pages/${target}/share`,
          `/api/pages/${target}/access`,
          `/api/pages/${target}/snapshots`,
          `/api/pages/${target}/size`,
          `/api/pages/${target}/outline`,
        ]) {
          const res = await as(G, 'GET', url)
          assert.ok(res.statusCode === 404 || res.statusCode === 403, `${url}: ${res.statusCode}`)
          assertNoOutside(res.body, url)
        }
      }
    })

    it('member-only page routes refuse a guest even inside the shared tree', async () => {
      for (const [method, url, body] of [
        ['GET', `/api/pages/${id.root}/export`],
        ['GET', `/api/pages/${id.root}/access`],
        ['GET', `/api/pages/${id.root}/share`],
        ['POST', `/api/pages/${id.root}/share`, {}],
        ['GET', `/api/pages/${id.root}/snapshots`],
        ['GET', `/api/pages/${id.root}/unlinked`],
        ['POST', `/api/pages/${id.root}/content`, { markdown: 'x', mode: 'append' }],
        ['POST', `/api/pages/${id.root}/duplicate`, {}],
        ['DELETE', `/api/pages/${id.root}`],
        ['PUT', `/api/pages/${id.root}/lock`, { locked: true }],
        ['POST', `/api/pages/${id.root}/bookmark`, {}],
      ] as [string, string, unknown?][]) {
        const res = await as(G, method, url, body)
        assert.equal(res.statusCode, 403, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 200)}`)
      }
    })

    it('backlinks inside the tree list only sources inside it', async () => {
      const res = await as(G, 'GET', `/api/pages/${id.inner}/backlinks`)
      assert.equal(res.statusCode, 200)
      assertNoOutside(res.body, 'backlinks')
      assert.ok(res.body.includes(id.deep), 'the inside source is listed')
      const m = await as(M, 'GET', `/api/pages/${id.inner}/backlinks`)
      assert.ok(m.body.includes(id.outsideChild), 'members still see the outside source')
    })

    it('lock status tells the guest their level', async () => {
      const edit = (await as(G, 'GET', `/api/pages/${id.deep}/lock`)).json()
      assert.equal(edit.canEdit, true)
      assert.equal(edit.level, 'edit')
      assert.equal(edit.guest, true)
      assert.equal(edit.canManage, false)
      const view = (await as(G, 'GET', `/api/pages/${id.viewRoot}/lock`)).json()
      assert.equal(view.canEdit, false)
      assert.equal(view.canComment, false)
      const comment = (await as(G, 'GET', `/api/pages/${id.commentRoot}/lock`)).json()
      assert.equal(comment.canEdit, false)
      assert.equal(comment.canComment, true)
    })
  })

  describe('what a guest can do', () => {
    it('creates a page under an editable shared page, never at the top or under a view page', async () => {
      const ok = await as(G, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.inner, title: `GuestChild ${W}` })
      assert.equal(ok.statusCode, 200, ok.body)
      id.guestChild = ok.json().page.id
      const top = await as(G, 'POST', '/api/pages', { workspaceId: ws1.id, title: 'top' })
      assert.equal(top.statusCode, 403)
      const outside = await as(G, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.outside, title: 'x' })
      assert.equal(outside.statusCode, 400)
      const view = await as(G, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.viewRoot, title: 'x' })
      assert.equal(view.statusCode, 403)
      assert.equal(view.json().error.code, 'PAGE_ACCESS')
    })

    it('web clipper (docs/adr/2260-*): clips under an editable shared page only; lookup sees only the shared trees', async () => {
      const url = `https://example.com/guest-clip-${W}`
      const ok = await as(G, 'POST', '/api/clip', { workspaceId: ws1.id, parentId: id.inner, url, text: 'quote' })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal(ok.json().page.parentId, id.inner)
      const top = await as(G, 'POST', '/api/clip', { workspaceId: ws1.id, url })
      assert.equal(top.statusCode, 403)
      const outside = await as(G, 'POST', '/api/clip', { workspaceId: ws1.id, parentId: id.outside, url })
      assert.equal(outside.statusCode, 400)
      const view = await as(G, 'POST', '/api/clip', { workspaceId: ws1.id, parentId: id.viewRoot, url })
      assert.equal(view.statusCode, 403)
      assert.equal(view.json().error.code, 'PAGE_ACCESS')
      // the same URL clipped by the owner outside the shared trees stays invisible to the guest
      const mine = await as(O, 'POST', '/api/clip', { workspaceId: ws1.id, parentId: id.outside, url })
      assert.equal(mine.statusCode, 200, mine.body)
      const lu = await as(G, 'GET', `/api/clip/lookup?workspaceId=${ws1.id}&url=${encodeURIComponent(url)}`)
      assert.equal(lu.statusCode, 200, lu.body)
      assert.deepEqual(lu.json().pages.map((p: { id: string }) => p.id), [ok.json().page.id])
      assert.ok(!lu.body.includes(mine.json().page.id))
      assertNoOutside(lu.body, 'clip lookup')
      // no lookup in a workspace the guest has nothing in
      assert.equal((await as(G, 'GET', `/api/clip/lookup?workspaceId=${ws2.id}&url=${encodeURIComponent(url)}`)).statusCode, 403)
    })

    it('renames where it can edit; no moves, no scope changes; view pages refuse', async () => {
      assert.equal((await as(G, 'PATCH', `/api/pages/${id.deep}`, { title: `Deep2 ${W}` })).statusCode, 200)
      const move = await as(G, 'PATCH', `/api/pages/${id.deep}`, { parentId: id.root })
      assert.equal(move.statusCode, 403)
      assert.equal(move.json().error.code, 'GUEST_OUTSIDE')
      assert.equal((await as(G, 'PATCH', `/api/pages/${id.deep}`, { scope: 'private' })).statusCode, 403)
      const view = await as(G, 'PATCH', `/api/pages/${id.viewRoot}`, { title: 'nope' })
      assert.equal(view.statusCode, 403)
      assert.equal(view.json().error.code, 'PAGE_ACCESS')
      const out = await as(G, 'PATCH', `/api/pages/${id.outside}`, { title: 'nope' })
      assert.equal(out.statusCode, 404)
    })

    it('comments where the level allows', async () => {
      assert.equal((await as(G, 'POST', `/api/pages/${id.root}/comments`, { blockId: 'b1', body: 'hi from guest' })).statusCode, 200)
      assert.equal((await as(G, 'POST', `/api/pages/${id.commentRoot}/comments`, { blockId: 'b1', body: 'comment level' })).statusCode, 200)
      const view = await as(G, 'POST', `/api/pages/${id.viewRoot}/comments`, { blockId: 'b1', body: 'nope' })
      assert.equal(view.statusCode, 403)
      const list = await as(G, 'GET', `/api/pages/${id.root}/comments`)
      assert.equal(list.statusCode, 200)
      assert.ok(list.body.includes('hi from guest'))
      assertNoOutside(list.body, 'comments')
    })

    it('Later list and thread follows (docs/adr/1410-*, 1412-*): inside the shared trees only', async () => {
      assert.equal((await as(G, 'POST', '/api/later', { kind: 'page', pageId: id.root })).statusCode, 201)
      for (const target of [id.outside, id.outsideChild, id.other]) {
        const res = await as(G, 'POST', '/api/later', { kind: 'page', pageId: target })
        assert.equal(res.statusCode, 404, `later ${target}`)
        assertNoOutside(res.body, 'later save')
      }
      const outsideThread = (await as(M, 'POST', `/api/pages/${id.outside}/comments`, { blockId: 'b1', body: 'secret outside thread' })).json().comment
      assert.equal((await as(G, 'PUT', `/api/threads/${outsideThread.id}/follow`, { following: true })).statusCode, 404)
      assert.equal((await as(G, 'POST', '/api/later', { kind: 'thread', threadId: outsideThread.id })).statusCode, 404)
      const own = (await as(G, 'POST', `/api/pages/${id.root}/comments`, { blockId: 'b1', body: 'guest thread' })).json().comment
      assert.equal((await as(G, 'GET', `/api/threads/${own.id}/follow`)).json().following, true)
      await as(M, 'POST', `/api/pages/${id.root}/comments`, { blockId: 'b1', body: 'member reply', threadId: own.id })
      const view = await as(G, 'GET', `/api/threads?workspaceId=${ws1.id}&all=1`)
      assert.equal(view.statusCode, 200)
      assert.ok(view.body.includes('member reply'))
      assertNoOutside(view.body, 'threads view')
      const list = await as(G, 'GET', '/api/later')
      assert.equal(list.statusCode, 200)
      assertNoOutside(list.body, 'later list')
    })

    it('collections in the shared tree (docs/adr/2146-*): read, pick, add rows and edit cells; the rest stays member-only', async () => {
      // more cases (links, rollups and people outside, levels): collectionQuery/rows017.db.test.ts
      const coll = (await as(O, 'POST', '/api/pages', { workspaceId: ws1.id, parentId: id.root, kind: 'collection', title: `Coll ${W}` })).json().page.id as string
      assert.equal((await as(O, 'PUT', `/api/pages/${coll}/collection/fields`, { fields: [{ id: 'n', name: 'Note', type: 'text' }] })).statusCode, 200)
      for (const url of [`/api/pages/${coll}/collection`, `/api/pages/${coll}/collection/row-options`, `/api/pages/${coll}/collection/covers`, `/api/pages/${coll}/collection/row-templates`]) {
        const res = await as(G, 'GET', url)
        assert.equal(res.statusCode, 200, `${url}: ${res.body.slice(0, 200)}`)
        assertNoOutside(res.body, url)
      }
      const row = await as(G, 'POST', `/api/pages/${coll}/collection/rows`, { title: 'guest row', template: null })
      assert.equal(row.statusCode, 200, row.body)
      assert.equal((await as(G, 'PATCH', `/api/pages/${row.json().row.id}/props`, { props: { n: 'x' } })).statusCode, 200)
      for (const [method, url, body] of [
        ['PUT', `/api/pages/${coll}/collection/fields`, { fields: [] }],
        ['POST', `/api/pages/${coll}/collection/views`, { name: 'v', type: 'table' }],
        ['POST', `/api/pages/${coll}/collection/rows/batch`, { rows: [{ title: 'x' }] }],
        ['GET', `/api/pages/${coll}/collection/query`],
      ] as [string, string, unknown?][]) {
        assert.equal((await as(G, method, url, body)).statusCode, 403, `${method} ${url}`)
      }
    })

    it('files: upload into an editable page, download only files of shared pages', async () => {
      const boundary = '----inkguest'
      const payload =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n` +
        '\x89PNG\r\n\x1a\n0000' +
        `\r\n--${boundary}--\r\n`
      const up = await app.inject({
        method: 'POST',
        url: `/api/files?workspaceId=${ws1.id}&pageId=${id.inner}`,
        headers: { cookie: G.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      })
      assert.equal(up.statusCode, 200, `upload: ${up.body}`)
      const fileId = (up.json() as { file: { id: string } }).file.id
      const down = await as(G, 'GET', `/files/${fileId}`)
      assert.equal(down.statusCode, 200, `download: ${down.body}`)
      const noPage = await app.inject({
        method: 'POST',
        url: `/api/files?workspaceId=${ws1.id}`,
        headers: { cookie: G.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      })
      assert.equal(noPage.statusCode, 403)
      const view = await app.inject({
        method: 'POST',
        url: `/api/files?workspaceId=${ws1.id}&pageId=${id.viewRoot}`,
        headers: { cookie: G.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      })
      assert.equal(view.statusCode, 403)
      // A member's file on an outside page, and a legacy file without a page.
      const [outsideFile] = await db
        .insert(schema.files)
        .values({ workspaceId: ws1.id, pageId: id.outside, createdBy: O.id, name: 'o.png', mime: 'image/png', size: 4 })
        .returning({ id: schema.files.id })
      const [legacy] = await db
        .insert(schema.files)
        .values({ workspaceId: ws1.id, pageId: null, createdBy: O.id, name: 'l.png', mime: 'image/png', size: 4 })
        .returning({ id: schema.files.id })
      assert.equal((await as(G, 'GET', `/files/${outsideFile.id}`)).statusCode, 404)
      assert.equal((await as(G, 'GET', `/files/${legacy.id}`)).statusCode, 404)
      // file metadata (read_file, docs/adr/1514-*): the download's rules
      assert.equal((await as(G, 'GET', `/api/files/${fileId}/meta`)).statusCode, 200)
      assert.equal((await as(G, 'GET', `/api/files/${outsideFile.id}/meta`)).statusCode, 404)
      assert.equal((await as(G, 'GET', `/api/files/${legacy.id}/meta`)).statusCode, 404)
    })

    it('collaboration socket: read-write on edit, read-only on view, refused outside', async () => {
      const edit = await pushUpdate(G, id.inner, 'fromGuest')
      assert.notEqual(edit, 'denied')
      if (edit !== 'denied') {
        assert.equal(edit.scope, 'read-write')
        assert.equal(edit.applied, true)
      }
      const view = await pushUpdate(G, id.viewRoot, 'fromViewer')
      assert.notEqual(view, 'denied')
      if (view !== 'denied') {
        assert.equal(view.scope, 'readonly')
        assert.equal(view.applied, false)
      }
      assert.equal(await pushUpdate(G, id.outside, 'nope'), 'denied')
      assert.equal(await pushUpdate(X, id.root, 'nope'), 'denied')
    })

    it('cannot see or change who has access, nor publish', async () => {
      assert.equal((await as(G, 'PUT', `/api/pages/${id.root}/access`, { userId: X.id, level: 'view' })).statusCode, 403)
      assert.equal((await as(G, 'POST', `/api/pages/${id.root}/share`, {})).statusCode, 403)
    })
  })

  describe('leaks found in the audit', () => {
    it('an edit lock in the shared tree refuses the guest without naming the members who can edit', async () => {
      assert.equal((await as(O, 'PUT', `/api/pages/${id.inner}/lock`, { locked: true, people: 'editors', editorIds: [M.id] })).statusCode, 200)
      try {
        const res = await as(G, 'PATCH', `/api/pages/${id.deep}`, { title: 'locked?' })
        assert.equal(res.statusCode, 403)
        assert.equal(res.json().error.code, 'PAGE_LOCKED')
        assert.ok(!res.body.includes(M.name) && !res.body.includes(M.id), 'lock error names a member')
        const st = await as(G, 'GET', `/api/pages/${id.deep}/lock`)
        assert.equal(st.json().canEdit, false)
        assert.deepEqual(st.json().editors, [])
        assert.equal(st.json().owner, null)
        assert.ok(!st.body.includes(M.id))
      } finally {
        await as(O, 'PUT', `/api/pages/${id.inner}/lock`, { locked: false })
      }
    })

    it('a canvas export names only pages of its own workspace (cross-workspace title)', async () => {
      // A canvas in G's own workspace with a node pointing at a shared page of ws1 by id.
      const [canvas] = await db
        .insert(schema.pages)
        .values({ workspaceId: gHome.id, kind: 'canvas', title: 'probe', createdBy: G.id })
        .returning({ id: schema.pages.id })
      const doc = new Y.Doc()
      doc.getMap('cnodes').set('n1', { id: 'n1', type: 'page', pageId: id.outside, x: 0, y: 0, width: 100, height: 100 })
      await db.insert(schema.pageDocs).values({ pageId: canvas.id, state: Buffer.from(Y.encodeStateAsUpdate(doc)) })
      // X (a stranger to ws1 with no rows) and G (guest, but `outside` is not shared with them).
      for (const u of [G, X]) {
        if (u === X) await db.insert(schema.workspaceMembers).values({ workspaceId: gHome.id, userId: X.id, role: 'member' }).onConflictDoNothing()
        const res = await as(u, 'GET', `/api/pages/${canvas.id}/export`)
        assert.equal(res.statusCode, 200, res.body)
        assert.ok(!res.body.includes(`Outside ${W}`), 'title of a page in another workspace')
      }
    })

    it('webhook events of a guest comment name only the page it was made on', async () => {
      const res = await as(G, 'POST', `/api/pages/${id.deep}/comments`, { blockId: 'b2', body: 'guest note' })
      assert.equal(res.statusCode, 200)
      const rows = (await db.execute(sql`
        SELECT payload::text AS p FROM outbox WHERE workspace_id = ${ws1.id} AND payload::text LIKE ${'%' + id.deep + '%'}
      `)) as unknown as { p: string }[]
      for (const r of rows) assertNoOutside(r.p, 'outbox payload')
    })
  })

  describe('tokens of a guest (docs/adr/1253-*)', () => {
    it('API tokens do not reach the guest workspace', async () => {
      const res = await as(G, 'POST', '/api/tokens', { name: 'g', expiresInDays: 30, access: 'write', range: { kind: 'all' } })
      assert.equal(res.statusCode, 201, res.body)
      const pat = (res.json() as { secret: string }).secret
      const list = await asToken(pat, 'GET', '/api/workspaces')
      assert.ok(!list.body.includes(ws1.id), 'not listed for tokens')
      assert.equal((await asToken(pat, 'GET', `/api/workspaces/${ws1.id}/pages`)).statusCode, 403)
      const lock = await asToken(pat, 'GET', `/api/pages/${id.root}/lock`)
      assert.ok(lock.statusCode === 403 || lock.statusCode === 404)
      assert.equal((await asToken(pat, 'GET', `/api/pages/${id.root}/comments`)).statusCode, 404)
      assert.equal((await asToken(pat, 'GET', `/api/workspaces/${gHome.id}/pages`)).statusCode, 200)
    })

    it('MCP: list_workspaces and read_page see nothing of the guest workspace', async () => {
      const mcp = await h.connectMcp(app, G, await h.mintToken(G))
      const ws = await mcp.tool('list_workspaces', {})
      assert.ok(!ws.text.includes(ws1.id))
      const read = await mcp.tool('read_page', { pageId: id.root })
      assert.equal(read.isError, true)
      assert.ok(!read.text.includes(`root body ${W}`))
      await mcp.close()
    })
  })

  describe('members with their own rows (docs/adr/1251-*)', () => {
    it('owners and admins cannot be given a row', async () => {
      const res = await as(O, 'PUT', `/api/pages/${id.root}/access`, { userId: O.id, level: 'view' })
      assert.equal(res.statusCode, 400)
    })

    it('a view row takes edit and comment away from a member, at once (access version)', async () => {
      assert.equal((await as(M, 'PATCH', `/api/pages/${id.inner}`, { title: `Inner ${W}` })).statusCode, 200)
      const v0 = await aclVersion(ws1.id)
      await grant(O, id.root, { userId: M.id }, 'view')
      assert.ok((await aclVersion(ws1.id)) > v0, 'version bumped')
      const patch = await as(M, 'PATCH', `/api/pages/${id.inner}`, { title: 'blocked' })
      assert.equal(patch.statusCode, 403)
      assert.equal(patch.json().error.code, 'PAGE_ACCESS')
      assert.equal((await as(M, 'POST', `/api/pages/${id.inner}/comments`, { blockId: 'b', body: 'x' })).statusCode, 403)
      assert.equal((await as(M, 'POST', `/api/pages/${id.inner}/content`, { markdown: 'x', mode: 'append' })).statusCode, 403)
      // still sees it
      assert.equal((await as(M, 'GET', `/api/pages/${id.inner}/comments`)).statusCode, 200)
      const sock = await pushUpdate(M, id.inner, 'fromM')
      assert.ok(sock !== 'denied' && sock.scope === 'readonly')
      // trash of an ancestor carries the restricted subtree: refused
      assert.equal((await as(M, 'DELETE', `/api/pages/${id.root}`)).statusCode, 403)
      // the member's agent: same level, told in can: and refused with PAGE_ACCESS
      const mcp = await h.connectMcp(app, { ...M, via: 'Test Agent' }, await h.mintToken(M))
      const read = await mcp.tool('read_page', { pageId: id.inner })
      assert.equal(read.isError, false, read.text)
      assert.match(read.text, /can: read\b(?!,)/)
      const write = await mcp.tool('update_page', { pageId: id.inner, markdown: 'x', mode: 'append' })
      assert.equal(write.isError, true)
      assert.match(write.text, /PAGE_ACCESS|view access/)
      await mcp.close()
    })

    it('comment row: comments yes, edits no; removing the row restores the default', async () => {
      await grant(O, id.root, { userId: M.id }, 'comment')
      assert.equal((await as(M, 'POST', `/api/pages/${id.inner}/comments`, { blockId: 'b', body: 'ok' })).statusCode, 200)
      assert.equal((await as(M, 'PATCH', `/api/pages/${id.inner}`, { title: 'blocked' })).statusCode, 403)
      assert.equal((await as(O, 'DELETE', `/api/pages/${id.root}/access/${M.id}`)).statusCode, 200)
      assert.equal((await as(M, 'PATCH', `/api/pages/${id.inner}`, { title: `Inner ${W}` })).statusCode, 200)
    })

    it('full row: the member manages people on that subtree only', async () => {
      await grant(O, id.root, { userId: M.id }, 'full')
      const acc = (await as(M, 'GET', `/api/pages/${id.inner}/access`)).json().access
      assert.equal(acc.canManage, true)
      assert.equal(acc.myLevel, 'full')
      assert.ok(acc.people.some((p: { userId: string; guest: boolean; inheritedFrom: unknown }) => p.userId === G.id && p.guest && p.inheritedFrom))
      // outside the subtree: member default, no managing
      const out = (await as(M, 'GET', `/api/pages/${id.outside}/access`)).json().access
      assert.equal(out.canManage, false)
      assert.equal((await as(M, 'PUT', `/api/pages/${id.outside}/access`, { userId: G.id, level: 'view' })).statusCode, 403)
      await as(O, 'DELETE', `/api/pages/${id.root}/access/${M.id}`)
    })
  })

  describe('workspace policy and guest list', () => {
    it('policy off: nobody adds guests; admins default: members cannot', async () => {
      const r1 = await as(M, 'PUT', `/api/pages/${id.outside}/access`, { userId: X.id, level: 'view' })
      assert.equal(r1.statusCode, 403)
      assert.equal((await as(O, 'PATCH', `/api/workspaces/${ws1.id}/settings`, { guestInvitePolicy: 'off' })).statusCode, 200)
      assert.equal((await as(O, 'PUT', `/api/pages/${id.outside}/access`, { userId: X.id, level: 'view' })).statusCode, 403)
      assert.equal((await as(O, 'PATCH', `/api/workspaces/${ws1.id}/settings`, { guestInvitePolicy: 'members' })).statusCode, 200)
      // members: up to their own level, never full for a guest
      assert.equal((await as(M, 'PUT', `/api/pages/${id.outside}/access`, { userId: X.id, level: 'full' })).statusCode, 400)
      assert.equal((await as(M, 'PUT', `/api/pages/${id.outside}/access`, { userId: X.id, level: 'edit' })).statusCode, 200)
      // but a member cannot restrict another member without full access
      assert.equal((await as(M, 'PUT', `/api/pages/${id.outside}/access`, { userId: O.id, level: 'view' })).statusCode, 400)
      await as(O, 'PATCH', `/api/workspaces/${ws1.id}/settings`, { guestInvitePolicy: 'admins' })
    })

    it('candidates: members by prefix, outsiders by exact email only; PUT by email finds the account', async () => {
      const xEmail = `stranger-${randomBytes(3).toString('hex')}@example.com`
      await db.update(schema.users).set({ email: xEmail }).where(eq(schema.users.id, X.id))
      X.email = xEmail
      const byMail = await as(O, 'PUT', `/api/pages/${id.commentRoot}/access`, { email: xEmail.toUpperCase(), level: 'view' })
      assert.equal(byMail.statusCode, 200, byMail.body)
      assert.equal(byMail.json().invite, undefined, 'an existing account gets a row, not an invitation')
      const prefix = await as(O, 'GET', `/api/pages/${id.root}/access/candidates?q=${encodeURIComponent('stranger')}`)
      assert.equal(prefix.statusCode, 200)
      assert.ok(!prefix.body.includes(X.id), 'no prefix search over accounts')
      const exact = await as(O, 'GET', `/api/pages/${id.root}/access/candidates?q=${encodeURIComponent(X.email)}`)
      assert.ok(exact.body.includes(X.id))
    })

    it('guest list and bulk removal (owners and admins)', async () => {
      assert.equal((await as(M, 'GET', `/api/workspaces/${ws1.id}/guests`)).statusCode, 403)
      const list = (await as(O, 'GET', `/api/workspaces/${ws1.id}/guests`)).json().guests as { userId: string; pages: unknown[] }[]
      assert.ok(list.some((g) => g.userId === G.id && g.pages.length === 3))
      assert.ok(list.some((g) => g.userId === X.id))
      const res = await as(O, 'POST', `/api/workspaces/${ws1.id}/guests/remove`, { userIds: [X.id] })
      assert.equal(res.json().removed, 1)
      assert.equal((await as(X, 'GET', `/api/workspaces/${ws1.id}/pages`)).statusCode, 403)
      const audit = await db
        .select({ action: schema.workspaceAuditEvents.action })
        .from(schema.workspaceAuditEvents)
        .where(eq(schema.workspaceAuditEvents.workspaceId, ws1.id))
      const actions = new Set(audit.map((a) => a.action))
      for (const a of ['page.access_granted', 'page.access_changed', 'page.access_removed', 'guests.removed']) assert.ok(actions.has(a), a)
    })
  })

  describe('invitations by email', () => {
    it('an address without an account gets an invitation; only that address accepts it', async () => {
      const email = `invitee-${randomBytes(3).toString('hex')}@example.com`
      const res = await as(O, 'PUT', `/api/pages/${id.viewRoot}/access`, { email, level: 'comment' })
      assert.equal(res.statusCode, 200, res.body)
      const link = res.json().invite.link as string
      assert.ok(link.includes('/invite/page/'))
      const token = link.split('/invite/page/')[1]
      const other = await h.makeUser('other')
      const wrong = await as(other, 'POST', `/api/page-invites/${token}/accept`)
      assert.equal(wrong.statusCode, 403)
      assert.equal(wrong.json().error.code, 'INVITE_EMAIL_MISMATCH')
      const invitee = await h.makeUser('invitee')
      await db.update(schema.users).set({ email }).where(eq(schema.users.id, invitee.id))
      const preview = await as(invitee, 'GET', `/api/page-invites/${token}`)
      assert.equal(preview.json().invite.emailMatches, true)
      assert.equal((await as(invitee, 'POST', `/api/page-invites/${token}/accept`)).statusCode, 200)
      const tree = await as(invitee, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.deepEqual((tree.json().pages as { id: string }[]).map((p) => p.id), [id.viewRoot])
      // used once
      assert.equal((await as(invitee, 'POST', `/api/page-invites/${token}/accept`)).statusCode, 404)
    })
  })

  describe('membership changes and 2FA', () => {
    it('removing a member removes their rows (no leftover guest access)', async () => {
      const Z = await h.makeUser('leaver')
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws1.id, userId: Z.id, role: 'member' })
      await grant(O, id.root, { userId: Z.id }, 'view')
      assert.ok([200, 204].includes((await as(O, 'DELETE', `/api/workspaces/${ws1.id}/members/${Z.id}`)).statusCode))
      const rows = await db.select().from(schema.pageGrants).where(eq(schema.pageGrants.userId, Z.id))
      assert.equal(rows.length, 0)
      assert.equal((await as(Z, 'GET', `/api/workspaces/${ws1.id}/pages`)).statusCode, 403)
    })

    it('a guest who joins becomes a plain member', async () => {
      const J = await h.makeUser('joiner')
      await grant(O, id.root, { userId: J.id }, 'view')
      const wsRow = await as(O, 'GET', '/api/workspaces')
      const code = (wsRow.json().workspaces as { id: string; inviteCode: string }[]).find((w) => w.id === ws1.id)!.inviteCode
      assert.equal((await as(J, 'POST', '/api/workspaces/join', { inviteCode: code })).statusCode, 200)
      assert.equal((await db.select().from(schema.pageGrants).where(eq(schema.pageGrants.userId, J.id))).length, 0)
      const tree = await as(J, 'GET', `/api/workspaces/${ws1.id}/pages`)
      assert.ok(tree.body.includes(id.outside))
    })

    it('the workspace 2FA requirement applies to guests', async () => {
      await db.update(schema.workspaces).set({ twoFactorRequiredAt: sql`now() - interval '1 day'`, twoFactorGraceDays: 0 }).where(eq(schema.workspaces.id, ws1.id))
      try {
        const res = await as(G, 'GET', `/api/workspaces/${ws1.id}/pages`)
        assert.equal(res.statusCode, 403)
        assert.equal(res.json().error.code, 'TWO_FACTOR_REQUIRED')
        assert.equal(await pushUpdate(G, id.root, 'blocked'), 'denied')
      } finally {
        await db.update(schema.workspaces).set({ twoFactorRequiredAt: null }).where(eq(schema.workspaces.id, ws1.id))
      }
    })

    it('removing the last row closes the workspace for the guest', async () => {
      for (const p of [id.root, id.viewRoot, id.commentRoot]) await as(O, 'DELETE', `/api/pages/${p}/access/${G.id}`)
      const list = await as(G, 'GET', '/api/workspaces')
      assert.ok(!list.body.includes(ws1.id))
      assert.equal((await as(G, 'GET', `/api/workspaces/${ws1.id}/pages`)).statusCode, 403)
      // an outsider now: the page answers like one that does not exist (docs/adr/1301-*)
      assert.equal((await as(G, 'GET', `/api/pages/${id.root}/comments`)).statusCode, 404)
      assert.equal(await pushUpdate(G, id.root, 'gone'), 'denied')
      // their own workspace is untouched
      assert.equal((await as(G, 'GET', `/api/workspaces/${gHome.id}/pages`)).statusCode, 200)
    })
  })

  async function aclVersion(workspaceId: string): Promise<number> {
    const [r] = await db
      .select({ v: schema.workspaceAclVersions.version })
      .from(schema.workspaceAclVersions)
      .where(and(eq(schema.workspaceAclVersions.workspaceId, workspaceId)))
    return Number(r?.v ?? 0)
  }
})
