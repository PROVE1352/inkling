// Device copies of pages against the real server (docs/adr/2200-*, 2201-*): the document generation
// (bumped after restore / revert / split / full rewrite, sent on connect and to open clients), the
// /sync-check route (generation, edit right, trash, state vector, 403/404), and two real Hocuspocus
// providers over sockets running the browser's own gate and device-copy code (apps/web/src/lib/offline)
// for cases A–E. The Yjs-level cases (F–H, storage failure) are apps/web/src/lib/offline/offline.test.ts.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// run-tests: db-exclusive
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

// The browser's modules, loaded by path so this package's typecheck does not compile web code.
// They resolve `yjs` to the same store path as the server, so Y.Doc instances are shared.
const webDir = path.resolve(process.cwd(), '../web')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webModule = (rel: string): Promise<any> => import(pathToFileURL(path.join(webDir, 'src/lib/offline', rel)).href)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

describe('[db] offline device copies: generation, sync check, real clients', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { drainChangeLog } = await import('./context/changeLog')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const { createGate } = await webModule('gate.ts')
  const { createPageCopy } = await webModule('pageCopy.ts')
  const { createMemoryStore, hasPending } = await webModule('store.ts')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })

  let O: U, M: U, X: U
  let wsId: string
  let port = 0
  let server: ReturnType<typeof createServer>

  before(async () => {
    O = await h.makeUser('Owner')
    M = await h.makeUser('Member')
    X = await h.makeUser('Leaver')
    wsId = (await h.makeWorkspace(O, [M, X])).id
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

  async function newPage(title: string, blocks: unknown[]) {
    const pg = await h.makeDocPage(wsId, O.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const gen = async (id: string) => (await db.select({ g: schema.pages.docGen }).from(schema.pages).where(eq(schema.pages.id, id)))[0].g
  const liveXml = (id: string) => collab.hocuspocus.documents.get(id)?.getXmlFragment('document').toString() ?? ''
  async function storedXml(id: string) {
    const live = collab.hocuspocus.documents.get(id)
    if (live) return live.getXmlFragment('document').toString()
    const [row] = await db.select({ state: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, id))
    const d = new Y.Doc()
    const { applyStoredState } = await import('./yState')
    applyStoredState(d, row.state)
    return d.getXmlFragment('document').toString()
  }
  const count = (hay: string, needle: string) => hay.split(needle).length - 1
  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** The XmlText of the paragraph whose text contains `marker` (BlockNote nesting: blockGroup > blockContainer > paragraph > text). */
  function textWith(doc: InstanceType<typeof Y.Doc>, marker: string): InstanceType<typeof Y.XmlText> {
    const walk = (n: unknown): InstanceType<typeof Y.XmlText> | null => {
      if (n instanceof Y.XmlText) return n.toString().includes(marker) ? n : null
      if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) {
        for (const c of n.toArray()) {
          const r = walk(c)
          if (r) return r
        }
      }
      return null
    }
    const t = walk(doc.getXmlFragment('document'))
    if (!t) throw new Error(`no text with ${marker}`)
    return t
  }

  /** What the browser's fetchSyncCheck makes of the route's answer. */
  const checkAs = (u: U, pageId: string) => async () => {
    const r = await req(u, 'GET', `/pages/${pageId}/sync-check`)
    if (r.statusCode === 403 || r.statusCode === 404) return { kind: 'gone' }
    assert.equal(r.statusCode, 200, r.body)
    const j = r.json()
    return { kind: 'ok', gen: j.gen, canEdit: j.canEdit, trashed: j.trashed, sv: new Uint8Array(Buffer.from(j.sv, 'base64')) }
  }

  /**
   * A browser tab as CollabEditor wires it: device copy loaded first, then a provider whose token is
   * the sync gate, acks clearing the copy's marks, and the generation from stateless messages.
   */
  async function openTab(u: U, pageId: string, store: ReturnType<typeof createMemoryStore>) {
    const doc = new Y.Doc()
    const copy = createPageCopy({ store, userId: u.id, pageId, wsId, doc, session: `s-${Math.random()}` })
    const record = await copy.load()
    const tab = {
      doc,
      copy,
      record,
      blocked: null as null | { kind: string; reason?: string },
      gens: [] as number[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket: null as any,
      authFailed: false,
      close() {
        tab.provider?.destroy()
        tab.socket?.destroy()
        copy.dispose()
      },
    }
    const gate = createGate({
      doc,
      copy,
      check: checkAs(u, pageId),
      sleep: async () => {},
      onBlocked: async (d: { kind: string; reason?: string }) => {
        tab.blocked = d
        if (d.kind === 'recover') {
          await copy.flush()
          await store.addRecovery({ userId: u.id, pageId, wsId, title: '', reason: d.reason, state: Y.encodeStateAsUpdate(doc), createdAt: Date.now() })
        }
        copy.dispose()
        await store.deleteDoc(u.id, pageId)
      },
    })
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: u.cookie } })
      }
    }
    tab.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    tab.provider = new HocuspocusProvider({
      websocketProvider: tab.socket,
      name: pageId,
      document: doc,
      token: gate,
      // two clients in one process must not talk through BroadcastChannel
      broadcast: false,
      onStateless: ({ payload }: { payload: string }) => {
        const m = JSON.parse(payload)
        if (m?.t === 'gen') {
          tab.gens.push(m.gen)
          copy.setGen(m.gen)
        }
      },
      onAuthenticationFailed: () => {
        tab.authFailed = true
      },
    })
    const p = tab.provider
    copy.start((origin: unknown) => origin === p)
    p.on('unsyncedChanges', (n: number) => {
      if (n === 0 && copy.pending()) void copy.acked()
    })
    return tab
  }
  type Tab = Awaited<ReturnType<typeof openTab>>
  const synced = (t: Tab) => until(() => t.provider.isSynced && t.provider.unsyncedChanges === 0, 'sync')
  /** the network goes away: nothing reaches the server until online() */
  const offline = (t: Tab) => {
    t.socket.shouldConnect = false
    t.socket.disconnect()
  }
  const online = (t: Tab) => {
    void t.socket.connect()
  }

  describe('sync check route and generation', () => {
    it('answers generation, edit right, trash state and the state vector; bumps after restore, revert and split, not after an append', async () => {
      const P = await newPage('Gen', [heading('Intro'), para('one'), heading('Body'), para('two')])
      let r = (await req(M, 'GET', `/pages/${P}/sync-check`)).json()
      assert.deepEqual([r.gen, r.canEdit, r.trashed], [0, true, false])
      assert.ok(Y.decodeStateVector(Buffer.from(r.sv, 'base64')).size > 0)
      assert.equal(r.gen, await gen(P))

      // version restore: snapshot, edit, restore → generation 1
      assert.equal((await req(O, 'POST', `/pages/${P}/snapshots`, {})).statusCode, 200)
      const sid = (await req(O, 'GET', `/pages/${P}/snapshots`)).json().snapshots[0].id
      assert.equal((await req(O, 'POST', `/pages/${P}/content`, { markdown: 'appended', mode: 'append' })).statusCode, 200)
      assert.equal(await gen(P), 0, 'an append is a normal edit: no bump')
      assert.equal((await req(O, 'POST', `/pages/${P}/snapshots/${sid}/restore`)).statusCode, 200)
      assert.equal(await gen(P), 1)

      // AI-edit revert → generation 2
      const token = await h.mintToken(O, 'notes', 'Claude')
      const agent = await h.connectMcp(app, O, token)
      try {
        const outline = (await req(O, 'GET', `/pages/${P}/outline`)).json().sections as { anchor: string; version: string }[]
        const body = outline.find((s) => s.anchor === 'body')!
        const res = await agent.tool('patch_section', { pageId: P, section: 'body', mode: 'replace', markdown: 'two by agent', baseVersion: body.version })
        assert.equal(res.isError, false, res.text)
        await drainChangeLog()
        const items = (await req(O, 'GET', `/pages/${P}/changes`)).json().items as { seq: string; via: string | null }[]
        const mine = items.find((i) => i.via)!
        const rv = await req(O, 'POST', `/changes/${mine.seq}/revert`, {})
        assert.equal(rv.statusCode, 200, rv.body)
        assert.equal(await gen(P), 2)
      } finally {
        await agent.close()
      }

      // split → generation 3 on the parent
      const sp = await req(O, 'POST', `/pages/${P}/split`, { level: 2 })
      if (sp.statusCode === 200) assert.equal(await gen(P), 3)
      else assert.fail(`split: ${sp.statusCode} ${sp.body}`)

      // the generation travels with the page row only: a member's check sees it
      r = (await req(M, 'GET', `/pages/${P}/sync-check`)).json()
      assert.equal(r.gen, 3)
    })

    it('a locked page answers canEdit false; a trashed page trashed true; no access 403/404', async () => {
      const P = await newPage('Access', [para('x')])
      assert.equal((await req(O, 'PUT', `/pages/${P}/lock`, { locked: true })).statusCode, 200)
      assert.equal((await req(M, 'GET', `/pages/${P}/sync-check`)).json().canEdit, false)
      assert.equal((await req(O, 'GET', `/pages/${P}/sync-check`)).json().canEdit, true)
      assert.equal((await req(O, 'PUT', `/pages/${P}/lock`, { locked: false })).statusCode, 200)
      assert.equal((await req(O, 'DELETE', `/pages/${P}`)).statusCode, 204)
      const t = (await req(M, 'GET', `/pages/${P}/sync-check`)).json()
      assert.deepEqual([t.trashed, t.canEdit], [true, false])
      const stranger = await h.makeUser('Stranger')
      // not a member: 403 like the other page routes (the browser treats 403 and 404 alike)
      assert.ok([403, 404].includes((await req(stranger, 'GET', `/pages/${P}/sync-check`)).statusCode))
      // agent tokens do not get it (the socket's rules, not the token range, are applied here)
      const token = await h.mintToken(O, 'notes', 'Claude')
      const bearer = await app.inject({ method: 'GET', url: `/api/pages/${P}/sync-check`, headers: { authorization: `Bearer ${token}` } })
      assert.equal(bearer.statusCode, 403)
      const priv = await newPage('Private', [para('mine')])
      await db.update(schema.pages).set({ scope: 'private' }).where(eq(schema.pages.id, priv))
      assert.equal((await req(M, 'GET', `/pages/${priv}/sync-check`)).statusCode, 404)
    })

    it('the generation is sent on connect; an older client that ignores it syncs as before', async () => {
      const P = await newPage('Hello', [para('hello')])
      await db.update(schema.pages).set({ docGen: 7 }).where(eq(schema.pages.id, P))
      const store = createMemoryStore()
      await store.claim(M.id)
      const t = await openTab(M, P, store)
      try {
        await synced(t)
        await until(() => t.gens.length > 0, 'gen message')
        assert.deepEqual(t.gens, [7])
        await t.copy.flush()
        assert.equal((await store.getDoc(M.id, P)).record.gen, 7)
      } finally {
        t.close()
      }
      // an older client: the provider's default onStateless ignores the payload, the body syncs
      const old = new Y.Doc()
      class CookieSocket extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie: M.cookie } })
        }
      }
      const sock = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket })
      const prov = new HocuspocusProvider({ websocketProvider: sock, name: P, document: old, token: 'cookie', broadcast: false })
      try {
        await until(() => prov.isSynced, 'old client sync')
        assert.match(old.getXmlFragment('document').toString(), /hello/)
      } finally {
        prov.destroy()
        sock.destroy()
      }
    })
  })

  describe('two real clients', () => {
    it('A: an offline edit and a concurrent online edit both land once', async () => {
      const P = await newPage('A', [para('alpha'), para('beta')])
      const storeM = createMemoryStore()
      await storeM.claim(M.id)
      const storeO = createMemoryStore()
      await storeO.claim(O.id)
      const m = await openTab(M, P, storeM)
      const o = await openTab(O, P, storeO)
      try {
        await synced(m)
        await synced(o)
        offline(m)
        textWith(m.doc, 'alpha').insert(5, ' OFFLINE-M')
        textWith(o.doc, 'beta').insert(4, ' ONLINE-O')
        await until(() => liveXml(P).includes('ONLINE-O'), 'online edit on the server')
        await m.copy.flush()
        assert.equal(hasPending((await storeM.getDoc(M.id, P)).record), true)
        // the tab is reloaded while still offline, then the network comes back
        m.close()
        const m2 = await openTab(M, P, storeM)
        assert.match(m2.doc.getXmlFragment('document').toString(), /OFFLINE-M/, 'reopened from the device')
        await synced(m2)
        await until(() => liveXml(P).includes('OFFLINE-M'), 'offline edit on the server')
        await until(() => o.doc.getXmlFragment('document').toString().includes('OFFLINE-M'), 'other client sees it')
        const xml = liveXml(P)
        assert.equal(count(xml, 'OFFLINE-M'), 1)
        assert.equal(count(xml, 'ONLINE-O'), 1)
        assert.equal(count(xml, 'alpha'), 1, 'no doubled body')
        await until(async () => !hasPending((await storeM.getDoc(M.id, P)).record), 'pending cleared')
        m2.close()
      } finally {
        o.close()
      }
    })

    it('B: version restored while the device holds unsent edits — restored body, no revival, no doubling, edits kept for recovery', async () => {
      const P = await newPage('B', [para('v0 text')])
      assert.equal((await req(O, 'POST', `/pages/${P}/snapshots`, {})).statusCode, 200)
      const sid = (await req(O, 'GET', `/pages/${P}/snapshots`)).json().snapshots[0].id
      assert.equal((await req(O, 'POST', `/pages/${P}/content`, { markdown: 'v1 added later', mode: 'append' })).statusCode, 200)
      const store = createMemoryStore()
      await store.claim(M.id)
      const m = await openTab(M, P, store)
      try {
        await synced(m)
        await until(() => m.gens.length > 0, 'gen')
        offline(m)
        textWith(m.doc, 'v1 added later').insert(0, 'TYPED-OFFLINE ')
        await m.copy.flush()
        // live reconnect of the same tab, after the restore
        assert.equal((await req(O, 'POST', `/pages/${P}/snapshots/${sid}/restore`)).statusCode, 200)
        online(m)
        await until(() => m.blocked !== null, 'gate decision')
        assert.deepEqual(m.blocked, { kind: 'recover', reason: 'restored' })
        await until(() => m.authFailed, 'the provider gave the document up')
        await new Promise((r) => setTimeout(r, 200))
        const xml = await storedXml(P)
        assert.equal(count(xml, 'v0 text'), 1, 'restored body, not doubled')
        assert.equal(count(xml, 'v1 added later'), 0, 'what the restore removed stays removed')
        assert.equal(count(xml, 'TYPED-OFFLINE'), 0, 'nothing from the device merged')
        const [item] = await store.listRecovery(M.id)
        const kept = new Y.Doc()
        Y.applyUpdate(kept, item.state)
        assert.match(kept.getXmlFragment('document').toString(), /TYPED-OFFLINE/)
        assert.equal(await store.getDoc(M.id, P), null, 'the stale copy is gone; the editor reopens from the server')
      } finally {
        m.close()
      }
    })

    it('C: AI edit reverted while offline: the offline edit inside it is kept for recovery', async () => {
      const P = await newPage('C', [heading('Notes'), para('mine'), heading('Agent'), para('base')])
      const token = await h.mintToken(O, 'notes', 'Claude')
      const agent = await h.connectMcp(app, O, token)
      const store = createMemoryStore()
      await store.claim(M.id)
      try {
        const v = ((await req(O, 'GET', `/pages/${P}/outline`)).json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === 'agent')!
        assert.equal((await agent.tool('patch_section', { pageId: P, section: 'agent', mode: 'replace', markdown: 'AGENT-TEXT', baseVersion: v.version })).isError, false)
        await drainChangeLog()
        const m = await openTab(M, P, store)
        await synced(m)
        await until(() => m.gens.length > 0, 'gen')
        offline(m)
        textWith(m.doc, 'AGENT-TEXT').insert(0, 'FIXED-OFFLINE ')
        await m.copy.flush()
        m.close() // tab closed while offline
        const items = (await req(O, 'GET', `/pages/${P}/changes`)).json().items as { seq: string; via: string | null }[]
        assert.equal((await req(O, 'POST', `/changes/${items.find((i) => i.via)!.seq}/revert`, {})).statusCode, 200)
        const m2 = await openTab(M, P, store)
        try {
          await until(() => m2.blocked !== null, 'gate decision')
          assert.equal(m2.blocked!.reason, 'restored')
          const xml = await storedXml(P)
          assert.equal(count(xml, 'FIXED-OFFLINE'), 0)
          assert.equal(count(xml, 'AGENT-TEXT'), 0)
          assert.equal(count(xml, 'base'), 1)
          assert.equal((await store.listRecovery(M.id)).length, 1)
        } finally {
          m2.close()
        }
      } finally {
        await agent.close()
      }
    })

    it('D: trashed while offline: edits kept for recovery, the page is not written or revived', async () => {
      const P = await newPage('D', [para('note')])
      const store = createMemoryStore()
      await store.claim(M.id)
      const m = await openTab(M, P, store)
      await synced(m)
      offline(m)
      textWith(m.doc, 'note').insert(4, ' OFFLINE')
      await m.copy.flush()
      m.close()
      assert.equal((await req(O, 'DELETE', `/pages/${P}`)).statusCode, 204)
      const m2 = await openTab(M, P, store)
      try {
        await until(() => m2.blocked !== null, 'gate decision')
        assert.deepEqual(m2.blocked, { kind: 'recover', reason: 'trashed' })
        assert.equal(count(await storedXml(P), 'OFFLINE'), 0)
        const [row] = await db.select({ d: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, P))
        assert.ok(row.d, 'still in the trash')
        assert.equal((await store.listRecovery(M.id)).length, 1)
      } finally {
        m2.close()
      }
    })

    it('E: locked while offline: the server takes no write, the edits are shown, no retry loop; removed member: copy deleted', async () => {
      const P = await newPage('E', [para('text')])
      const store = createMemoryStore()
      await store.claim(M.id)
      const m = await openTab(M, P, store)
      await synced(m)
      offline(m)
      textWith(m.doc, 'text').insert(4, ' OFFLINE')
      await m.copy.flush()
      m.close()
      assert.equal((await req(O, 'PUT', `/pages/${P}/lock`, { locked: true })).statusCode, 200)
      const counted = await openTab(M, P, store)
      try {
        await until(() => counted.blocked !== null, 'gate decision')
        assert.deepEqual(counted.blocked, { kind: 'recover', reason: 'readonly' })
        // the provider gave up: no Auth, so no reconnect storm of rejected SyncStep2s
        await new Promise((r) => setTimeout(r, 400))
        assert.equal(counted.provider.isAuthenticated, false)
        assert.equal(counted.authFailed, true)
        assert.equal(count(await storedXml(P), 'OFFLINE'), 0)
      } finally {
        counted.close()
      }

      // member removal: 404 on the check, copy deleted (unsent edits included)
      const Q = await newPage('E2', [para('shared')])
      const storeX = createMemoryStore()
      await storeX.claim(X.id)
      const x = await openTab(X, Q, storeX)
      await synced(x)
      offline(x)
      textWith(x.doc, 'shared').insert(0, 'X-OFFLINE ')
      await x.copy.flush()
      x.close()
      await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, wsId), eq(schema.workspaceMembers.userId, X.id)))
      const x2 = await openTab(X, Q, storeX)
      try {
        await until(() => x2.blocked !== null, 'gate decision')
        assert.deepEqual(x2.blocked, { kind: 'forget' })
        assert.equal(await storeX.getDoc(X.id, Q), null)
        assert.equal(count(await storedXml(Q), 'X-OFFLINE'), 0)
      } finally {
        x2.close()
      }
    })
  })
})
