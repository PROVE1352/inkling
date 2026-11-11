// 0.22 integration, found while writing the docs:
//  - MCP errors for the restricted-mode codes carry a fitting next step (the limit and the use, what to
//    delete, "turned off on this server", agree on the web) and never the status-based ones ("not a
//    member" for a 403 limit, "not found" for a 404 turned-off feature). upload_file's description and
//    size check follow LIMIT_FILE_MB.
//  - GET /workspaces/:id/usage counts storage at most once a minute per workspace, with or without a limit.
//  - Full = the limit is reached (>=): the recount, the room check and the web agree at the boundary.
//  - A workspace back under its limit lets its read-only live connections edit again (they reconnect).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const STATUS_HINTS = [/not a member of that workspace/, /not found or not visible/, /check the id you passed/]

const webDir = path.resolve(process.cwd(), '../web')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadProvider(): Promise<any> {
  const req = createRequire(path.join(webDir, 'package.json'))
  const main = req.resolve('@hocuspocus/provider')
  return import(pathToFileURL(path.join(path.dirname(main), 'hocuspocus-provider.esm.js')).href)
}

describe('[db] agent hints for limits, usage cost, storage boundary and reconnect', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const core = await import('../mcpTools/core')
  const S = await import('../quota/storage')
  const collab = await import('../collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const app = await h.buildTestApp()

  let server: ReturnType<typeof createServer>
  let port = 0
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

  const noStatusHint = (text: string) => {
    for (const re of STATUS_HINTS) assert.doesNotMatch(text, re, text)
  }
  const fileRow = async (wsId: string, by: string, size: number) =>
    db.insert(schema.files).values({ id: randomUUID(), workspaceId: wsId, createdBy: by, name: 'big.bin', mime: 'application/octet-stream', size }).returning({ id: schema.files.id })

  it('create_page past LIMIT_PAGES: the page limit with its numbers and what to delete, no "not a member"', async () => {
    const u = await h.makeUser('hint-pages')
    const ws = await h.makeWorkspace(u)
    const mcp = await h.connectMcp(app, u, await h.mintToken(u))
    const restore = L.setLimitsForTests({ pagesPerWorkspace: 1 })
    try {
      assert.equal((await mcp.tool('create_page', { workspaceId: ws.id, title: 'one', markdown: 'x' })).isError, false)
      const r = await mcp.tool('create_page', { workspaceId: ws.id, title: 'two', markdown: 'x' })
      assert.equal(r.isError, true)
      assert.match(r.text, /LIMIT_PAGES/)
      assert.match(r.text, /page limit on this server \(1 of 1 used\).*trash/)
      noStatusHint(r.text)
    } finally {
      restore()
      await mcp.close()
    }
  })

  it('upload_file: storage full says so in MB; LIMIT_FILE_MB is in the description and the size check', async () => {
    const u = await h.makeUser('hint-storage')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'Attach here', [] as never)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1, fileMb: 0.5 })
    const mcp = await h.connectMcp(app, u, await h.mintToken(u))
    try {
      const { tools } = await mcp.client.listTools()
      const desc = tools.find((t) => t.name === 'upload_file')?.description ?? ''
      assert.match(desc, /max 0\.5 MB/, desc)
      const tooBig = await mcp.tool('upload_file', { pageId: page.id, name: 'a.txt', text: 'x'.repeat(600 * 1024) })
      assert.equal(tooBig.isError, true)
      assert.match(tooBig.text, /too large for this server \(LIMIT_FILE\).*at most 512\.0 KB per file/, tooBig.text)
      await fileRow(ws.id, u.id, 2 * 1024 * 1024)
      await S.recountWorkspaceStorage(ws.id)
      const full = await mcp.tool('upload_file', { pageId: page.id, name: 'b.txt', text: 'small' })
      assert.equal(full.isError, true)
      assert.match(full.text, /LIMIT_STORAGE/)
      assert.match(full.text, /storage is full on this server \(\d+\.\d MB of 1\.0 MB\).*emptying the trash/, full.text)
      noStatusHint(full.text)
    } finally {
      restore()
      await mcp.close()
    }
    // without the settings: the 0.21.1 description
    const plain = await h.connectMcp(app, u, await h.mintToken(u))
    try {
      const { tools } = await plain.client.listTools()
      assert.match(tools.find((t) => t.name === 'upload_file')?.description ?? '', /max 5 MB/)
    } finally {
      await plain.close()
    }
  })

  it('call(): FEATURE_DISABLED is "turned off on this server", not "not found"; CONSENT_REQUIRED and the other limits have their own', async () => {
    const u = await h.makeUser('hint-feature')
    const ctx = { app, token: await h.mintToken(u), ip: '127.0.0.1', user: u, origin: 'https://notes.example.com', canWrite: true }
    const restore = L.setLimitsForTests({ disabledFeatures: ['web-push'] })
    try {
      await assert.rejects(core.call(ctx, 'GET', '/api/push/key'), (e: Error) => {
        assert.match(e.message, /FEATURE_DISABLED/)
        assert.match(e.message, /turned "web-push" off for everyone; it is not a missing id or a permission/)
        noStatusHint(e.message)
        return true
      })
    } finally {
      restore()
    }
    assert.match(core.restrictedModeHint('LIMIT_MEMBERS', { limit: 4, used: 4 })!, /member limit on this server \(4 of 4 used\)/)
    assert.match(core.restrictedModeHint('LIMIT_WORKSPACES', { limit: 2, used: 2 })!, /permanently delete a deleted workspace/)
    assert.match(core.restrictedModeHint('LIMIT_FILE', { limit: 5 * 1024 * 1024, used: 6 * 1024 * 1024 })!, /at most 5\.0 MB per file/)
    assert.match(core.restrictedModeHint('CONSENT_REQUIRED', {})!, /agree/)
    assert.equal(core.restrictedModeHint('PAGE_LOCKED', {}), null)
  })

  it('usage: the full count runs at most once a minute per workspace, with or without a limit', async () => {
    const u = await h.makeUser('usage-cache')
    const ws = await h.makeWorkspace(u)
    const usage = async () => (await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/usage`, headers: { cookie: u.cookie } })).json() as { storageBytes: number }
    const first = await usage()
    const [w1] = await db.select({ at: schema.workspaces.storageCheckedAt }).from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
    assert.ok(w1.at, 'the count is cached')
    await fileRow(ws.id, u.id, 4096)
    assert.equal((await usage()).storageBytes, first.storageBytes, 'within a minute: the cached count')
    await db.execute(sql`UPDATE workspaces SET storage_checked_at = now() - interval '2 minutes' WHERE id = ${ws.id}`)
    assert.equal((await usage()).storageBytes, first.storageBytes + 4096, 'older than a minute: counted again')
  })

  it('full means the limit is reached: exactly at the limit the recount says over and the room check refuses', async () => {
    const u = await h.makeUser('boundary')
    const ws = await h.makeWorkspace(u)
    const { total } = await S.countWorkspaceStorage(db, ws.id)
    const limitMb = (total + 8192) / 1024 / 1024
    const restore = L.setLimitsForTests({ workspaceStorageMb: limitMb })
    try {
      const limit = L.mbToBytes(limitMb)
      // exactly at the limit: a file of 4 KB or more counts its size + 1 KB with a limit (0.22.1, review N2)
      await fileRow(ws.id, u.id, limit - total - 1024)
      const c = await S.recountWorkspaceStorage(ws.id)
      assert.equal(c.total, limit)
      assert.equal(c.over, true)
      const page = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws.id, title: 'no room' } })
      assert.equal((page.json() as { error?: { code?: string } }).error?.code, 'LIMIT_STORAGE')
    } finally {
      restore()
    }
  })

  it('back under the limit: a read-only live connection reconnects and can edit again', async () => {
    const u = await h.makeUser('reconnect')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'Editing', [] as never)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      const [big] = await fileRow(ws.id, u.id, 2 * 1024 * 1024)
      assert.equal((await S.recountWorkspaceStorage(ws.id)).over, true)
      const doc = new Y.Doc()
      // synced, not only authenticated: the server adds the connection to the document after loading it
      const synced: string[] = []
      const tab = { scopes: [] as string[], provider: null as never as InstanceType<typeof HocuspocusProvider>, socket: null as never as InstanceType<typeof HocuspocusProviderWebsocket> }
      class CookieSocket extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie: u.cookie } })
        }
      }
      tab.socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
      tab.provider = new HocuspocusProvider({
        websocketProvider: tab.socket,
        name: page.id,
        document: doc,
        token: 'cookie',
        broadcast: false,
        onAuthenticated: () => tab.scopes.push(tab.provider.authorizedScope),
        onSynced: () => synced.push('ok'),
      })
      open.push(tab)
      // the web app shares one socket between its documents and the inbox channel (lib/collabSocket.ts)
      const inboxAuth: string[] = []
      const inbox = new HocuspocusProvider({
        websocketProvider: tab.socket,
        name: `inbox:${u.id}`,
        document: new Y.Doc(),
        token: 'cookie',
        broadcast: false,
        onAuthenticated: () => inboxAuth.push('ok'),
      })
      open.push({ provider: inbox, socket: { destroy: () => {} } })
      const until = async (cond: () => boolean, what: string) => {
        const end = Date.now() + 5000
        while (!cond()) {
          if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${tab.scopes.join(',')}`)
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      await until(() => tab.scopes.length === 1 && inboxAuth.length === 1 && synced.length === 1, 'the first sync')
      assert.equal(tab.scopes[0], 'readonly')
      // the member deletes the big file: the recount finds room
      await db.delete(schema.files).where(eq(schema.files.id, big.id))
      assert.equal((await S.recountWorkspaceStorage(ws.id)).over, false)
      await until(() => tab.scopes.length >= 2, 'the reconnect')
      assert.equal(tab.scopes.at(-1), 'read-write')
      // the shared socket came back for the inbox channel too
      await until(() => inboxAuth.length >= 2, 'the inbox channel back on the shared socket')
    } finally {
      restore()
    }
  })
})
