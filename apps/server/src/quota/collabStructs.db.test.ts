// Live editing on a server with a storage limit or the instance fuse (0.22.1 N1(a), N4; docs/adr/2540-*,
// 2543-*). Reproductions of the 0.22.0 re-review (w22-reports/sec2/collab_raw.mjs):
//  - mapflood: inside the byte limits, a page filled with ~480k tiny Y.Map entries (4 MB of updates)
//    holds ~210 MB of heap; four such pages ran a 320 MB heap out of memory. Now a page holds at most
//    DOC_STRUCTS_CAP structs: an update that would pass it is refused before it is applied (read-only
//    reconnect, as for the byte caps), also with only the fuse set.
//  - redundant: a member re-sent an update the page already held; each copy counted as unsaved growth,
//    until the workspace refused its owner's paste (2 MB stored, 20.78 MB counted). Now the growth is
//    what the document really took in, so copies add nothing.
// Ordinary large pastes and typing are never refused, and without either setting nothing here runs.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-collabstructs-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
function bytes(out: number[], b: Uint8Array): void {
  varUint(out, b.length)
  for (let i = 0; i < b.length; i++) out.push(b[i])
}
const enc = (s: string) => new TextEncoder().encode(s)
function frame(name: string, type: number, body: (out: number[]) => void): Uint8Array {
  const out: number[] = []
  bytes(out, enc(name))
  varUint(out, type)
  body(out)
  return Uint8Array.from(out)
}
const authFrame = (name: string) => frame(name, 2, (o) => { varUint(o, 0); bytes(o, enc('cookie')) })
const step1Frame = (name: string) => frame(name, 0, (o) => { varUint(o, 0); bytes(o, Uint8Array.from([0])) })
const updateFrame = (name: string, u: Uint8Array) => frame(name, 0, (o) => { varUint(o, 2); bytes(o, u) })

describe('[db] live editing: struct cap and real growth (0.22.1 N1(a), N4)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb } = await import('../db/index')
  const L = await import('../limits')
  const G = await import('./collabGrowth')
  const collab = await import('../collab')
  const { liveStructCount } = await import('../collabUpdateShape')
  const { markdownToBlocks } = await import('../md/convert')
  const { getServerEditor } = await import('../md/editor')
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

  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
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
  const raw = (cookie: string): Promise<Raw> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?schema=2`, { headers: { cookie } })
      const r: Raw = { ws, closed: null, got: [] }
      open.push(ws)
      ws.on('close', (code, reason) => (r.closed = `${code} ${reason}`))
      ws.on('message', (d: Buffer) => r.got.push(d))
      ws.on('error', () => {})
      ws.on('open', () => resolve(r))
    })
  /** Open a document; returns the scope the server authorised ('read-write' or 'readonly'). */
  const openDoc = async (r: Raw, name: string): Promise<string> => {
    const from = r.got.length
    r.ws.send(authFrame(name))
    let scope = ''
    await until(() => {
      for (const m of r.got.slice(from)) {
        if (m[0] === name.length && m.subarray(1, 1 + name.length).toString() === name && m[1 + name.length] === 2 && m[2 + name.length] === 2) {
          scope = m.subarray(4 + name.length).toString()
          return true
        }
      }
      return false
    }, `auth of ${name}`)
    r.ws.send(step1Frame(name))
    await sleep(100)
    return scope
  }
  /** SyncStatus replies (message type 8) for `name` received since index `from`. */
  const statuses = (r: Raw, name: string, from: number) =>
    r.got
      .slice(from)
      .filter((m) => m[0] === name.length && m.subarray(1, 1 + name.length).toString() === name && m[1 + name.length] === 8)
      .map((m) => m[2 + name.length] === 1)
  const liveStructs = (id: string) => {
    const d = collab.hocuspocus.documents.get(id)
    return d ? liveStructCount(d as never) : 0
  }
  /** One update of `n` new tiny map entries (the review's mapflood). */
  const mapUpdate = (d: InstanceType<typeof Y.Doc>, from: number, n: number) => {
    const sv = Y.encodeStateVector(d)
    d.transact(() => {
      for (let i = from; i < from + n; i++) d.getMap('m').set(i.toString(36), 0)
    })
    return Y.encodeStateAsUpdate(d, sv)
  }

  const mapflood = async (label: string) => {
    const u = await h.makeUser(`n1a-${label}`)
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'flood', [] as never)
    const keeper = await raw(u.cookie) // keeps the page loaded after the flooding socket closes
    await openDoc(keeper, page.id)
    const r = await raw(u.cookie)
    assert.equal(await openDoc(r, page.id), 'read-write')
    const before = G.collabGrowthStats.refusedForStructs
    const d = new Y.Doc()
    let k = 0
    let sent = 0
    // the review: 120k entries per update until 4 MB per page, paced under the socket rate
    while (sent < 4 * 1024 * 1024 && r.ws.readyState === WebSocket.OPEN) {
      const up = mapUpdate(d, k, 120_000)
      k += 120_000
      r.ws.send(updateFrame(page.id, up))
      sent += up.length
      await sleep(400)
    }
    await until(() => r.closed !== null || G.collabGrowthStats.refusedForStructs > before, 'a refusal')
    await sleep(300)
    const structs = liveStructs(page.id)
    console.log(`[N1a ${label}] offered ${k} entries in ${(sent / 1048576).toFixed(2)} MB; the page holds ${structs} structs (cap ${G.DOC_STRUCTS_CAP}); socket ${r.closed ?? 'open'}`)
    assert.ok(G.collabGrowthStats.refusedForStructs > before, 'refused for its structs')
    assert.ok(structs <= G.DOC_STRUCTS_CAP, `${structs} structs live`)
    await until(() => r.closed !== null, 'the socket to close (the client learns read-only)')
    // the reconnect is authorised read-only: no write-refuse-close loop
    const again = await raw(u.cookie)
    assert.equal(await openDoc(again, page.id), 'readonly')
    again.ws.close()
    keeper.ws.close()
  }

  it('R-N1a: tiny map entries past the struct cap are refused (storage limit)', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20 })
    try {
      await mapflood('limit')
    } finally {
      restore()
    }
  })

  it('R-N1a: the same with only the instance fuse set', async () => {
    const restore = L.setLimitsForTests({ instanceStorageMb: 1_000_000 })
    try {
      await mapflood('fuse')
    } finally {
      restore()
    }
  })

  it('ordinary large pastes and typing are never refused for structs or bytes', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20 })
    try {
      const refused = { ...G.collabGrowthStats }
      const owner = await h.makeUser('n1a-normal')
      const b = await h.makeUser('n1a-normal-b')
      const ws = await h.makeWorkspace(owner, [b])
      const page = await h.makeDocPage(ws.id, owner.id, 'big', [] as never)
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
      const people = [owner, b].map((u) => {
        const doc = new Y.Doc()
        let synced = false
        const provider = new HocuspocusProvider({ websocketProvider: socketFor(u.cookie), name: page.id, document: doc, token: 'cookie', broadcast: false, onSynced: () => (synced = true) })
        open.push(provider)
        return { doc, provider, synced: () => synced }
      })
      await until(() => people.every((p) => p.synced()), 'both synced')
      // a long document pasted in one go: this repository's API reference (210 KB of Markdown)
      const md = readFileSync(path.resolve(process.cwd(), '../../docs/API.md'), 'utf8')
      const blocks = await markdownToBlocks(md, () => null)
      getServerEditor().blocksToYXmlFragment(blocks as never, people[0].doc.getXmlFragment('document') as never)
      // a large table pasted by the other person
      const table = ['| a | b | c | d | e | f |', '|' + ' --- |'.repeat(6), ...Array.from({ length: 400 }, (_, r) => `| ${r} | b${r} | c${r} | d${r} | 값 ${r} | f${r} |`)].join('\n')
      const tblocks = await markdownToBlocks(table, () => null)
      const frag = people[1].doc.getXmlFragment('table')
      getServerEditor().blocksToYXmlFragment(tblocks as never, frag as never)
      // and both typing at random places in the pasted text for a while
      let seed = 3
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      const texts = (d: InstanceType<typeof Y.Doc>) => {
        const out: InstanceType<typeof Y.XmlText>[] = []
        const walk = (x: InstanceType<typeof Y.XmlFragment> | InstanceType<typeof Y.XmlElement>) => {
          for (const c of x.toArray()) {
            if (c instanceof Y.XmlText) out.push(c)
            else if (c instanceof Y.XmlElement) walk(c)
          }
        }
        walk(d.getXmlFragment('document'))
        return out
      }
      await until(() => people.every((p) => p.provider.unsyncedChanges === 0), 'the pastes acknowledged')
      for (let round = 0; round < 20; round++) {
        for (const p of people) {
          const ts = texts(p.doc)
          if (!ts.length) continue
          for (let i = 0; i < 25; i++) {
            const t = ts[Math.floor(rnd() * ts.length)]
            t.insert(Math.floor(rnd() * (t.length + 1)), 'x')
          }
        }
        await sleep(20)
      }
      await until(() => people.every((p) => p.provider.unsyncedChanges === 0), 'every edit acknowledged')
      const live = liveStructs(page.id)
      console.log(`[N1a] ordinary pastes and typing: ${live} structs live; refused ${G.collabGrowthStats.refused - refused.refused}`)
      assert.equal(G.collabGrowthStats.refused, refused.refused, 'nothing refused')
      assert.equal(G.collabGrowthStats.refusedForStructs, refused.refusedForStructs)
      assert.ok(live > 10_000, 'the pastes are on the server')
      assert.ok(collab.hocuspocus.documents.get(page.id)!.getXmlFragment('table').length > 0)
    } finally {
      restore()
    }
  })

  it('R-N4: re-sending an update the page already holds does not count as growth', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20 })
    try {
      const owner = await h.makeUser('n4-owner')
      const att = await h.makeUser('n4-member')
      const ws = await h.makeWorkspace(owner, [att])
      const target = await h.makeDocPage(ws.id, owner.id, 'owner-edits-this', [] as never)
      const refusedBefore = G.collabGrowthStats.refused
      let resent = 0
      for (let k = 0; k < 4; k++) {
        const pA = await h.makeDocPage(ws.id, owner.id, `member-${k}`, [] as never)
        const keep = await raw(att.cookie) // keeps the page loaded
        await openDoc(keep, pA.id)
        const s = await raw(att.cookie)
        await openDoc(s, pA.id)
        const d = new Y.Doc()
        d.getText('t').insert(0, randomBytes(380_000).toString('base64')) // ~0.5 MB of real content
        const u = Y.encodeStateAsUpdate(d)
        s.ws.send(updateFrame(pA.id, u))
        await until(() => collab.hocuspocus.documents.get(pA.id)?.getText('t').length === d.getText('t').length, 'the content applied')
        await collab.flushLiveDocuments([pA.id]) // stored once
        // the same bytes again, nine times: nothing changes in the document
        for (let i = 0; i < 9; i++) {
          s.ws.send(updateFrame(pA.id, u))
          resent += u.length
          await sleep(30)
        }
        await sleep(200)
        assert.equal(s.closed, null, 'the copies are not refused either')
      }
      const unsaved = G.collabUnsavedBytes(ws.id)
      console.log(`[N4] re-sent ${(resent / 1048576).toFixed(1)} MB of copies; unsaved growth counted ${unsaved} bytes`)
      assert.ok(unsaved < 512 * 1024, `copies counted as growth: ${unsaved}`)
      // the owner pastes 1 MB into another page: it fits (2 MB stored of 20 MB)
      const o = await raw(owner.cookie)
      await openDoc(o, target.id)
      const od = new Y.Doc()
      od.getText('t').insert(0, randomBytes(750_000).toString('base64'))
      const from = o.got.length
      o.ws.send(updateFrame(target.id, Y.encodeStateAsUpdate(od)))
      await until(() => statuses(o, target.id, from).length > 0, "the owner's paste answered")
      assert.deepEqual(statuses(o, target.id, from), [true], "the owner's paste is applied")
      assert.equal(G.collabGrowthStats.refused, refusedBefore, 'nothing refused')
      assert.equal(o.closed, null)
    } finally {
      restore()
    }
  })

  it('without a storage limit or the fuse: the same map flood is applied whole, nothing is counted (the 0.22.0 path)', async () => {
    assert.equal(L.limits.workspaceStorageMb, null)
    assert.equal(L.limits.instanceStorageMb, undefined)
    const before = { ...G.collabGrowthStats }
    const u = await h.makeUser('n1a-off')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'off', [] as never)
    const r = await raw(u.cookie)
    await openDoc(r, page.id)
    const d = new Y.Doc()
    const from = r.got.length
    r.ws.send(updateFrame(page.id, mapUpdate(d, 0, 150_000)))
    await until(() => statuses(r, page.id, from).length > 0, 'the update answered')
    assert.deepEqual(statuses(r, page.id, from), [true])
    assert.ok(liveStructs(page.id) >= 150_000)
    assert.deepEqual(G.collabGrowthStats, before, 'the admission never ran')
    assert.equal(r.closed, null)
  })
})
