// Awareness with the web app's own provider (0.22.1 fix 5, docs/adr/2552-*). @hocuspocus/provider 2.15.3
// sends back every awareness change it applies, other people's included (`awarenessUpdateHandler`), so the
// 0.22.1 cap of four ids per document connection closed ordinary sockets: five tabs on one page were
// closed 46–50 times in 10 s, and a long-open tab was closed once its neighbour had been reopened four
// times (third security review, w22-reports/sec3/aw_echo.mjs). Now an id counts only against the
// connection that brought it into the document. Ordinary use, judged by socket closes and states seen:
//  - 5, 8 and 12 tabs on one page see each other and every keystroke arrives;
//  - a tab reopened 20 times next to a long-open one;
//  - one socket opening 20 pages one after another, and 8 at once, with someone else on each;
//  - a read-only member, a guest, and five tabs with only the inbox open.
// The floods stay refused, including the ways the new rule could be abused (ids swapped between two
// sockets, ids kept alive by a socket that did not bring them in, new ids without end).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
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
const webDir = path.resolve(process.cwd(), '../web')
// the provider the web app ships (apps/web's dependency, 2.15.3)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

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

describe('[db] awareness with the real provider: echoes never close a socket, floods still do (0.22.1 fix 5)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
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

  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 30_000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** A tab: one shared socket (lib/collabSocket.ts), its closes counted. Each tab its own /64, like separate people. */
  let net = 100
  const newSocket = (cookie: string) => {
    const xff = `2001:db8:${(net++).toString(16)}::1`
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie, 'x-forwarded-for': xff } })
      }
    }
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab?schema=2`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    const s = { socket, closes: 0 }
    socket.on('close', () => s.closes++)
    open.push(socket)
    return s
  }
  type Sock = ReturnType<typeof newSocket>
  /** A document on a socket with the editor's awareness: BlockNote's user and y-prosemirror's cursor. */
  const openDoc = (s: Sock, name: string, who: string, editorFields = true) => {
    const doc = new Y.Doc()
    let synced = false
    // preserveConnection: as the web app's shared socket does (lib/collabSocket.ts), a closed document keeps the socket
    const provider = new HocuspocusProvider({ websocketProvider: s.socket, name, document: doc, token: 'cookie', broadcast: false, preserveConnection: true, onSynced: () => (synced = true) })
    open.push(provider)
    const cursor = (n: number) => ({
      anchor: { type: { client: doc.clientID, clock: n }, tname: null, item: null, assoc: 0 },
      head: { type: { client: doc.clientID, clock: n }, tname: null, item: null, assoc: 0 },
    })
    if (editorFields) {
      provider.setAwarenessField('user', { name: who, color: '#30bced', id: who })
      provider.setAwarenessField('cursor', cursor(0))
    }
    return {
      doc,
      provider,
      synced: () => synced,
      move: (n: number) => provider.setAwarenessField('cursor', cursor(n)),
      names: () => [...provider.awareness.getStates().values()].map((st: { user?: { name?: string } }) => st.user?.name).filter(Boolean) as string[],
    }
  }
  const closesOf = (socks: Sock[]) => socks.reduce((n, s) => n + s.closes, 0)

  async function tabsOnOnePage(n: number) {
    const refused = A.awarenessStats.refused
    const owner = await h.makeUser(`echo${n}-owner`)
    const others = await Promise.all(Array.from({ length: n - 1 }, (_, i) => h.makeUser(`echo${n}-p${i}`)))
    const ws = await h.makeWorkspace(owner, others)
    const page = await h.makeDocPage(ws.id, owner.id, 'together', [] as never)
    const people = [owner, ...others]
    const socks: Sock[] = []
    const tabs: ReturnType<typeof openDoc>[] = []
    const changed0 = A.awarenessStats.changedBytes
    const t0 = Date.now()
    for (const [i, u] of people.entries()) {
      const s = newSocket(u.cookie)
      socks.push(s)
      tabs.push(openDoc(s, page.id, `person ${i}`))
      await sleep(100)
    }
    await until(() => tabs.every((t) => t.synced()), 'everyone synced')
    await until(() => tabs.every((t) => t.names().length === n), `everyone sees ${n} people`)
    // everyone moves the cursor and types a few times: each change is echoed by every other tab
    for (let round = 0; round < 5; round++) {
      for (const [i, t] of tabs.entries()) {
        t.move(round + 1)
        t.doc.getText('t').insert(0, `${i}.`)
      }
      await sleep(200)
    }
    const expected = tabs.reduce((len, _t, i) => len + `${i}.`.length * 5, 0)
    await until(() => tabs.every((t) => t.doc.getText('t').length === expected), 'every keystroke everywhere')
    await sleep(1000)
    const seen = tabs.map((t) => t.names().length)
    const rate = (A.awarenessStats.changedBytes - changed0) / n / ((Date.now() - t0) / 1000)
    console.log(`[fix5] ${n} tabs on one page: socket closes ${closesOf(socks)}; each sees ${JSON.stringify(seen)}; most ids one connection brought in ${A.awarenessStats.mostOwned}; largest echo ${A.awarenessStats.largestMessage} B; changed state bytes per socket ${rate.toFixed(0)} B/s`)
    assert.equal(closesOf(socks), 0, 'no socket closed')
    assert.ok(seen.every((k) => k === n), 'each tab sees everyone')
    assert.equal(A.awarenessStats.refused, refused, 'nothing refused')
    for (const t of tabs) t.provider.destroy()
    for (const s of socks) s.socket.destroy()
  }

  it('5 tabs on one page', async () => tabsOnOnePage(5))
  it('8 tabs on one page', async () => tabsOnOnePage(8))
  it('12 tabs on one page', async () => tabsOnOnePage(12))

  it('a tab reopened 20 times next to a long-open one: neither is closed', async () => {
    const refused = A.awarenessStats.refused
    const a = await h.makeUser('reopen-a')
    const b = await h.makeUser('reopen-b')
    const ws = await h.makeWorkspace(a, [b])
    const page = await h.makeDocPage(ws.id, a.id, 'long open', [] as never)
    const sa = newSocket(a.cookie)
    const ta = openDoc(sa, page.id, 'A')
    await until(() => ta.synced(), 'A synced')
    const bSocks: Sock[] = []
    for (let k = 0; k < 20; k++) {
      const sb = newSocket(b.cookie) // a reload: a new socket and a new Y.Doc (a new client id)
      bSocks.push(sb)
      const tb = openDoc(sb, page.id, `B${k}`)
      await until(() => ta.names().includes(`B${k}`) && tb.names().includes('A'), `B${k} and A see each other`)
      ta.move(k + 1)
      tb.provider.destroy()
      sb.socket.destroy()
      await until(() => !ta.names().includes(`B${k}`), `B${k} leaves`)
    }
    console.log(`[fix5] B reopened 20 times: A's socket closes ${sa.closes}; A sees ${JSON.stringify(ta.names())}`)
    assert.equal(sa.closes, 0)
    assert.deepEqual(ta.names(), ['A'])
    assert.equal(A.awarenessStats.refused, refused, 'nothing refused')
  })

  it('one socket opens 20 pages one after another, then 8 at once, with someone else on each', async () => {
    const refused = A.awarenessStats.refused
    const me = await h.makeUser('multi-me')
    const other = await h.makeUser('multi-other')
    const ws = await h.makeWorkspace(me, [other])
    const pages = await Promise.all(Array.from({ length: 28 }, (_, i) => h.makeDocPage(ws.id, me.id, `p${i}`, [] as never)))
    const mine = newSocket(me.cookie)
    const theirs = newSocket(other.cookie)
    // the web app keeps the inbox open on every tab's socket (AppLayout): Hocuspocus closes a socket whose
    // last document closes, which is not what this test is about
    const myInbox = openDoc(mine, `inbox:${me.id}`, 'inbox', false)
    await until(() => myInbox.synced(), 'my inbox')
    const theirTabs = pages.map((p) => openDoc(theirs, p.id, 'other'))
    await until(() => theirTabs.every((t) => t.synced()), 'the other person on every page')
    for (const p of pages.slice(0, 20)) {
      const t = openDoc(mine, p.id, 'me')
      await until(() => t.synced() && t.names().length === 2, `${p.id} seen by both`)
      t.move(1)
      await sleep(50)
      t.provider.destroy()
    }
    const at = pages.slice(20).map((p) => openDoc(mine, p.id, 'me'))
    await until(() => at.every((t) => t.synced() && t.names().length === 2), '8 pages at once')
    for (const t of at) t.move(2)
    await sleep(1000)
    console.log(`[fix5] one socket, 20 pages in turn and 8 at once: closes ${mine.closes} / ${theirs.closes}`)
    assert.equal(mine.closes, 0)
    assert.equal(theirs.closes, 0)
    assert.equal(A.awarenessStats.refused, refused, 'nothing refused')
    for (const t of [...at, ...theirTabs, myInbox]) t.provider.destroy()
  })

  it('a read-only member, a guest and five tabs with only the inbox are never closed', async () => {
    const refused = A.awarenessStats.refused
    const owner = await h.makeUser('ro-owner')
    const reader = await h.makeUser('ro-reader')
    const guest = await h.makeUser('ro-guest')
    const ws = await h.makeWorkspace(owner, [reader])
    const page = await h.makeDocPage(ws.id, owner.id, 'locked', [] as never)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/pages/${page.id}/lock`, headers: { cookie: owner.cookie }, payload: { locked: true } })).statusCode, 200)
    // the people route is not in the test harness: a small app with it, as guests.db.test.ts does
    const Fastify = (await import('fastify')).default
    const acc = Fastify()
    await acc.register((await import('@fastify/cookie')).default)
    await acc.register(async (api) => (await import('./routes/pageAccess')).registerPageAccessRoutes(api), { prefix: '/api' })
    const g = await acc.inject({ method: 'PUT', url: `/api/pages/${page.id}/access`, headers: { cookie: owner.cookie }, payload: { userId: guest.id, level: 'view' } })
    await acc.close()
    assert.equal(g.statusCode, 200, g.body)
    const socks = [owner, reader, guest].map((u) => newSocket(u.cookie))
    const tabs = [owner, reader, guest].map((u, i) => openDoc(socks[i], page.id, u.name))
    await until(() => tabs.every((t) => t.synced() && t.names().length === 3), 'all three see each other')
    assert.equal(tabs[1].provider.authorizedScope, 'readonly')
    assert.equal(tabs[2].provider.authorizedScope, 'readonly')
    for (let r = 0; r < 5; r++) {
      for (const t of tabs) t.move(r)
      await sleep(100)
    }
    // the inbox: what AppLayout opens in every tab, with no awareness field set
    const inboxSocks = Array.from({ length: 5 }, () => newSocket(owner.cookie))
    const inbox = inboxSocks.map((s) => openDoc(s, `inbox:${owner.id}`, 'inbox', false))
    await until(() => inbox.every((t) => t.synced() && t.provider.awareness.getStates().size === 5), 'five inbox tabs see five states')
    await sleep(1000)
    const all = [...socks, ...inboxSocks]
    console.log(`[fix5] read-only, guest, 5 inbox tabs: closes ${closesOf(all)}`)
    assert.equal(closesOf(all), 0)
    assert.equal(A.awarenessStats.refused, refused, 'nothing refused')
    for (const t of [...tabs, ...inbox]) t.provider.destroy()
  })

  it('a provider brings in one id per document connection: new tab, reconnect, back from offline', async () => {
    const u = await h.makeUser('own-ids')
    const v = await h.makeUser('own-ids-other')
    const ws = await h.makeWorkspace(u, [v])
    const page = await h.makeDocPage(ws.id, u.id, 'ids', [] as never)
    // someone else stays on the page, so it stays loaded and keeps its clock records
    const sv = newSocket(v.cookie)
    const tv = openDoc(sv, page.id, 'other')
    const s = newSocket(u.cookie)
    const t = openDoc(s, page.id, 'me')
    await until(() => t.synced() && t.names().length === 2, 'synced')
    const owned = A.awarenessStats.mostOwned
    const live = () => collab.hocuspocus.documents.get(page.id)!
    const before = A.awarenessStats.newIds
    // reconnect: the server closes the socket; the provider comes back with the same Y.Doc
    const mine = live().getConnections().find((c) => (c.context as { userId?: string }).userId === u.id)!
    ;(mine as unknown as { webSocket: { close: () => void } }).webSocket.close()
    await until(() => s.closes === 1 && t.synced() && live().getConnections().length === 2, 'reconnected')
    // offline and back: the socket goes away and comes back while the tab keeps editing
    s.socket.disconnect()
    t.doc.getText('t').insert(0, 'typed offline')
    t.move(5)
    await sleep(200)
    await s.socket.connect()
    await until(() => live().getText('t').toString() === 'typed offline', 'back online')
    await sleep(300)
    const states = (live() as unknown as { awareness: { states: Map<number, unknown> } }).awareness.states
    console.log(`[fix5] own ids: after a reconnect and an offline return the page holds ${states.size} states; new ids recorded ${A.awarenessStats.newIds - before}; most ids one connection brought in ${A.awarenessStats.mostOwned}`)
    assert.equal(states.size, 2, 'one id each: the tab’s own and the other person’s')
    assert.equal(A.awarenessStats.newIds - before, 0, 'the same id comes back: no new clock record')
    assert.ok(A.awarenessStats.mostOwned <= Math.max(owned, 1))
    assert.equal(sv.closes, 0)
    t.provider.destroy()
    tv.provider.destroy()
  })

  // ---- floods ----
  interface Raw {
    ws: InstanceType<typeof WebSocket>
    closed: string | null
    got: Buffer[]
  }
  const raw = (cookie: string, xff = `2001:db8:${(net++).toString(16)}::1`): Promise<Raw> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?schema=2`, { headers: { cookie, 'x-forwarded-for': xff } })
      const r: Raw = { ws, closed: null, got: [] }
      open.push(ws)
      ws.on('close', (code) => (r.closed = String(code)))
      ws.on('message', (d: Buffer) => r.got.push(d))
      ws.on('error', () => {})
      ws.on('open', () => resolve(r))
    })
  const openRaw = async (r: Raw, name: string) => {
    const from = r.got.length
    r.ws.send(authFrame(name))
    await until(() => r.got.slice(from).some((m) => m[0] === name.length && m[1 + name.length] === 2), `auth of ${name}`)
    r.ws.send(step1Frame(name))
    await sleep(100)
  }
  const small = JSON.stringify({ user: { name: 'x', color: '#000' } })

  it('R-N1c still: a 1.4 MB frame of new ids, a fifth id of its own, a 17 KB state', async () => {
    const u = await h.makeUser('flood-a')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'f', [] as never)
    const big = JSON.stringify({ blob: 'x'.repeat(16_000) })
    const r1 = await raw(u.cookie)
    await openRaw(r1, page.id)
    r1.ws.send(awarenessFrame(page.id, Array.from({ length: 90 }, (_, i): [number, number, string] => [1_000_000 + i, 1, big])))
    await until(() => r1.closed !== null, 'the 1.4 MB frame closes the socket')
    const r2 = await raw(u.cookie)
    await openRaw(r2, page.id)
    for (let i = 0; i < 4; i++) r2.ws.send(awarenessFrame(page.id, [[2_000_000 + i, 1, small]]))
    await sleep(200)
    assert.equal(r2.closed, null)
    r2.ws.send(awarenessFrame(page.id, [[2_000_009, 1, small]]))
    await until(() => r2.closed !== null, 'a fifth id of its own')
    const r3 = await raw(u.cookie)
    await openRaw(r3, page.id)
    r3.ws.send(awarenessFrame(page.id, [[3_000_000, 1, JSON.stringify({ blob: 'x'.repeat(17 * 1024) })]]))
    await until(() => r3.closed !== null, 'a 17 KB state')
  })

  it('abuse of the rule: ids swapped between two sockets, ids kept alive by another socket, new ids without end', async () => {
    const u = await h.makeUser('flood-b')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'g', [] as never)
    const sa = await raw(u.cookie)
    const sb = await raw(u.cookie)
    await openRaw(sa, page.id)
    await openRaw(sb, page.id)
    const big = JSON.stringify({ blob: 'y'.repeat(4_000) })
    // a brings in four ids; b keeps updating them (bigger states, newer clocks): they stay a's, never b's
    sa.ws.send(awarenessFrame(page.id, [1, 2, 3, 4].map((k): [number, number, string] => [5_000_000 + k, 1, small])))
    await sleep(100)
    for (let c = 2; c < 8; c++) sb.ws.send(awarenessFrame(page.id, [1, 2, 3, 4].map((k): [number, number, string] => [5_000_000 + k, c, big])))
    await sleep(200)
    assert.equal(sb.closed, null, 'updating ids already there is an echo, allowed')
    // so b still has room for exactly four of its own
    sb.ws.send(awarenessFrame(page.id, [1, 2, 3, 4].map((k): [number, number, string] => [6_000_000 + k, 1, small])))
    await sleep(200)
    assert.equal(sb.closed, null)
    // a swaps out: removes its ids, and b takes them over with newer clocks: now they count against b
    sa.ws.send(awarenessFrame(page.id, [1, 2, 3, 4].map((k): [number, number, string] => [5_000_000 + k, 9, 'null'])))
    await sleep(100)
    sb.ws.send(awarenessFrame(page.id, [[5_000_001, 10, small]]))
    await until(() => sb.closed !== null, 'b past four ids of its own')
    const states = (collab.hocuspocus.documents.get(page.id) as unknown as { awareness: { states: Map<number, unknown> } }).awareness.states
    assert.ok(states.size <= 4, `ids left: ${states.size}`)
    // new ids without end: bring one in, remove it, bring the next in …
    const sc = await raw(u.cookie)
    await openRaw(sc, page.id)
    let k = 0
    while (sc.closed === null && k < 200) {
      sc.ws.send(awarenessFrame(page.id, [[7_000_000 + k, 1, small]]))
      sc.ws.send(awarenessFrame(page.id, [[7_000_000 + k, 2, 'null']]))
      k++
      await sleep(5)
    }
    await until(() => sc.closed !== null, 'the new-id bucket runs out')
    console.log(`[fix5] new ids before the socket closed: ${k} (bucket ${A.AWARENESS_NEW_IDS_BURST})`)
    assert.ok(k <= A.AWARENESS_NEW_IDS_BURST + 5)
    sa.ws.close()
    // its own four ids re-sent fast with bigger and bigger clocks: every change goes on to every connection
    const sd = await raw(u.cookie)
    await openRaw(sd, page.id)
    const st = JSON.stringify({ blob: 'z'.repeat(15_000) })
    let sentBytes = 0
    for (let c = 1; c < 200 && sd.closed === null; c++) {
      sd.ws.send(awarenessFrame(page.id, [1, 2, 3, 4].map((x): [number, number, string] => [8_000_000 + x, c, st])))
      sentBytes += 4 * st.length
      await sleep(5)
    }
    await until(() => sd.closed !== null, 'the changed-bytes rate runs out')
    console.log(`[fix5] own ids re-sent: closed after ${(sentBytes / 1024).toFixed(0)} KB (burst ${A.AWARENESS_BYTES_BURST / 1024} KB)`)
    assert.ok(sentBytes <= A.AWARENESS_BYTES_BURST + 8 * 4 * st.length)
  })
})
