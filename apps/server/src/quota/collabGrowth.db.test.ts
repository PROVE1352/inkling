// Live editing against the storage limit (contract §14, security review F2, docs/adr/2530-*).
//  - The review's reproduction (w22-reports/sec/collab_overshoot.mjs), in process: one signed-in member
//    opens several pages on one socket and pushes far more than the limit into them. Before the fix the
//    store path only noted the growth afterwards (20 MB limit, 33.5 MB stored; 40 pages × 8 MB ran the
//    server out of memory). Now an update that does not fit is never applied or stored.
//  - Ordinary editing within the limit is never refused: a 1 MB paste, an image block, three people
//    typing in one page at once.
//  - Without a storage limit (or the instance fuse) none of this runs: same pushes, nothing refused,
//    no socket closed, everything stored.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const webDir = path.resolve(process.cwd(), '../web')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

describe('[db] collab updates against the storage limit (F2)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const S = await import('./storage')
  const G = await import('./collabGrowth')
  const collab = await import('../collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  let server: ReturnType<typeof createServer>
  let port = 0
  const open: { destroy: () => void }[] = []
  before(async () => {
    server = createServer((_r, s) => s.end())
    collab.attachCollab(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  after(async () => {
    for (const c of open) c.destroy()
    await new Promise<void>((r) => server.close(() => r()))
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  /** Wait until the server has refused at least `refusedAtLeast` updates and then handled no frame for 1 s. */
  const quiet = async (refusedAtLeast = 0) => {
    let last = -1
    let still = 0
    await until(() => {
      if (G.collabGrowthStats.refused < refusedAtLeast) return false
      const n = G.collabGrowthStats.admitted + G.collabGrowthStats.refused
      if (n === last) still++
      else {
        still = 0
        last = n
      }
      return still >= 40 // 1 s without a frame
    }, 'the frames to settle')
  }

  interface Tab {
    socket: InstanceType<typeof HocuspocusProviderWebsocket>
    closes: number
  }
  const socketFor = (cookie: string): Tab => {
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } })
      }
    }
    const tab: Tab = { socket: null as never, closes: 0 }
    tab.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    tab.socket.on('close', () => tab.closes++)
    open.push(tab.socket)
    return tab
  }
  const openPage = async (tab: Tab, pageId: string) => {
    const doc = new Y.Doc()
    let synced = false
    const provider = new HocuspocusProvider({ websocketProvider: tab.socket, name: pageId, document: doc, token: 'cookie', broadcast: false, onSynced: () => (synced = true) })
    open.push(provider)
    await until(() => synced, `sync of ${pageId}`)
    return { doc, provider }
  }
  const junk = (bytes: number) => randomBytes(Math.floor((bytes * 3) / 4)).toString('base64')
  const storedBody = async (pageId: string) =>
    Number(((await db.execute(sql`SELECT coalesce(octet_length(state), 0) AS n FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { n: number }[])[0]?.n ?? 0)

  it('R-F2: one socket pushing far past the limit into many pages: nothing past the page cap or the workspace limit is applied or stored', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 2 }) // page cap 512 KB
    try {
      const u = await h.makeUser('f2-push')
      const ws = await h.makeWorkspace(u)
      const ids: string[] = []
      for (let i = 0; i < 6; i++) ids.push((await h.makeDocPage(ws.id, u.id, `p${i}`, [] as never)).id)
      const tab = socketFor(u.cookie)
      const pages: Awaited<ReturnType<typeof openPage>>[] = []
      for (const id of ids) pages.push(await openPage(tab, id))
      const refusedBefore = G.collabGrowthStats.refused
      // 6 pages × 6 updates × 100 KB = 3.6 MB offered to a 2 MB workspace with 512 KB pages
      for (let round = 0; round < 6; round++) {
        for (const p of pages) p.doc.getText('junk').insert(p.doc.getText('junk').length, junk(100 * 1024))
      }
      await quiet(refusedBefore + 1)
      await collab.flushLiveDocuments(ids)
      const limit = L.mbToBytes(2)
      const count = await S.countWorkspaceStorage(db, ws.id)
      const bodies = await Promise.all(ids.map(storedBody))
      console.log(`[F2] offered ${6 * 6 * 100} KB; stored ${count.total} of ${limit} bytes; bodies ${bodies.join(',')}; refused ${G.collabGrowthStats.refused - refusedBefore}; socket closes ${tab.closes}`)
      assert.ok(G.collabGrowthStats.refused > refusedBefore, 'some updates were refused')
      assert.ok(count.total <= limit, `stored ${count.total} > ${limit}`)
      for (const b of bodies) assert.ok(b <= limit / 4, `a page body of ${b} past the cap`)
      // the server's live documents hold no more than the stores did
      for (const id of ids) {
        const live = collab.hocuspocus.documents.get(id)
        if (live) assert.ok(live.getText('junk').length <= limit / 4)
      }
      assert.ok(tab.closes >= 1, 'the refused socket was closed so the client learns read-only')
    } finally {
      restore()
    }
  })

  it('a refused page authorises read-only on reconnect (no write-refuse-close loop)', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 }) // page cap 256 KB
    try {
      const u = await h.makeUser('f2-loop')
      const ws = await h.makeWorkspace(u)
      const page = await h.makeDocPage(ws.id, u.id, 'loop', [] as never)
      const tab = socketFor(u.cookie)
      const scopes: string[] = []
      const doc = new Y.Doc()
      const provider = new HocuspocusProvider({
        websocketProvider: tab.socket,
        name: page.id,
        document: doc,
        token: 'cookie',
        broadcast: false,
        onAuthenticated: () => scopes.push(provider.authorizedScope),
      })
      open.push(provider)
      await until(() => scopes.length === 1, 'the first authentication')
      assert.equal(scopes[0], 'read-write')
      const stored = await storedBody(page.id)
      doc.getText('t').insert(0, junk(300 * 1024)) // one update past the page cap
      await until(() => scopes.length >= 2, 'the reconnect')
      assert.equal(scopes.at(-1), 'readonly')
      await quiet()
      await collab.flushLiveDocuments([page.id])
      assert.equal(await storedBody(page.id), stored, 'nothing of it was stored')
      assert.equal(tab.closes, 1, 'one close, then read-only: no loop')
    } finally {
      restore()
    }
  })

  it('a cache inflated by upper bounds (repeated property writes) does not keep live editing closed: the refusal recounts and reopens', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      const u = await h.makeUser('f2-inflate')
      const ws = await h.makeWorkspace(u)
      const page = await h.makeDocPage(ws.id, u.id, 'typing', [] as never)
      const created = (await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws.id, kind: 'collection', title: 'db' } })).json() as { page: { id: string } }
      const row = (await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws.id, parentId: created.page.id, title: 'r' } })).json() as { page: { id: string } }
      await S.recountWorkspaceStorage(ws.id)
      // the same key rewritten five times: each write counts its size until the next recount
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'PATCH', url: `/api/pages/${row.page.id}/props`, headers: { cookie: u.cookie }, payload: { props: { k: junk(200 * 1024) } } })
        assert.ok(r.statusCode === 200 || r.statusCode === 413, r.body)
      }
      // the most those upper bounds can leave behind: a cache at the limit (each write only passes while
      // it fits), with the last recount long ago
      await db.execute(sql`UPDATE workspaces SET storage_bytes = ${L.mbToBytes(1)}, storage_checked_at = now() - interval '1 hour' WHERE id = ${ws.id}`)
      const tab = socketFor(u.cookie)
      const scopes: string[] = []
      const doc = new Y.Doc()
      const provider = new HocuspocusProvider({ websocketProvider: tab.socket, name: page.id, document: doc, token: 'cookie', broadcast: false, onAuthenticated: () => scopes.push(provider.authorizedScope) })
      open.push(provider)
      await until(() => scopes.length >= 1, 'the first authentication')
      // whatever the cached number said first, the recount finds room and editing is open again
      // a cache at the limit that was not recounted lately is recounted before the connection is judged
      assert.equal(scopes[0], 'read-write')
      doc.getText('t').insert(0, 'a')
      await until(() => provider.unsyncedChanges === 0 && collab.hocuspocus.documents.get(page.id)?.getText('t').toString() === 'a', 'one character typed and kept')
      const used = Number(((await db.execute(sql`SELECT storage_bytes AS n FROM workspaces WHERE id = ${ws.id}`)) as unknown as { n: string }[])[0].n)
      console.log(`[F2] cache inflated to the limit by property rewrites: scopes ${scopes.join(',')}; cached use after the recount ${used}`)
      assert.ok(used < L.mbToBytes(1) / 2, 'recounted to what is stored')
      // and a live update refused on an inflated number reopens too: the refusal kicks a recount that
      // clears the refused page and reconnects it
      await db.execute(sql`UPDATE workspaces SET storage_bytes = ${L.mbToBytes(1)}, storage_checked_at = now() - interval '1 hour' WHERE id = ${ws.id}`)
      G.noteWorkspaceUsed(ws.id, L.mbToBytes(1))
      const before = scopes.length
      doc.getText('t').insert(1, 'b')
      await until(() => scopes.length > before && scopes.at(-1) === 'read-write', 'refused, recounted, reconnected read-write')
      await until(() => provider.unsyncedChanges === 0 && collab.hocuspocus.documents.get(page.id)?.getText('t').toString() === 'ab', 'the refused character sent again and kept')
    } finally {
      restore()
    }
  })

  it('ordinary editing within the limit is never refused: a 1 MB paste, an image block, three people at once', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20 })
    try {
      const refusedBefore = G.collabGrowthStats.refused
      const owner = await h.makeUser('f2-normal')
      const b = await h.makeUser('f2-normal-b')
      const c = await h.makeUser('f2-normal-c')
      const ws = await h.makeWorkspace(owner, [b, c])
      const page = await h.makeDocPage(ws.id, owner.id, 'shared', [] as never)
      const tabs = [owner, b, c].map((x) => socketFor(x.cookie))
      const docs: InstanceType<typeof Y.Doc>[] = []
      for (const t of tabs) docs.push((await openPage(t, page.id)).doc)
      // a 1 MB paste (one update, under the 2 MB frame cap)
      docs[0].getText('paste').insert(0, junk(1024 * 1024))
      // an image block (BlockNote's shape: a blockContainer holding an image node)
      const frag = docs[1].getXmlFragment('document-store')
      const img = new Y.XmlElement('image')
      img.setAttribute('url', 'https://notes.example.com/api/files/00000000-0000-4000-8000-000000000000')
      img.setAttribute('caption', 'figure 1')
      const container = new Y.XmlElement('blockContainer')
      container.insert(0, [img])
      frag.insert(0, [container])
      // three people typing in the same page at once
      for (let i = 0; i < 50; i++) for (const d of docs) d.getText('typing').insert(0, `x${i}`)
      const live0 = () => collab.hocuspocus.documents.get(page.id)
      await until(
        () => !!live0() && live0()!.getText('typing').length === 3 * 50 * 2 + 3 * 40 && live0()!.getText('paste').length > 0 && live0()!.getXmlFragment('document-store').length === 1,
        'every edit on the server',
      )
      await collab.flushLiveDocuments([page.id])
      assert.equal(G.collabGrowthStats.refused, refusedBefore, 'nothing refused')
      assert.equal(tabs.reduce((n, t) => n + t.closes, 0), 0, 'no socket closed')
      const live = collab.hocuspocus.documents.get(page.id)!
      assert.equal(live.getText('typing').length, 3 * 50 * 2 + 3 * 40)
      assert.ok(live.getText('paste').length >= 1024 * 1024 - 4)
      assert.equal(live.getXmlFragment('document-store').length, 1)
      assert.ok((await storedBody(page.id)) > 1024 * 1024)
    } finally {
      restore()
    }
  })

  it('without a storage limit or the fuse: no refusal and no close, everything offered is stored (the 0.21.1 path)', async () => {
    assert.equal(L.limits.workspaceStorageMb, null)
    assert.equal(L.limits.instanceStorageMb, undefined)
    assert.equal(G.collabGuardsOn(), false)
    const before = { ...G.collabGrowthStats }
    const u = await h.makeUser('f2-off')
    const ws = await h.makeWorkspace(u)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await h.makeDocPage(ws.id, u.id, `p${i}`, [] as never)).id)
    const tab = socketFor(u.cookie)
    const pages: Awaited<ReturnType<typeof openPage>>[] = []
    for (const id of ids) pages.push(await openPage(tab, id))
    // what the limited server above refuses: 600 KB per page
    for (let round = 0; round < 6; round++) for (const p of pages) p.doc.getText('junk').insert(p.doc.getText('junk').length, junk(100 * 1024))
    await until(() => pages.every((p) => p.provider.unsyncedChanges === 0), 'every update acknowledged')
    await collab.flushLiveDocuments(ids)
    assert.deepEqual(G.collabGrowthStats, before, 'the admission never ran')
    assert.equal(tab.closes, 0)
    for (const id of ids) assert.ok((await storedBody(id)) > 600 * 1024, 'stored in full')
  })
})

describe('collab growth counters (no database)', () => {
  it('reads the growth of Sync update and step 2 frames only', async () => {
    const G = await import('./collabGrowth')
    const enc = (name: string, ...ints: number[]) => {
      const nb = Buffer.from(name)
      return new Uint8Array([nb.length, ...nb, ...ints])
    }
    assert.equal(G.syncGrowthBytes(enc('p', 0, 2, 3, 1, 2, 3)), 8) // Sync, update: the whole frame
    assert.equal(G.syncGrowthBytes(enc('p', 4, 1, 1, 0)), 6) // SyncReply, step 2
    assert.equal(G.syncGrowthBytes(enc('p', 0, 0, 1, 0)), 0) // step 1: a state vector
    assert.equal(G.syncGrowthBytes(enc('p', 1, 5)), 0) // awareness
    assert.equal(G.syncGrowthBytes(enc('p', 2, 0)), 0) // auth
    assert.equal(G.syncGrowthBytes(new Uint8Array([0xff])), 0) // malformed
  })

  it('page cap, workspace limit with unsaved growth, re-basing on store, unload', async () => {
    const L = await import('../limits')
    const G = await import('./collabGrowth')
    G._resetCollabGrowth()
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 }) // 1 MiB, page cap 256 KiB
    try {
      const KB = 1024
      // 0.22.1 (docs/adr/2548-*): unsaved growth counts with its index rows to come, × 3
      G.noteCollabAuthorised('a', 'w', 0, 200 * KB)
      G.noteCollabAuthorised('b', 'w', 0, 200 * KB)
      assert.equal(G.admitCollabUpdate('a', 'w', 200 * KB, () => 0), 'ok')
      assert.equal(G.admitCollabUpdate('a', 'w', 100 * KB, () => 0), 'page') // 300 KB > 256 KB
      assert.equal(G.admitCollabUpdate('b', 'w', 70 * KB, () => 0), 'ok') // 200 + 270 × 3 = 1010 KB
      assert.equal(G.admitCollabUpdate('b', 'w', 10 * KB, () => 0), 'workspace') // 200 + 280 × 3 > 1024 KB
      assert.equal(G.collabUnsavedBytes('w'), 270 * KB * 3)
      // a store of page a covered its 200 KB: they move from "unsaved" into the cached use (with the estimate)
      G.noteCollabStored('a', 200 * KB, 200 * KB, 800 * KB)
      assert.equal(G.collabUnsavedBytes('w'), 70 * KB * 3)
      assert.equal(G.collabFullInMemory('b', 'w'), false)
      assert.equal(G.admitCollabUpdate('b', 'w', 10 * KB, () => 0), 'workspace') // 800 + 80 × 3 > 1024
      G.noteCollabRefused('b')
      assert.equal(G.collabFullInMemory('b', 'w'), true, 'a refused page authorises read-only')
      G.noteCollabUnloaded('b')
      assert.equal(G.collabUnsavedBytes('w'), 0)
    } finally {
      restore()
      G._resetCollabGrowth()
    }
  })

  it('the next auto version copy is reserved while it may happen', async () => {
    const L = await import('../limits')
    const G = await import('./collabGrowth')
    G._resetCollabGrowth()
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      const KB = 1024
      // a stored body of 200 KB; the workspace uses 800 KB; the next store may copy the 200 KB
      G.noteCollabAuthorised('fresh-page', 'w2', 200 * KB, 800 * KB)
      assert.equal(G.admitCollabUpdate('fresh-page', 'w2', 50 * KB, () => 0), 'workspace') // 800 + 200 copy + 50 × 3 > 1024
      assert.equal(G.admitCollabUpdate('fresh-page', 'w2', 5 * KB, () => 0), 'ok') // 800 + 200 copy + 5 × 3 fits (0.22.1: × 3)
      assert.equal(G.collabUnsavedBytes('w2'), 215 * KB)
    } finally {
      restore()
      G._resetCollabGrowth()
    }
  })

  it('socket guard: the byte rate of an address and the bytes queued for documents it has not opened', async () => {
    const G = await import('./collabGrowth')
    const frame = (name: string, size: number) => {
      const f = new Uint8Array(size)
      const nb = Buffer.from(name)
      f[0] = nb.length
      f.set(nb, 1)
      return f
    }
    const MB = 1024 * 1024
    const g = G.newSocketQueueGuard()
    G.noteSocketConnected(g, 'open')
    for (let i = 0; i < 15; i++) assert.equal(G.admitSocketFrame(g, frame('open', MB)), null)
    assert.equal(G.admitSocketFrame(g, frame('open', 6 * MB)), 'rate', 'past the 16 MB burst at once (a stall under 1.25 s refills less)')
    const q = G.newSocketQueueGuard()
    for (let i = 0; i < 8; i++) assert.equal(G.admitQueuedFrame(q, frame('never', MB)), true)
    assert.equal(G.admitQueuedFrame(q, frame('never', 16)), false, 'past 8 MB queued for a document never opened')
    const r = G.newSocketQueueGuard()
    for (let i = 0; i < 6; i++) G.admitQueuedFrame(r, frame('loading', MB))
    G.noteSocketConnected(r, 'loading') // its queue was replayed: those bytes no longer wait
    assert.equal(r.queued, 0)
    assert.equal(G.admitQueuedFrame(r, frame('loading', MB)), true)
  })
})
