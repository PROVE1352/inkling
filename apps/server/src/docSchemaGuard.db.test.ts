// Document schema guard (docs/adr/2425-*) against the real collaboration server: a client that sends no
// schema (0.19 and older) is read-only on a page with columns, from the start or from the moment a group
// arrives, and the deletion its editor answers with is never applied; current clients edit as before;
// /sync-check says what a page needs to a copy of an older app; a row template body refuses an older
// app's update. The clients are real Hocuspocus providers over sockets; the old editor's reaction
// (y-prosemirror deleting a node its schema lacks, ADR 0940) is done by hand on the client's Y.Doc.
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

const webDir = path.resolve(process.cwd(), '../web')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

describe('[db] document schema guard: older clients and pages with columns', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { closeDb } = await import('./db/index')
  const collab = await import('./collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { blocksToStateBuffer } = await import('./md/convert')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const t = (text: string) => [{ type: 'text', text, styles: {} }]
  const p = (text: string) => ({ type: 'paragraph', content: t(text) })
  const group = (l: string, r: string) => ({
    type: 'columnList',
    props: {},
    children: [
      { type: 'column', props: {}, children: [p(l)] },
      { type: 'column', props: {}, children: [p(r)] },
    ],
  })

  let O: U
  let wsId: string
  let port = 0
  let server: ReturnType<typeof createServer>
  const open: { provider: { destroy: () => void }; socket: { destroy: () => void } }[] = []

  before(async () => {
    O = await h.makeUser('Owner')
    wsId = (await h.makeWorkspace(O, [])).id
    server = createServer((_r, s) => s.end())
    collab.attachCollab(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  after(async () => {
    for (const c of open) {
      c.provider.destroy()
      c.socket.destroy()
    }
    await new Promise<void>((r) => server.close(() => r()))
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  async function newPage(title: string, blocks: unknown[]) {
    const pg = await h.makeDocPage(wsId, O.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    return pg.id
  }
  const liveXml = (id: string) => collab.hocuspocus.documents.get(id)?.getXmlFragment('document').toString() ?? ''
  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
    const end = Date.now() + ms
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** A tab: `schema` null = a 0.19 client (no parameter on the socket URL). */
  function openTab(pageId: string, schema: number | null) {
    const doc = new Y.Doc()
    const tab = { doc, scopes: [] as string[], stateless: [] as unknown[], closes: 0, provider: null as never as InstanceType<typeof HocuspocusProvider>, socket: null as never as InstanceType<typeof HocuspocusProviderWebsocket> }
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: O.cookie } })
      }
    }
    const url = `ws://127.0.0.1:${port}/collab${schema === null ? '' : `?schema=${schema}`}`
    tab.socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    tab.socket.on('close', () => tab.closes++)
    tab.provider = new HocuspocusProvider({
      websocketProvider: tab.socket,
      name: pageId,
      document: doc,
      token: 'cookie',
      broadcast: false,
      onStateless: ({ payload }: { payload: string }) => tab.stateless.push(JSON.parse(payload)),
      onAuthenticated: () => tab.scopes.push(tab.provider.authorizedScope),
    })
    open.push(tab)
    return tab
  }
  /** What y-prosemirror does in an editor whose schema lacks a node: delete it (and everything inside). */
  function deleteGroups(doc: InstanceType<typeof Y.Doc>): number {
    let n = 0
    doc.transact(() => {
      const walk = (el: InstanceType<typeof Y.XmlElement> | InstanceType<typeof Y.XmlFragment>) => {
        const kids = el.toArray()
        for (let i = kids.length - 1; i >= 0; i--) {
          const c = kids[i]
          if (!(c instanceof Y.XmlElement)) continue
          if (c.nodeName === 'columnList') {
            el.delete(i, 1)
            n++
          } else walk(c)
        }
      }
      walk(doc.getXmlFragment('document'))
    })
    return n
  }
  /** Types into the first paragraph whose text contains `marker`. */
  function typeAfter(doc: InstanceType<typeof Y.Doc>, marker: string, text: string) {
    const find = (n: unknown): InstanceType<typeof Y.XmlText> | null => {
      if (n instanceof Y.XmlText) return n.toString().includes(marker) ? n : null
      if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) for (const c of n.toArray()) {
        const r = find(c)
        if (r) return r
      }
      return null
    }
    const x = find(doc.getXmlFragment('document'))
    if (!x) throw new Error(`no text ${marker}`)
    x.insert(x.length, text)
  }

  it('a 0.19 client on a page with columns is read-only from the start; its deletion and typing are dropped', async () => {
    const id = await newPage('Cols', [p('before'), group('left', 'right'), p('after')])
    const old = openTab(id, null)
    await until(() => old.provider.isSynced, 'old tab synced')
    assert.deepEqual(old.scopes, ['readonly'])
    await until(() => old.stateless.some((m) => (m as { t?: string }).t === 'schema'), 'schema notice')
    assert.deepEqual(old.stateless.find((m) => (m as { t?: string }).t === 'schema'), { t: 'schema', needs: 2 })
    assert.equal(deleteGroups(old.doc), 1)
    typeAfter(old.doc, 'before', ' typed')
    await pause(400)
    assert.match(liveXml(id), /columnlist/i)
    assert.match(liveXml(id), /left/)
    assert.doesNotMatch(liveXml(id), /typed/)
    // the stored state too once the document is written
    const read = await req(O, 'GET', `/pages/${id}/export?format=md&notation=agent`)
    assert.match(read.body, /<!-- inkling:columns -->[\s\S]*left[\s\S]*right[\s\S]*<!-- \/inkling:columns -->/)
  })

  it('current clients edit the same page; a 0.19 client edits a page without columns', async () => {
    const id = await newPage('Both', [p('top'), group('l', 'r')])
    const a = openTab(id, 2)
    await until(() => a.provider.isSynced, 'new tab synced')
    assert.deepEqual(a.scopes, ['read-write'])
    typeAfter(a.doc, 'top', ' new')
    await until(() => /top new/.test(liveXml(id)), 'new tab typing applied')
    assert.equal(a.stateless.some((m) => (m as { t?: string }).t === 'schema'), false)

    const plain = await newPage('Plain', [p('plain')])
    const old = openTab(plain, null)
    await until(() => old.provider.isSynced, 'old tab synced')
    assert.deepEqual(old.scopes, ['read-write'])
    typeAfter(old.doc, 'plain', ' old')
    await until(() => /plain old/.test(liveXml(plain)), 'old tab typing applied')
  })

  it('a group arriving while a 0.19 client is open: read-only at once, reconnected with the read-only scope', async () => {
    const id = await newPage('Live', [p('live')])
    const old = openTab(id, null)
    const neu = openTab(id, 2)
    await until(() => old.provider.isSynced && neu.provider.isSynced, 'both synced')
    assert.deepEqual(old.scopes, ['read-write'])
    // the new tab adds a group (an update of its own doc, as the editor's insert)
    const add = new Y.Doc()
    Y.applyUpdate(add, new Uint8Array(blocksToStateBuffer([group('gl', 'gr')] as never)))
    neu.doc.transact(() => {
      const g = add.getXmlFragment('document').get(0) as InstanceType<typeof Y.XmlElement>
      const el = (g.get(0) as InstanceType<typeof Y.XmlElement>).clone()
      ;(neu.doc.getXmlFragment('document').get(0) as InstanceType<typeof Y.XmlElement>).push([el as never])
    })
    await until(() => /columnlist/i.test(liveXml(id)), 'group on the server')
    // the old editor deletes it as soon as it sees it, and keeps typing
    await until(() => /columnlist/i.test(old.doc.getXmlFragment('document').toString()), 'old tab received the group')
    deleteGroups(old.doc)
    typeAfter(old.doc, 'live', ' old-after')
    await pause(500)
    assert.match(liveXml(id), /columnlist/i)
    assert.match(liveXml(id), /gl/)
    assert.doesNotMatch(liveXml(id), /old-after/)
    // the server closed the old socket; the reconnect is read-only and says why
    await until(() => old.scopes.includes('readonly'), 'old tab re-authenticated read-only')
    assert.ok(old.closes >= 1)
    await until(() => old.stateless.some((m) => (m as { t?: string }).t === 'schema'), 'schema notice after the reconnect')
    // after the reconnect its unsent deletion is offered again (SyncStep2) and dropped again
    await pause(400)
    assert.match(liveXml(id), /columnlist/i)
    // the new tab was never touched
    assert.deepEqual(neu.scopes, ['read-write'])
    typeAfter(neu.doc, 'gl', ' more')
    await until(() => /gl more/.test(liveXml(id)), 'new tab keeps editing')
  })

  it('a group written by an agent (REST) also turns open 0.19 connections read-only', async () => {
    const id = await newPage('Agent', [p('agent page')])
    const old = openTab(id, null)
    await until(() => old.provider.isSynced, 'old synced')
    const r = await req(O, 'POST', `/pages/${id}/content`, {
      mode: 'append',
      markdown: '<!-- inkling:columns -->\n<!-- inkling:column -->\nfrom agent\n<!-- inkling:column -->\nsecond\n<!-- /inkling:columns -->',
    })
    assert.equal(r.statusCode, 200, r.body)
    await until(() => /columnlist/i.test(old.doc.getXmlFragment('document').toString()), 'old tab received the group')
    deleteGroups(old.doc)
    await pause(400)
    assert.match(liveXml(id), /from agent/)
    await until(() => old.scopes.includes('readonly'), 'old tab read-only')
  })

  it('/sync-check says what the page needs to a copy of an older app only', async () => {
    const cols = await newPage('SC', [group('a', 'b')])
    const plain = await newPage('SC plain', [p('x')])
    assert.equal((await req(O, 'GET', `/pages/${cols}/sync-check`)).json().needs, undefined)
    assert.equal((await req(O, 'GET', `/pages/${cols}/sync-check?schema=2`)).json().needs, undefined)
    assert.equal((await req(O, 'GET', `/pages/${cols}/sync-check?schema=1`)).json().needs, 2)
    assert.equal((await req(O, 'GET', `/pages/${plain}/sync-check?schema=1`)).json().needs, 1)
  })

  it('a row template body with columns refuses an update from an older app', async () => {
    const c = await req(O, 'POST', '/pages', { workspaceId: wsId, kind: 'collection', title: 'Tasks' })
    assert.equal(c.statusCode, 200, c.body)
    const C = c.json().page.id as string
    const tpl = (await req(O, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Cols' })).json().template
    const withGroup = blocksToStateBuffer([p('intro'), group('tl', 'tr')] as never).toString('base64')
    assert.equal((await req(O, 'PATCH', `/collection-row-templates/${tpl.id}`, { update: withGroup, schema: 2 })).statusCode, 200)
    const more = blocksToStateBuffer([p('more')] as never).toString('base64')
    const old = await req(O, 'PATCH', `/collection-row-templates/${tpl.id}`, { update: more })
    assert.equal(old.statusCode, 409, old.body)
    assert.equal(old.json().error.code, 'SCHEMA_OUTDATED')
    assert.equal((await req(O, 'PATCH', `/collection-row-templates/${tpl.id}`, { update: more, schema: 2 })).statusCode, 200)
    // a name change from the older app still works (no body update)
    assert.equal((await req(O, 'PATCH', `/collection-row-templates/${tpl.id}`, { name: 'Renamed' })).statusCode, 200)
  })
})
