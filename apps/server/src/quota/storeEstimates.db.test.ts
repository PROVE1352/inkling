// The storage limit where live editing and the store's index estimate meet (0.22.1, docs/adr/2548-*, 2549-*).
// Measured on the merged 0.22.1 tree with the demo preset (w22-reports/merged): the collab socket ended at
// 214–317 % of a 10 MB limit once indexed, a workspace's first store was counted as 0 for 40 s, an early
// recount wiped the index estimate, and a workspace flipped over its limit closed the web app's editor with
// 4403 permission-changed, which Chrome never reconnected without a reload. Each case below is deterministic:
// no test waits for a timer of the code under test (the upsert is held back with a row lock instead).
//  1. admission counts unsaved growth with its index rows (STORE_BYTES_PER_UNSAVED_BYTE);
//  2. a store that finds the cache stale recounts after its upsert is in (REST once, collab store once);
//  3. a recount before the index pass keeps the store's estimate; one after the pass drops it;
//  4. going over the limit makes editing connections read-only with an ordinary close (4000 storage-full),
//     and they edit again once a recount finds room, without a new provider;
//  5. without a storage limit none of it runs.
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

describe('[db] store estimates and live editing against the storage limit (0.22.1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const S = await import('./storage')
  const G = await import('./collabGrowth')
  const collab = await import('../collab')
  const D = await import('../docIndexer')
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

  /** Waits for a condition the test itself causes (never for a timer of the code under test). */
  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const settled = async () => {
    // the hook tracks recounts started by recountSoon (the stale store's, a refusal's)
    await (S as { storageRecountsSettled?: () => Promise<void> }).storageRecountsSettled?.()
  }
  const cached = async (ws: string) =>
    Number(((await db.execute(sql`SELECT storage_bytes AS n FROM workspaces WHERE id = ${ws}`)) as unknown as { n: string }[])[0].n)
  const bodies = async (ws: string) =>
    Number(
      (
        (await db.execute(sql`
          SELECT coalesce(sum(octet_length(state) + coalesce(octet_length(state_vector), 0)), 0)::bigint AS n
            FROM page_docs WHERE page_id IN (SELECT id FROM pages WHERE workspace_id = ${ws})
        `)) as unknown as { n: string }[]
      )[0].n,
    )
  const word = () => randomBytes(6).toString('base64').replace(/[^a-z]/gi, 'q').slice(0, 2 + Math.floor(Math.random() * 7)).toLowerCase()
  const prose = (bytes: number) => Array.from({ length: Math.ceil(bytes / 480) }, () => Array.from({ length: 80 }, word).join(' ')).join('\n\n').slice(0, bytes)
  /** BlockNote paragraphs appended to a document's body, as the editor writes them. */
  const appendParagraphs = (doc: InstanceType<typeof Y.Doc>, bytes: number) => {
    const f = doc.getXmlFragment('document')
    doc.transact(() => {
      let g = f.length ? (f.get(0) as InstanceType<typeof Y.XmlElement>) : null
      if (!g) {
        g = new Y.XmlElement('blockGroup')
        f.insert(0, [g as never])
      }
      const nodes = prose(bytes)
        .split('\n\n')
        .map((p, i) => {
          const c = new Y.XmlElement('blockContainer')
          c.setAttribute('id', `b-${i}-${randomBytes(4).toString('hex')}`)
          const para = new Y.XmlElement('paragraph')
          const t = new Y.XmlText()
          t.insert(0, p)
          para.insert(0, [t])
          c.insert(0, [para])
          return c
        })
      g.insert(g.length, nodes as never)
    })
  }

  /**
   * Holds the page's page_docs row (SELECT … FOR UPDATE in a transaction of its own) until release():
   * a store's upsert of that page waits on it, so whatever the store starts beside its upsert runs first.
   */
  const holdPageDocs = async (pageId: string) => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const tx = db.transaction(async (t) => {
      await t.execute(sql`SELECT 1 FROM page_docs WHERE page_id = ${pageId} FOR UPDATE`)
      locked()
      await gate
    })
    await isLocked
    return { release: async () => (release(), await tx) }
  }
  const upsertWaiting = async () =>
    Number(
      (
        (await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO page_docs%'
        `)) as unknown as { n: number }[]
      )[0].n,
    ) > 0

  it('1. admission counts unsaved growth with its index rows to come', async () => {
    G._resetCollabGrowth()
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 }) // 1 MiB, page cap 256 KiB
    try {
      const KB = 1024
      G.noteCollabAuthorised('e1', 'we', 0, 0)
      G.noteCollabAuthorised('e2', 'we', 0, 0)
      assert.equal(G.admitCollabUpdate('e1', 'we', 200 * KB, () => 0), 'ok')
      assert.equal(G.admitCollabUpdate('e2', 'we', 140 * KB, () => 0), 'ok') // 340 KB × 3 = 1020 KB
      assert.equal(G.admitCollabUpdate('e2', 'we', 10 * KB, () => 0), 'workspace') // 350 KB × 3 > 1024 KB
      assert.equal(G.collabUnsavedBytes('we'), 340 * KB * 3)
    } finally {
      restore()
      G._resetCollabGrowth()
    }
  })

  it('2a. a REST write into a workspace whose cache is stale: the recount sees the new body', async () => {
    const u = await h.makeUser('est-rest')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'rest', [{ type: 'paragraph', content: 'a' } as never])
    const restore = L.setLimitsForTests({ workspaceStorageMb: 10 })
    try {
      await db.execute(sql`UPDATE workspaces SET storage_checked_at = NULL WHERE id = ${ws.id}`)
      const hold = await holdPageDocs(page.id)
      const req = app.inject({ method: 'POST', url: `/api/pages/${page.id}/content`, headers: { cookie: u.cookie }, payload: { markdown: prose(150_000), mode: 'append' } })
      await until(upsertWaiting, 'the store to reach its upsert')
      await settled() // anything the store started beside its upsert has finished
      await hold.release()
      const r = await req
      assert.equal(r.statusCode, 200, r.body)
      await settled()
      const body = await bodies(ws.id)
      assert.ok(body > 150_000, `the body is stored: ${body}`)
      const c = await cached(ws.id)
      assert.ok(c >= body, `the cache (${c}) holds at least the stored bodies (${body})`)
    } finally {
      restore()
    }
  })

  it('2b. a collab store into a workspace whose cache is stale: the recount sees the new body', async () => {
    const u = await h.makeUser('est-collab')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'collab', [{ type: 'paragraph', content: 'a' } as never])
    const restore = L.setLimitsForTests({ workspaceStorageMb: 10 })
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await db.execute(sql`UPDATE workspaces SET storage_checked_at = NULL WHERE id = ${ws.id}`)
      const doc = collab.hocuspocus.documents.get(page.id)!
      appendParagraphs(doc, 150_000) // as a socket's update would (no DirectConnection store)
      const hold = await holdPageDocs(page.id)
      const store = collab.hocuspocus.storeDocumentHooks(
        doc,
        { documentName: page.id, document: doc, socketId: 'socket-1', context: {}, instance: collab.hocuspocus } as never,
        true,
      )
      await until(upsertWaiting, 'the store to reach its upsert')
      await settled()
      await hold.release()
      await store
      await settled()
      const body = await bodies(ws.id)
      assert.ok(body > 150_000, `the body is stored: ${body}`)
      const c = await cached(ws.id)
      assert.ok(c >= body, `the cache (${c}) holds at least the stored bodies (${body})`)
    } finally {
      await conn.disconnect()
      restore()
    }
  })

  it('3. a recount before the index pass keeps the store estimate; one after the pass drops it', async () => {
    const u = await h.makeUser('est-index')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'index', [{ type: 'paragraph', content: 'a' } as never])
    const restore = L.setLimitsForTests({ workspaceStorageMb: 10 })
    const conn = await collab.hocuspocus.openDirectConnection(page.id)
    try {
      await S.recountWorkspaceStorage(ws.id) // a fresh cache: the store below does not recount itself
      const body0 = (await S.countWorkspaceStorage(db, ws.id)).total
      const doc = collab.hocuspocus.documents.get(page.id)!
      appendParagraphs(doc, 200_000)
      // a socket's store: its index pass is debounced (docIndexer.ts), so its rows are not written yet
      await collab.hocuspocus.storeDocumentHooks(
        doc,
        { documentName: page.id, document: doc, socketId: 'socket-2', context: {}, instance: collab.hocuspocus } as never,
        true,
      )
      const growth = (await S.countWorkspaceStorage(db, ws.id)).total - body0
      assert.ok(growth > 150_000, `the body grew: ${growth}`)
      assert.equal(D.docIndexIdle(page.id), false, 'the index pass is still pending')
      // an early recount (a refusal's, the settings screen's): the estimate of the rows to come stays
      const early = await S.recountWorkspaceStorage(ws.id)
      const measured = (await S.countWorkspaceStorage(db, ws.id)).total
      const kept = (await cached(ws.id)) - measured
      assert.ok(kept >= G.INDEX_BYTES_PER_BODY_BYTE * growth * 0.9, `the index estimate kept: ${kept} for a growth of ${growth}`)
      assert.equal(early.total, await cached(ws.id))
      // the pass writes the rows; the next recount counts them and drops the estimate
      await D.flushDocIndex(page.id)
      await S.recountWorkspaceStorage(ws.id)
      const after = await cached(ws.id)
      const now = (await S.countWorkspaceStorage(db, ws.id)).total
      // (a few bytes may move between the two reads: page rows and pg_column_size, not the estimate)
      assert.ok(Math.abs(after - now) < 4096, `after the pass the cache is the count: ${after} vs ${now}`)
    } finally {
      await conn.disconnect()
      restore()
    }
  })

  it('4. over the limit: editing connections reconnect read-only (4000 storage-full) and edit again once there is room', async () => {
    const u = await h.makeUser('est-close')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'close', [{ type: 'paragraph', content: 'a' } as never])
    await S.recountWorkspaceStorage(ws.id)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 0.05 })
    try {
      await S.recountWorkspaceStorage(ws.id)
      class CookieSocket extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie: u.cookie } })
        }
      }
      const closes: { code: number; reason: string }[] = []
      const stateless: string[] = []
      const scopes: string[] = []
      let denied = 0
      let synced = 0
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
      socket.on('close', (e: { event?: { code: number; reason: string } }) => closes.push({ code: e?.event?.code ?? -1, reason: e?.event?.reason ?? '' }))
      const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: page.id,
        document: new Y.Doc(),
        token: 'cookie',
        broadcast: false,
        onAuthenticated: () => scopes.push(provider.authorizedScope),
        onAuthenticationFailed: () => denied++,
        onStateless: ({ payload }: { payload: string }) => stateless.push(payload),
        onSynced: () => synced++,
      })
      open.push(provider, socket)
      // synced, not only authenticated: the server adds the connection to the document after loading it
      await until(() => scopes.length === 1 && synced >= 1, 'the first sync')
      assert.equal(scopes[0], 'read-write')
      // a store that takes the cache past the limit (the body grew by 100 kB)
      await S.noteBodyStore(page.id, 100_000)
      await until(() => closes.length >= 1 && scopes.length >= 2, `the reconnect (closes ${JSON.stringify(closes)}, scopes ${scopes}, denied ${denied}, cache ${await cached(ws.id)}, live ${JSON.stringify(collab.hocuspocus.documents.get(page.id)?.getConnections().map((c) => c.readOnly))})`)
      assert.deepEqual(closes[0], { code: 4000, reason: 'storage-full' })
      assert.equal(denied, 0, 'not told that access changed')
      assert.ok(stateless.some((p) => JSON.parse(p).t === 'storage'), JSON.stringify(stateless))
      assert.equal(scopes.at(-1), 'readonly')
      // room again: the same provider edits again without a reload
      await db.execute(sql`UPDATE workspaces SET storage_bytes = 0 WHERE id = ${ws.id}`)
      S._resetStoreEstimates?.()
      restore()
      const restore2 = L.setLimitsForTests({ workspaceStorageMb: 10 })
      try {
        await S.recountWorkspaceStorage(ws.id)
        await until(() => scopes.at(-1) === 'read-write', 'editing again')
      } finally {
        restore2()
      }
    } finally {
      restore()
    }
  })

  it('5. without a storage limit: no estimate, no turn, no close (the 0.21.1 path)', async () => {
    assert.equal(L.limits.workspaceStorageMb, null)
    const u = await h.makeUser('est-plain')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'plain', [{ type: 'paragraph', content: 'a' } as never])
    await db.execute(sql`UPDATE workspaces SET storage_bytes = 4321, storage_checked_at = NULL WHERE id = ${ws.id}`)
    const r = await app.inject({ method: 'POST', url: `/api/pages/${page.id}/content`, headers: { cookie: u.cookie }, payload: { markdown: prose(50_000), mode: 'append' } })
    assert.equal(r.statusCode, 200, r.body)
    await settled()
    assert.equal(await cached(ws.id), 4321, 'the store moved no cache and started no recount')
    assert.equal((S as { unseenEstimateBytes?: (w: string) => number }).unseenEstimateBytes?.(ws.id) ?? 0, 0)
    assert.equal(G.collabUnsavedBytes(ws.id), 0)
  })
})
