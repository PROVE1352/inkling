// Open collaboration sockets of a workspace deleted for good (0.22 integration, docs/adr/2529-*): the
// workspace's pages are gone after the purge, so the sockets are found from the open documents whose
// page no longer exists. Leaving as the last member, and an account deletion that purges a workspace a
// page guest has open, close them; a live page's socket stays.
// The clients are real Hocuspocus providers over a socket, as in docSchemaGuard.db.test.ts.
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

describe('[db] sockets of a workspace deleted for good are closed', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const collab = await import('../collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  let port = 0
  let server: ReturnType<typeof createServer>
  const open: { provider: { destroy: () => void }; socket: { destroy: () => void } }[] = []

  before(async () => {
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

  const until = async (cond: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  function openTab(cookie: string, pageId: string) {
    const doc = new Y.Doc()
    const tab = { denied: [] as string[], synced: false, provider: null as never as InstanceType<typeof HocuspocusProvider>, socket: null as never as InstanceType<typeof HocuspocusProviderWebsocket> }
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } })
      }
    }
    tab.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
    tab.provider = new HocuspocusProvider({
      websocketProvider: tab.socket,
      name: pageId,
      document: doc,
      token: 'cookie',
      broadcast: false,
      onSynced: () => (tab.synced = true),
      onAuthenticationFailed: ({ reason }: { reason: string }) => tab.denied.push(reason),
    })
    open.push(tab)
    return tab
  }
  const connections = (pageId: string) => collab.hocuspocus.documents.get(pageId)?.getConnectionsCount() ?? 0

  it('leaving as the last member: the leaver\'s open page closes (the pages are already gone when it is looked up)', async () => {
    const o = await h.makeUser('purge-alone')
    const ws = await h.makeWorkspace(o, [], `Alone ${Date.now()}`)
    const page = await h.makeDocPage(ws.id, o.id, 'Open page', [{ type: 'paragraph', content: [{ type: 'text', text: 'hi', styles: {} }] }] as never)
    // a page elsewhere that must stay open
    const other = await h.makeWorkspace(o, [], `Other ${Date.now()}`)
    const kept = await h.makeDocPage(other.id, o.id, 'Kept page', [] as never)
    const tab = openTab(o.cookie, page.id)
    const keep = openTab(o.cookie, kept.id)
    await until(() => tab.synced && keep.synced, 'both tabs synced')
    assert.equal(connections(page.id), 1)
    const res = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/members/${o.id}`, headers: { cookie: o.cookie }, payload: { name: ws.name } })
    assert.equal(res.statusCode, 204, res.body)
    await until(() => connections(page.id) === 0, 'the purged page socket closed')
    assert.equal((await db.select({ id: schema.workspaces.id }).from(schema.workspaces)).some((w) => w.id === ws.id), false)
    assert.equal(connections(kept.id), 1, 'a live page stays open')
  })

  it('an account deletion purging a workspace closes a page guest\'s socket to it', async () => {
    const { deleteAccount } = await import('../account/deletion')
    const leaver = await h.makeUser('purge-leaver')
    const guest = await h.makeUser('purge-guest')
    await h.makeWorkspace(guest)
    const ws = await h.makeWorkspace(leaver, [], `Leaver ${Date.now()}`)
    const page = await h.makeDocPage(ws.id, leaver.id, 'Shared with a guest', [] as never)
    await db.insert(schema.pageGrants).values({ pageId: page.id, userId: guest.id, level: 'edit', createdBy: leaver.id })
    const tab = openTab(guest.cookie, page.id)
    await until(() => tab.synced || tab.denied.length > 0, 'the guest tab answered')
    assert.equal(tab.denied.length, 0, `guest connected: ${tab.denied.join(',')}`)
    assert.equal(connections(page.id), 1)
    const res = await deleteAccount(leaver.id, { by: 'self' })
    assert.equal(res.deletedWorkspaces, 1)
    await until(() => connections(page.id) === 0, 'the guest socket closed')
  })
})
