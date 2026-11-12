// What a collab socket may send on every server, with or without limits (0.22.1 N1(b), N1(c), N1 key;
// docs/adr/2541-*, 2542-*). The 0.22.0 re-review ran a 320 MB heap out of memory twice with a signed-in
// account and no limit involved (w22-reports/sec2/collab_raw.mjs):
//  - inbox: Yjs updates into its own `inbox:<id>` document, which Hocuspocus applied and nothing ever
//    stored or dropped (225 MB in 81 s);
//  - awareness: 14,000 new client ids of 16 KB each, from read-only connections too (245 MB in 25 s).
// Here the same pushes are refused and the socket closed, while what the web app does still works:
// notices arrive on the inbox and are read, several people see each other's names and cursors, and a
// closed tab leaves the list. The per-address socket cap counts an IPv6 /64 as one address.
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

// ---- the wire format, written by hand (lib0 is not a dependency of the server) ----
function varUint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}
function bytes(out: number[], b: Uint8Array): void {
  varUint(out, b.length)
  for (const x of b) out.push(x)
}
const text = (s: string) => new TextEncoder().encode(s)
function frame(name: string, type: number, body: (out: number[]) => void): Uint8Array {
  const out: number[] = []
  bytes(out, text(name))
  varUint(out, type)
  body(out)
  return Uint8Array.from(out)
}
const authFrame = (name: string) => frame(name, 2, (o) => { varUint(o, 0); bytes(o, text('cookie')) })
const step1Frame = (name: string) => frame(name, 0, (o) => { varUint(o, 0); bytes(o, Uint8Array.from([0])) })
const updateFrame = (name: string, u: Uint8Array) => frame(name, 0, (o) => { varUint(o, 2); bytes(o, u) })
function awarenessFrame(name: string, entries: [number, number, string][]): Uint8Array {
  return frame(name, 1, (o) => {
    const inner: number[] = []
    varUint(inner, entries.length)
    for (const [id, clock, state] of entries) {
      varUint(inner, id)
      varUint(inner, clock)
      bytes(inner, text(state))
    }
    bytes(o, Uint8Array.from(inner))
  })
}

describe('[db] collab sockets on every server: inbox, awareness, per-address cap (0.22.1 N1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
  const L = await import('./limits')
  const A = await import('./collabAwareness')
  const collab = await import('./collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  let server: ReturnType<typeof createServer>
  let port = 0
  const open: { destroy?: () => void; terminate?: () => void }[] = []
  before(async () => {
    server = createServer((_r, s) => s.end())
    collab.attachCollab(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  after(async () => {
    for (const c of open) c.destroy ? c.destroy() : c.terminate?.()
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  interface Raw {
    ws: InstanceType<typeof WebSocket>
    closed: string | null
    got: Buffer[]
  }
  /** A raw socket like the review's script (no provider), optionally from another address through the trusted loopback proxy. */
  const raw = (cookie: string, xff?: string): Promise<Raw> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?schema=2`, { headers: { cookie, ...(xff ? { 'x-forwarded-for': xff } : {}) } })
      const r: Raw = { ws, closed: null, got: [] }
      open.push(ws)
      ws.on('close', (code, reason) => (r.closed = `${code} ${reason}`))
      ws.on('message', (d: Buffer) => r.got.push(d))
      ws.on('error', () => {})
      ws.on('open', () => resolve(r))
      ws.on('unexpected-response', (_q, res) => reject(new Error(`upgrade ${res.statusCode}`)))
    })
  /** Open a document on a raw socket and wait for its Authenticated message. */
  const openDoc = async (r: Raw, name: string) => {
    const before = r.got.length
    r.ws.send(authFrame(name))
    await until(() => r.got.slice(before).some((m) => m.includes(Buffer.from(name)) && m[1 + name.length] === 2), `auth of ${name}`)
    r.ws.send(step1Frame(name))
    await sleep(100)
  }

  const socketFor = (cookie: string) => {
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } })
      }
    }
    const s = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    open.push(s)
    return s
  }

  it('R-N1b: updates pushed into the own inbox document are never applied, and the socket is closed', async () => {
    const u = await h.makeUser('n1b-push')
    const name = `inbox:${u.id}`
    const r = await raw(u.cookie)
    await openDoc(r, name)
    const doc = new Y.Doc()
    let sent = 0
    // the review pushed 3 MB a second until the server died; ten 0.9 MB updates here
    for (let i = 0; i < 10 && r.ws.readyState === WebSocket.OPEN; i++) {
      const sv = Y.encodeStateVector(doc)
      doc.getText('t').insert(0, randomBytes(700_000).toString('base64'))
      const u2 = Y.encodeStateAsUpdate(doc, sv)
      r.ws.send(updateFrame(name, u2))
      sent += u2.length
      await sleep(30)
    }
    await until(() => r.closed !== null, 'the socket to close')
    const live = collab.hocuspocus.documents.get(name)
    const held = live ? Y.encodeStateAsUpdate(live).length : 0
    console.log(`[N1b] pushed ${(sent / 1048576).toFixed(1)} MB into the inbox; socket ${r.closed}; the inbox document holds ${held} bytes`)
    assert.ok(held <= 2, `the inbox document holds ${held} bytes`)
    assert.ok(sent < 3 * 1024 * 1024, 'closed after the first updates, not after all of them')
  })

  it('the inbox still carries notices: one arrives, the list shows it, it is marked read (the web app’s flow)', async () => {
    const a = await h.makeUser('n1b-a')
    const b = await h.makeUser('n1b-b')
    await h.makeWorkspace(a, [b]) // so a may add b to another workspace directly
    const ws2 = await h.makeWorkspace(a)
    const doc = new Y.Doc()
    const notices: string[] = []
    let scope = ''
    const sock = socketFor(b.cookie)
    let closes = 0
    sock.on('close', () => closes++)
    const provider = new HocuspocusProvider({
      websocketProvider: sock,
      name: `inbox:${b.id}`,
      document: doc,
      token: 'cookie',
      broadcast: false,
      onStateless: ({ payload }: { payload: string }) => notices.push(payload),
      onAuthenticated: () => (scope = provider.authorizedScope),
    })
    open.push(provider)
    await until(() => provider.isSynced, 'the inbox to sync')
    assert.equal(scope, 'readonly', 'the inbox connection is read-only')
    const add = await app.inject({ method: 'POST', url: `/api/workspaces/${ws2.id}/members`, headers: { cookie: a.cookie }, payload: { userId: b.id } })
    assert.equal(add.statusCode, 200, add.body)
    await until(() => notices.some((n) => JSON.parse(n).t === 'notifications'), 'the notice on the inbox')
    const list = (await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: b.cookie } })).json() as { unread: number; notifications: { id: string }[] }
    assert.ok(list.unread >= 1, 'the notification is listed unread')
    const read = await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie: b.cookie }, payload: {} })
    assert.equal(read.statusCode, 200, read.body)
    const after = (await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: b.cookie } })).json() as { unread: number }
    assert.equal(after.unread, 0)
    assert.equal(closes, 0, 'the inbox socket was never closed')
    assert.equal(sock.status, 'connected')
  })

  it('R-N1c: awareness floods are refused before they are applied, read-only connections included', async () => {
    const owner = await h.makeUser('n1c-owner')
    const reader = await h.makeUser('n1c-reader')
    const ws = await h.makeWorkspace(owner, [reader])
    const page = await h.makeDocPage(ws.id, owner.id, 'locked', [] as never)
    const lock = await app.inject({ method: 'PUT', url: `/api/pages/${page.id}/lock`, headers: { cookie: owner.cookie }, payload: { locked: true } })
    assert.equal(lock.statusCode, 200, lock.body)
    const refusedBefore = A.awarenessStats.refused
    const state = JSON.stringify({ user: { name: 'x', blob: randomBytes(12_000).toString('base64') } }) // 16 KB, as the review sent

    // the owner keeps the page open throughout, so what the others leave behind stays visible
    const keeper = await raw(owner.cookie)
    await openDoc(keeper, page.id)
    // the review's frame: 90 new ids of 16 KB each (1.4 MB)
    const r1 = await raw(reader.cookie)
    await openDoc(r1, page.id)
    assert.deepEqual(collab.hocuspocus.documents.get(page.id)!.getConnections().map((c) => c.readOnly).sort(), [false, true], 'the reader is read-only')
    let next = 1_000_000
    const flood = () => Array.from({ length: 90 }, (): [number, number, string] => [next++, 1, state])
    r1.ws.send(awarenessFrame(page.id, flood()))
    await until(() => r1.closed !== null, 'the flooding socket to close')

    // within the message size: a fifth client id on one connection
    const r2 = await raw(reader.cookie)
    await openDoc(r2, page.id)
    const small = JSON.stringify({ user: { name: 'r', color: '#000' } })
    for (let i = 0; i < 4; i++) r2.ws.send(awarenessFrame(page.id, [[2_000_000 + i, 1, small]]))
    await sleep(200)
    assert.equal(r2.closed, null, 'four ids are fine')
    r2.ws.send(awarenessFrame(page.id, [[2_000_010, 1, small]]))
    await until(() => r2.closed !== null, 'the fifth id to close the socket')

    // one state past 16 KB
    const r3 = await raw(reader.cookie)
    await openDoc(r3, page.id)
    r3.ws.send(awarenessFrame(page.id, [[3_000_000, 1, JSON.stringify({ blob: 'x'.repeat(17 * 1024) })]]))
    await until(() => r3.closed !== null, 'the large state to close the socket')

    const live = collab.hocuspocus.documents.get(page.id)
    const states = live ? (live as unknown as { awareness: { states: Map<number, unknown>; meta: Map<number, unknown> } }).awareness : null
    console.log(`[N1c] refused ${A.awarenessStats.refused - refusedBefore}; states kept ${states?.states.size ?? 0}; clock records ${states?.meta.size ?? 0}`)
    assert.ok(A.awarenessStats.refused - refusedBefore >= 3)
    assert.ok(states, 'the page is still open')
    assert.equal(states.states.size, 0, 'no state of a closed socket is kept')
    // its clock records stay a minute (an echo of the removal must still find them, ADR 2552), then go
    A.sweepAwarenessMeta(states as never, Date.now() + A.AWARENESS_META_KEEP_MS + 1, true)
    assert.ok(states.meta.size <= 1, 'nor its clock records once swept (the server keeps its own)')
    // and closing over and over leaves nothing behind either
    for (let k = 0; k < 5; k++) {
      const r = await raw(reader.cookie)
      await openDoc(r, page.id)
      r.ws.send(awarenessFrame(page.id, [[4_000_000 + k, 1, small]]))
      await sleep(50)
      r.ws.close()
      await until(() => r.closed !== null, 'close')
    }
    await sleep(200)
    const aw = (collab.hocuspocus.documents.get(page.id) as unknown as { awareness: { meta: Map<number, unknown> } }).awareness
    A.sweepAwarenessMeta(aw as never, Date.now() + A.AWARENESS_META_KEEP_MS + 1, true)
    const meta = aw.meta.size
    assert.ok(meta <= 1, `clock records after five connect-and-close rounds, swept: ${meta}`)
    assert.equal(keeper.closed, null, 'the owner was never disconnected')
    keeper.ws.close()
  })

  it('several people on one page see each other’s names and cursors, and a closed tab leaves the list', async () => {
    const refusedBefore = A.awarenessStats.refused
    const owner = await h.makeUser('n1c-a')
    const b = await h.makeUser('n1c-b')
    const c = await h.makeUser('n1c-c')
    const ws = await h.makeWorkspace(owner, [b, c])
    const page = await h.makeDocPage(ws.id, owner.id, 'shared', [] as never)
    const people = [owner, b, c].map((u) => {
      const doc = new Y.Doc()
      const provider = new HocuspocusProvider({ websocketProvider: socketFor(u.cookie), name: page.id, document: doc, token: 'cookie', broadcast: false })
      open.push(provider)
      return { u, doc, provider }
    })
    await until(() => people.every((p) => p.provider.isSynced), 'everyone synced')
    for (const p of people) {
      // what the editor sets: BlockNote's user (name, colour, account id) and y-prosemirror's cursor
      p.provider.setAwarenessField('user', { name: p.u.name, color: '#30bced', id: p.u.id })
      p.doc.getXmlFragment('document')
      p.provider.setAwarenessField('cursor', {
        anchor: { type: { client: p.doc.clientID, clock: 0 }, tname: null, item: null, assoc: 0 },
        head: { type: { client: p.doc.clientID, clock: 0 }, tname: null, item: null, assoc: 0 },
      })
    }
    const names = (p: (typeof people)[number]) =>
      [...p.provider.awareness.getStates().values()].map((s: { user?: { name?: string } }) => s.user?.name).filter(Boolean).sort()
    await until(() => people.every((p) => names(p).length === 3), 'everyone sees three people')
    assert.deepEqual(names(people[0]), ['n1c-a', 'n1c-b', 'n1c-c'])
    assert.ok([...people[1].provider.awareness.getStates().values()].every((s: { cursor?: unknown }) => s.cursor), 'cursors arrive')
    const largest = A.awarenessStats.largestState
    // a tab closes
    people[2].provider.destroy()
    await until(() => names(people[0]).length === 2 && names(people[1]).length === 2, 'the closed tab leaves')
    assert.equal(A.awarenessStats.refused, refusedBefore, 'nothing refused')
    console.log(`[N1c] an editor's awareness state: ${largest} bytes (cap ${A.AWARENESS_MAX_STATE_BYTES})`)
  })

  it('R-N1 key: the per-address socket cap counts an IPv6 /64 as one address (every server: the cap is)', async () => {
    assert.equal(L.limits.workspaceStorageMb, null, 'no limit set: this holds for every server')
    const u = await h.makeUser('n1-key')
    const sockets: Raw[] = []
    // 40 sockets from 40 addresses of one /64 (MAX_CONN_PER_IP), the review's way: X-Forwarded-For through the loopback proxy
    for (let i = 1; i <= 40; i++) {
      sockets.push(await raw(u.cookie, `2001:db8:77:1::${i.toString(16)}`))
    }
    await assert.rejects(raw(u.cookie, '2001:db8:77:1::ffff'), /upgrade 429/, 'a 41st address of the same /64 is refused')
    const other = await raw(u.cookie, '2001:db8:77:2::1') // the next /64 is someone else
    assert.equal(other.ws.readyState, WebSocket.OPEN)
    // and the count goes back down as sockets close
    sockets[0].ws.close()
    await until(() => sockets[0].closed !== null, 'close')
    await sleep(100)
    const again = await raw(u.cookie, '2001:db8:77:1::fffe')
    assert.equal(again.ws.readyState, WebSocket.OPEN)
    for (const s of [...sockets, other, again]) s.ws.close()
  })
})
