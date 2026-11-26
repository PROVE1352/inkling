// What a collab socket may send to the other people on a page (0.25.4, sec26 D-1 and E-1), against the real
// collaboration server with the web app's own provider as the victim and raw Hocuspocus frames as the sender:
//  - BroadcastStateless (message type 6): Hocuspocus hands its payload to every connection of the document,
//    read-only ones included, so a view-only guest could send `{"t":"schema","needs":99}` (every editor turns
//    read-only) or `{"t":"gen",…}` (offline copies set their unsent edits aside). No client of ours sends it;
//    the server refuses it from anyone.
//  - Awareness `user.color` goes into the style attribute of the cursor BlockNote draws, and `user.name` into its
//    label: a colour that is not `#rgb`/`#rrggbb` reaches nobody (replaced by a neutral one), nor a name that is
//    not a string.
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
const text = (s: string) => new TextEncoder().encode(s)
function bytes(out: number[], b: Uint8Array): void {
  varUint(out, b.length)
  for (const x of b) out.push(x)
}
function frame(name: string, type: number, body: (out: number[]) => void): Uint8Array {
  const out: number[] = []
  bytes(out, text(name))
  varUint(out, type)
  body(out)
  return Uint8Array.from(out)
}
const authFrame = (name: string) => frame(name, 2, (o) => { varUint(o, 0); bytes(o, text('cookie')) })
const step1Frame = (name: string) => frame(name, 0, (o) => { varUint(o, 0); bytes(o, Uint8Array.from([0])) })
const broadcastStatelessFrame = (name: string, payload: string) => frame(name, 6, (o) => bytes(o, text(payload)))
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

describe('[db] collab: forged notices and awareness styles reach no one (sec26 D-1, E-1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
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

  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  let net = 300
  /** The victim: the web app's provider on its own socket, collecting what it is sent. */
  function openTab(cookie: string, pageId: string) {
    const xff = `2001:db8:${(net++).toString(16)}::1`
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie, 'x-forwarded-for': xff } })
      }
    }
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab?schema=2`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    open.push(socket)
    const doc = new Y.Doc()
    const tab = { doc, synced: false, stateless: [] as string[], provider: null as never as InstanceType<typeof HocuspocusProvider> }
    tab.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: pageId,
      document: doc,
      token: 'cookie',
      broadcast: false,
      onStateless: ({ payload }: { payload: string }) => tab.stateless.push(payload),
      onSynced: () => (tab.synced = true),
    })
    open.push(tab.provider)
    return tab
  }

  /** The sender: a raw socket that authenticates on `pageId` and then sends whatever frames it likes. */
  async function rawSocket(cookie: string, pageId: string) {
    const xff = `2001:db8:${(net++).toString(16)}::1`
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?schema=2`, { headers: { cookie, 'x-forwarded-for': xff } })
    open.push(ws)
    const s = { ws, closed: false, scope: '' }
    ws.on('close', () => (s.closed = true))
    ws.on('message', (data: Buffer) => {
      // [name][2 = Auth][0 = Token | 1 = PermissionDenied | 2 = Authenticated][scope]
      const b = new Uint8Array(data)
      const nameLen = b[0]
      if (b[1 + nameLen] === 2 && b[2 + nameLen] === 2) s.scope = new TextDecoder().decode(b.subarray(4 + nameLen, 4 + nameLen + b[3 + nameLen]))
    })
    await new Promise<void>((r, j) => {
      ws.once('open', () => r())
      ws.once('error', j)
    })
    ws.send(authFrame(pageId))
    await until(() => s.scope !== '', 'the raw socket authenticated')
    ws.send(step1Frame(pageId))
    await sleep(100)
    return s
  }

  async function lockedPage() {
    const owner = await h.makeUser('fn-owner')
    const reader = await h.makeUser('fn-reader')
    const ws = await h.makeWorkspace(owner, [reader])
    const page = await h.makeDocPage(ws.id, owner.id, 'locked', [] as never)
    assert.equal((await app.inject({ method: 'PUT', url: `/api/pages/${page.id}/lock`, headers: { cookie: owner.cookie }, payload: { locked: true } })).statusCode, 200)
    return { owner, reader, page }
  }

  it('D-1: a read-only member cannot broadcast schema/gen notices to the editors of the page', async () => {
    const { owner, reader, page } = await lockedPage()
    const victim = openTab(owner.cookie, page.id)
    await until(() => victim.synced, 'the editor synced')
    const before = victim.stateless.length // the server's own gen notice on connect
    const attacker = await rawSocket(reader.cookie, page.id)
    assert.equal(attacker.scope, 'readonly')
    attacker.ws.send(broadcastStatelessFrame(page.id, '{"t":"schema","needs":99}'))
    attacker.ws.send(broadcastStatelessFrame(page.id, '{"t":"gen","gen":999999}'))
    await sleep(500)
    const forged = victim.stateless.slice(before)
    console.log(`[D-1] notices the editor got from the read-only socket: ${JSON.stringify(forged)}, sender closed: ${attacker.closed}`)
    assert.deepEqual(forged, [], 'the editor is sent nothing the read-only socket made up')
    assert.equal(attacker.closed, true, 'the socket that sent it is closed')
    // the editor is still connected and the server's own notices still arrive
    collab.broadcastToPage(page.id, { t: 'comments' })
    await until(() => victim.stateless.some((p) => p.includes('"comments"')), 'a server notice still arrives')
    victim.provider.destroy()
  })

  it('D-1: an editor cannot broadcast them either (no client of ours sends message type 6)', async () => {
    const { owner, page } = await lockedPage()
    const victim = openTab(owner.cookie, page.id)
    await until(() => victim.synced, 'the editor synced')
    const before = victim.stateless.length
    const attacker = await rawSocket(owner.cookie, page.id)
    assert.equal(attacker.scope, 'read-write')
    attacker.ws.send(broadcastStatelessFrame(page.id, '{"t":"schema","needs":99}'))
    await sleep(500)
    assert.deepEqual(victim.stateless.slice(before), [])
    assert.equal(attacker.closed, true)
    victim.provider.destroy()
  })

  it('E-1: a CSS colour, a number colour and a non-string name reach the other tabs as a plain colour (or none) and no name', async () => {
    const { owner, reader, page } = await lockedPage()
    const victim = openTab(owner.cookie, page.id)
    await until(() => victim.synced, 'the editor synced')
    const attacker = await rawSocket(reader.cookie, page.id)
    const css = '#000; position: fixed; inset: 0; z-index: 99999; background-image: url(https://evil.example/t.gif)'
    const cursor = { anchor: { type: { client: 1, clock: 0 }, tname: null, item: null, assoc: 0 }, head: { type: { client: 1, clock: 0 }, tname: null, item: null, assoc: 0 } }
    const ids = [910001, 910002, 910003, 910004]
    attacker.ws.send(
      awarenessFrame(page.id, [
        [ids[0], 1, JSON.stringify({ user: { name: 'css', color: css }, cursor })],
        [ids[1], 1, JSON.stringify({ user: { name: 'num', color: 5 }, cursor })],
        [ids[2], 1, JSON.stringify({ user: { name: { toString: 1 }, color: '#0b6e99' }, cursor })],
        [ids[3], 1, JSON.stringify({ user: { name: 'fine', color: '#e03e3e', id: 'x' }, cursor })],
      ]),
    )
    const seen = () => victim.provider.awareness.getStates() as Map<number, { user?: { name?: unknown; color?: unknown; id?: unknown }; cursor?: unknown }>
    await until(() => ids.every((id) => seen().has(id)), 'the four states reached the editor')
    const users = ids.map((id) => seen().get(id)?.user)
    console.log(`[E-1] what the editor got: ${JSON.stringify(users)}`)
    assert.equal(users[0]!.color, '#888888', 'the CSS colour is replaced by the neutral one')
    assert.equal(users[1]!.color, undefined, 'a number colour leaves no room for it: no colour (the cursor uses its own)')
    for (const u of users) if (u?.color !== undefined) assert.match(String(u.color), /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
    assert.equal(users[0]!.name, 'css')
    assert.equal(users[1]!.name, 'num')
    assert.ok(users[2]!.name === undefined || typeof users[2]!.name === 'string', 'a name that is not a string is not passed on as one')
    // a good state passes untouched, other fields included
    assert.deepEqual(users[3], { name: 'fine', color: '#e03e3e', id: 'x' })
    // the server's own copy too (what a tab that opens later is sent)
    const live = (collab.hocuspocus.documents.get(page.id) as unknown as { awareness: { states: Map<number, { user?: { color?: unknown } }> } }).awareness
    for (const id of ids) {
      const c = live.states.get(id)?.user?.color
      if (c !== undefined) assert.match(String(c), /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
    }
    assert.equal(attacker.closed, false, 'a state is cleaned, the socket stays')
    victim.provider.destroy()
  })
})
