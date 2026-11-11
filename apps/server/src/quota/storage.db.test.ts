// Storage, file size and version limits (docs/adr/2505-*, 2506-*): LIMIT_FILE_MB per upload,
// LIMIT_WORKSPACE_STORAGE_MB (uploads reserve their bytes, concurrent uploads pass only as many as
// fit, a full workspace is read-only for new pages, comments, body writes from REST and MCP, and live
// editing, while deleting and exporting work; after a delete a recount makes it writable again),
// the usage route, LIMIT_VERSIONS_PER_PAGE.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

process.env.DATA_DIR ??= path.join(tmpdir(), `inkling-w22a-${process.pid}`)
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })

describe('[db] storage, file and version limits', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let S: typeof import('./storage')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let closeDb: () => Promise<void>

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    S = await import('./storage')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    app = await h.buildTestApp()
  })
  after(async () => {
    await app?.close()
    await closeDb()
  })

  const call = (u: { cookie: string }, method: 'POST' | 'PATCH' | 'DELETE' | 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const upload = (u: { cookie: string }, ws: string, bytes: number, name = 'a.txt') => {
    const boundary = '----w22astore'
    return app.inject({
      method: 'POST',
      url: `/api/files?workspaceId=${ws}`,
      headers: { cookie: u.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload:
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n` +
        'x'.repeat(bytes) +
        `\r\n--${boundary}--\r\n`,
    })
  }
  const fileCount = async (ws: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM files WHERE workspace_id = ${ws}`)) as unknown as { n: number }[])[0].n)

  it('LIMIT_FILE_MB: a file past it gets 413 LIMIT_FILE in bytes; without it the answer is as before', async () => {
    const u = await h.makeUser('st-file')
    const ws = await h.makeWorkspace(u)
    const restore = L.setLimitsForTests({ fileMb: 0.001 }) // 1048 bytes
    try {
      assert.equal((await upload(u, ws.id, 1000)).statusCode, 200)
      const r = await upload(u, ws.id, 5000)
      assert.equal(r.statusCode, 413, r.body)
      assert.equal(r.json().error.code, 'LIMIT_FILE')
      assert.equal(r.json().error.limit, 1048)
      assert.equal(await fileCount(ws.id), 1)
    } finally {
      restore()
    }
    assert.equal((await upload(u, ws.id, 5000)).statusCode, 200)
  })

  it('storage: uploads reserve their bytes; concurrent uploads pass only as many as fit', async () => {
    const u = await h.makeUser('st-race')
    const ws = await h.makeWorkspace(u)
    await S.recountWorkspaceStorage(ws.id)
    // 0.22.1 (review N2): a 3,000-byte file counts max(size, 4096) + 1024 = 5,120 bytes, so three fit in 15,728
    const restore = L.setLimitsForTests({ workspaceStorageMb: 0.015 }) // 15728 bytes
    try {
      const res = await Promise.all(Array.from({ length: 6 }, () => upload(u, ws.id, 3000)))
      assert.equal(res.filter((r) => r.statusCode === 200).length, 3)
      const refused = res.find((r) => r.statusCode === 413)!
      assert.equal(refused.json().error.code, 'LIMIT_STORAGE')
      assert.equal(refused.json().error.limit, 15728)
      assert.equal(await fileCount(ws.id), 3)
    } finally {
      restore()
    }
  })

  it('a full workspace: no new page, upload, comment, body write (REST and MCP), version or template; delete and export work; a recount after deleting frees it', async () => {
    const u = await h.makeUser('st-full')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'doc', [{ type: 'paragraph', content: 'hello' } as never])
    const victim = await h.makeDocPage(ws.id, u.id, 'big', [{ type: 'paragraph', content: 'y'.repeat(20_000) } as never])
    const restore = L.setLimitsForTests({ workspaceStorageMb: 0.015 }) // 15728 bytes: the big page alone passes it
    const M = await h.connectMcp(app, u, await h.mintToken(u))
    try {
      const counted = await S.recountWorkspaceStorage(ws.id)
      assert.equal(counted.over, true, `over: ${counted.total}`)
      const expectFull = (r: { statusCode: number; body: string }, what: string) => {
        assert.equal(r.statusCode, 413, `${what}: ${r.body}`)
        assert.equal(JSON.parse(r.body).error.code, 'LIMIT_STORAGE', what)
      }
      expectFull(await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'new' }), 'new page')
      expectFull(await upload(u, ws.id, 10), 'upload')
      expectFull(await call(u, 'POST', `/api/pages/${page.id}/comments`, { blockId: 'b1', body: 'hi' }), 'comment')
      expectFull(await call(u, 'POST', `/api/pages/${page.id}/snapshots`, {}), 'manual version')
      const mcp = await M.tool('update_page', { pageId: page.id, markdown: 'more', mode: 'append' })
      assert.equal(mcp.isError, true, mcp.text)
      assert.match(mcp.text, /storage|LIMIT_STORAGE/i)
      assert.equal(await S.collabStorageReadOnly(page.id, ws.id), true, 'live editing is read-only')
      // export and delete always work
      assert.equal((await call(u, 'GET', `/api/pages/${page.id}/export`)).statusCode, 200)
      assert.equal((await call(u, 'DELETE', `/api/pages/${victim.id}`)).statusCode, 204)
      assert.equal((await call(u, 'DELETE', `/api/pages/${victim.id}/purge`)).statusCode, 204)
      const after = await S.recountWorkspaceStorage(ws.id)
      assert.equal(after.over, false, `after delete: ${after.total}`)
      assert.equal((await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'again' })).statusCode, 200)
      assert.equal(await S.collabStorageReadOnly(page.id, ws.id), false)
    } finally {
      restore()
      await M.close()
    }
  })

  it('MCP upload_file: refused past LIMIT_FILE_MB and in a full workspace', async () => {
    const u = await h.makeUser('st-mcp-up')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'doc', [{ type: 'paragraph', content: 'a' } as never])
    const M = await h.connectMcp(app, { ...u, via: 'Claude' }, await h.mintToken(u, 'notes', 'Claude'))
    try {
      let restore = L.setLimitsForTests({ fileMb: 0.001 })
      try {
        const big = await M.tool('upload_file', { pageId: page.id, name: 'big.txt', text: 'x'.repeat(5000), attachOnly: true })
        assert.equal(big.isError, true, big.text)
        assert.match(big.text, /too large|LIMIT_FILE/i)
        const small = await M.tool('upload_file', { pageId: page.id, name: 'small.txt', text: 'x'.repeat(100), attachOnly: true })
        assert.equal(small.isError, false, small.text)
      } finally {
        restore()
      }
      await S.recountWorkspaceStorage(ws.id)
      restore = L.setLimitsForTests({ workspaceStorageMb: 0.0001 })
      try {
        const full = await M.tool('upload_file', { pageId: page.id, name: 'more.txt', text: 'y', attachOnly: true })
        assert.equal(full.isError, true, full.text)
        assert.match(full.text, /storage|LIMIT_STORAGE/i)
      } finally {
        restore()
      }
    } finally {
      await M.close()
    }
  })

  it('the collab store moves the cached use and flips a workspace read-only past its limit', async () => {
    const u = await h.makeUser('st-collab')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'doc', [{ type: 'paragraph', content: 'a' } as never])
    await S.recountWorkspaceStorage(ws.id)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 0.01 })
    try {
      await S.noteBodyStore(page.id, 50_000) // the body grew by ~50 kB in live editing
      const [w] = (await db.execute(sql`SELECT over_storage AS over, storage_bytes AS used FROM workspaces WHERE id = ${ws.id}`)) as unknown as { over: boolean; used: string }[]
      assert.equal(w.over, true)
      assert.ok(Number(w.used) > 10_000)
      assert.equal(await S.collabStorageReadOnly(page.id, ws.id), true)
    } finally {
      restore()
    }
    assert.equal(await S.collabStorageReadOnly(page.id, ws.id), false, 'no limit: a stale flag is ignored')
  })

  it('GET /workspaces/:id/usage: members only; with and without limits', async () => {
    const u = await h.makeUser('st-usage')
    const other = await h.makeUser('st-usage-x')
    const ws = await h.makeWorkspace(u)
    await upload(u, ws.id, 1234)
    const plain = (await call(u, 'GET', `/api/workspaces/${ws.id}/usage`)).json()
    assert.deepEqual({ members: plain.members, fileBytes: plain.fileBytes, limits: plain.limits }, { members: 1, fileBytes: 1234, limits: {} })
    assert.ok(plain.storageBytes >= 1234)
    assert.notEqual((await call(other, 'GET', `/api/workspaces/${ws.id}/usage`)).statusCode, 200)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 20, pagesPerWorkspace: 300, membersPerWorkspace: 4 })
    try {
      const limited = (await call(u, 'GET', `/api/workspaces/${ws.id}/usage`)).json()
      assert.deepEqual(limited.limits, { members: 4, pages: 300, storageBytes: 20 * 1024 * 1024 })
      assert.equal(limited.storageBytes, plain.storageBytes)
    } finally {
      restore()
    }
  })

  it('LIMIT_VERSIONS_PER_PAGE: pruning keeps that many; AI-step caps scale down', async () => {
    const { snapshotBudget } = await import('./versions')
    assert.deepEqual(snapshotBudget(), { total: 50, perClient: 20, perPage: 30 })
    const u = await h.makeUser('st-ver')
    const ws = await h.makeWorkspace(u)
    const page = await h.makeDocPage(ws.id, u.id, 'doc', [{ type: 'paragraph', content: 'v' } as never])
    const restore = L.setLimitsForTests({ versionsPerPage: 3 })
    try {
      assert.deepEqual(snapshotBudget(), { total: 3, perClient: 1, perPage: 1 })
      for (let i = 0; i < 6; i++) assert.equal((await call(u, 'POST', `/api/pages/${page.id}/snapshots`, { label: `v${i}` })).statusCode, 200)
      const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM page_snapshots WHERE page_id = ${page.id}`)) as unknown as { n: number }[]
      assert.equal(n, 3)
    } finally {
      restore()
    }
  })
})
