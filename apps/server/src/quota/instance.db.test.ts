// The instance storage fuse (LIMIT_INSTANCE_STORAGE_MB, contract §14, security review F4, docs/adr/2532-*).
//  - Measured from the real database size and DATA_DIR, cached, at most once a minute.
//  - Tripped: sign-up and every write under /api answer 503 INSTANCE_FULL, except the open list
//    (sign-in and out, account safety, consent, reads sent as POST, read marks, what only removes) and
//    the admin API; GET and DELETE always pass (reading, export, deleting pages, workspaces, the account).
//    Live editing turns read-only, and comes back when the fuse clears. Auth mode says instanceFull.
//  - Unset: nothing is measured, nothing refused, no field.
// Own database: the fuse looks at the whole database.
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

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

describe('[db] instance storage fuse (F4)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const kit = await import('../restrictedMode/restrictedTestKit')
  const drop = await kit.scratchDatabase('w22x1fuse')
  const { db } = await import('../db/index')
  const schema = await import('../db/schema')
  const L = await import('../limits')
  const I = await import('./instance')
  const { hashPassword, createSession, SESSION_COOKIE } = await import('../auth')
  const collab = await import('../collab')
  const Y = await import('yjs')
  const { WebSocket } = await import('ws')
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await loadProvider()
  const { blocksToStateBuffer } = await import('../md/convert')
  const app = await kit.buildRestrictedApp()
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
    for (const o of open) o.destroy()
    await new Promise<void>((r) => server.close(() => r()))
    await collab.destroyCollab()
    await app.close()
    await drop()
    setTimeout(() => process.exit(0), 300).unref()
  })

  const tag = () => randomBytes(4).toString('hex')
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const pw = await hashPassword('password123')
  const person = async (extra: Partial<typeof schema.users.$inferInsert> = {}) => {
    const email = `p-${tag()}@example.com`
    const [u] = await db.insert(schema.users).values({ email, name: 'P', passwordHash: pw, ...extra }).returning()
    const { token } = await createSession(u.id)
    return { id: u.id, email, cookie: `${SESSION_COOKIE}=${token}` }
  }
  const workspaceOf = async (cookie: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie }, payload: { name: `W ${tag()}` } })
    return (r.json() as { workspace: { id: string } }).workspace.id
  }
  /** Trip the fuse without filling a disk: LIMIT 1 MB and a pretended measurement of 2 MB. */
  const trip = () => {
    const restore = L.setLimitsForTests({ instanceStorageMb: 1 })
    I._setInstanceStorageForTests({ dbBytes: 2 * 1024 * 1024, fileBytes: 0 })
    return () => {
      I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 })
      I._setInstanceStorageForTests(null)
      restore()
    }
  }

  it('measures the real database size and DATA_DIR; the limit decides', async () => {
    const restore = L.setLimitsForTests({ instanceStorageMb: 1 })
    try {
      I._resetInstanceStorage()
      const m = await I.measureInstanceStorage()
      assert.ok(m.dbBytes > 1024 * 1024, `database ${m.dbBytes}`)
      assert.equal(m.full, true)
      L.setLimitsForTests({ instanceStorageMb: 1_000_000 })
      assert.equal((await I.measureInstanceStorage()).full, false)
    } finally {
      I._setInstanceStorageForTests(null)
      restore()
    }
  })

  it('tripped: writes under /api answer 503 INSTANCE_FULL; reading, deleting, signing in and out, consent paths and the admin API work', async () => {
    const admin = await person({ isAdmin: true })
    const u = await person()
    const ws = await workspaceOf(u.cookie)
    const page = (await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws, title: 'kept' } })).json() as { page: { id: string } }
    const untrip = trip()
    try {
      const refused = [
        await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws, title: 'x' } }),
        await app.inject({ method: 'PATCH', url: `/api/pages/${page.page.id}`, headers: { cookie: u.cookie }, payload: { title: 'renamed' } }),
        await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: u.cookie }, payload: { name: 'new' } }),
        await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '198.51.100.20', payload: { email: `n-${tag()}@example.com`, name: 'N', password: 'password123' } }),
      ]
      for (const r of refused) {
        assert.equal(r.statusCode, 503, r.body)
        assert.equal(codeOf(r), 'INSTANCE_FULL')
      }
      // reading
      assert.equal((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie: u.cookie } })).statusCode, 200)
      assert.equal((await app.inject({ method: 'GET', url: `/api/workspaces/${ws}/usage`, headers: { cookie: u.cookie } })).statusCode, 200)
      // signing in and out
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: 'password123' } })
      assert.equal(login.statusCode, 200, login.body)
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: kit.cookieOf(login) } })).statusCode < 300, true)
      // the admin API
      const ban = await app.inject({ method: 'POST', url: '/api/admin/ip-bans', headers: { cookie: admin.cookie }, payload: { ip: '203.0.113.7', minutes: 5 } })
      assert.notEqual(ban.statusCode, 503, ban.body)
      // deleting a page, then the person's own account
      assert.ok((await app.inject({ method: 'DELETE', url: `/api/pages/${page.page.id}`, headers: { cookie: u.cookie } })).statusCode < 300)
      const bye = await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: u.cookie }, payload: { confirm: u.email, password: 'password123' } })
      assert.equal(bye.statusCode, 200, bye.body)
      // auth mode tells the screens
      const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as { instanceFull?: boolean; signupFull?: boolean }
      assert.equal(mode.instanceFull, true)
      assert.equal(mode.signupFull, true)
    } finally {
      untrip()
    }
    // cleared: writes work again
    const v = await person()
    assert.equal((await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: v.cookie }, payload: { name: 'after' } })).statusCode, 200)
  })

  it('live editing: read-only while tripped (open connections reconnect read-only), read-write again when it clears', async () => {
    const u = await person()
    const ws = await workspaceOf(u.cookie)
    const id = (await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws, title: 'live' } })).json() as { page: { id: string } }
    void blocksToStateBuffer
    class CookieSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: u.cookie } })
      }
    }
    const until = async (cond: () => boolean, what: string) => {
      const end = Date.now() + 10_000
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    // the guards are chosen when a socket connects: set the fuse (not tripped) first
    const restore = L.setLimitsForTests({ instanceStorageMb: 1_000_000 })
    I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 })
    try {
      const scopes: string[] = []
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket, delay: 50, minDelay: 50, maxDelay: 200 })
      open.push(socket)
      const doc = new Y.Doc()
      const provider = new HocuspocusProvider({ websocketProvider: socket, name: id.page.id, document: doc, token: 'cookie', broadcast: false, onAuthenticated: () => scopes.push(provider.authorizedScope) })
      open.push(provider)
      await until(() => scopes.length === 1, 'the first authentication')
      assert.equal(scopes[0], 'read-write')
      L.setLimitsForTests({ instanceStorageMb: 1 })
      I._setInstanceStorageForTests({ dbBytes: 2 * 1024 * 1024, fileBytes: 0 }) // tripped
      await until(() => scopes.length >= 2, 'the reconnect after tripping')
      assert.equal(scopes.at(-1), 'readonly')
      I._setInstanceStorageForTests({ dbBytes: 0, fileBytes: 0 }) // cleared
      await until(() => scopes.length >= 3, 'the reconnect after clearing')
      assert.equal(scopes.at(-1), 'read-write')
    } finally {
      I._setInstanceStorageForTests(null)
      restore()
    }
  })

  it('admin status: the fuse item only where the setting is, an error when tripped', async () => {
    const { evaluateStatus } = await import('../status/evaluate')
    const { gatherFacts } = await import('../status/probes')
    const item = async () => evaluateStatus((await gatherFacts({ refresh: true })).facts).groups.flatMap((g) => g.items).find((i) => i.key === 'storage.instanceFuse')
    assert.equal(await item(), undefined, 'no setting, no item')
    const untrip = trip()
    try {
      const it = await item()
      assert.equal(it?.level, 'error')
      assert.equal((it?.data as { full: boolean; limit: number }).full, true)
      assert.equal((it?.data as { limit: number }).limit, 1024 * 1024)
    } finally {
      untrip()
    }
  })

  it('unset: nothing measured, nothing refused, no field in auth mode', async () => {
    assert.equal(L.limits.instanceStorageMb, undefined)
    I._resetInstanceStorage()
    assert.equal(await I.isInstanceFull(), false)
    assert.equal(I.instanceFullNow(), false)
    assert.equal(await I.instanceStorageStatus(), null, 'no measurement')
    const mode = (await app.inject({ method: 'GET', url: '/api/auth/mode' })).json() as Record<string, unknown>
    assert.equal('instanceFull' in mode, false)
    const u = await person()
    assert.equal((await app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: u.cookie }, payload: { name: 'free' } })).statusCode, 200)
  })
})

describe('instance fuse: the gate and the agent hint (no database)', () => {
  it('refuses POST, PUT and PATCH outside the open list; never GET, DELETE or the admin API', async () => {
    const { refusedWhenFull } = await import('./instanceGate')
    const r = (method: string, url: string) => refusedWhenFull({ method, url, routeOptions: { url } } as never)
    assert.equal(r('POST', '/api/pages'), true)
    assert.equal(r('PATCH', '/api/pages/:id/props'), true)
    assert.equal(r('PUT', '/api/pages/:id/ink'), true)
    assert.equal(r('POST', '/api/auth/register'), true)
    assert.equal(r('POST', '/api/public/forms/:token'), true)
    assert.equal(r('GET', '/api/pages/:id'), false)
    assert.equal(r('DELETE', '/api/pages/:id'), false)
    assert.equal(r('DELETE', '/api/me'), false)
    assert.equal(r('POST', '/api/auth/login'), false)
    assert.equal(r('POST', '/api/legal/consent'), false)
    assert.equal(r('POST', '/api/admin/ip-bans'), false)
    assert.equal(r('POST', '/api/workspaces/:id/query'), false)
  })

  it('MCP: a refused write tells the agent not to retry and what to tell the user', async () => {
    const { restrictedModeHint } = await import('../mcpTools/core')
    const hint = restrictedModeHint('INSTANCE_FULL', {})!
    assert.match(hint, /storage is full/)
    assert.match(hint, /Do not retry/)
    assert.match(hint, /operator/)
  })
})
