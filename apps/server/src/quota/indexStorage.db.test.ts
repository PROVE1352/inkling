// Search and section indexes count toward a workspace's storage (0.22.1, contract §15, review N3,
// docs/adr/2545-*). Ported from the review's w22-reports/sec2/re/amp.db.test.ts: 1 MB appends of random
// words went on until the bodies alone reached 20 MB (21 appends) while page_chunks grew the database by
// 341 MB. Here (2 MB, 200 KB appends) the store reserves an estimate of the index rows with each body,
// so the appends stop after a fraction of what the bodies alone would allow, and the recount (with a
// limit) adds the index rows themselves. Without a limit the count is that of 0.22.0.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

describe('[db] indexes count toward workspace storage', { skip: !process.env.DATABASE_URL }, () => {
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let S: typeof import('./storage')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let app: Awaited<ReturnType<typeof import('../mcpTools/testHarness').buildTestApp>>
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
    setTimeout(() => process.exit(0), 300).unref()
  })

  const word = () => randomBytes(6).toString('base64').replace(/[^a-z]/gi, 'q').slice(0, 2 + Math.floor(Math.random() * 7)).toLowerCase()
  const text = (bytes: number) => Array.from({ length: Math.ceil(bytes / 480) }, () => Array.from({ length: 80 }, word).join(' ')).join('\n\n').slice(0, bytes)
  const indexRows = async (exec: Pick<typeof db, 'execute'>, ws: string) =>
    Number(
      (
        (await exec.execute(sql`
          SELECT (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM page_texts t WHERE page_id IN (SELECT id FROM pages WHERE workspace_id = ${ws}))
               + (SELECT coalesce(sum(pg_column_size(c.*)), 0) FROM page_chunks c WHERE workspace_id = ${ws})
               + (SELECT coalesce(sum(pg_column_size(v.*)), 0) FROM page_chunk_vectors v WHERE workspace_id = ${ws})
               + (SELECT coalesce(sum(pg_column_size(k.*)), 0) FROM page_tasks k WHERE workspace_id = ${ws})
               + (SELECT coalesce(sum(pg_column_size(l.*)), 0) FROM page_links l WHERE source_page_id IN (SELECT id FROM pages WHERE workspace_id = ${ws}))
               + (SELECT coalesce(sum(pg_column_size(g.*)), 0) FROM page_tags g WHERE page_id IN (SELECT id FROM pages WHERE workspace_id = ${ws}))
               + (SELECT coalesce(sum(pg_column_size(f.*)), 0) FROM page_former_titles f WHERE workspace_id = ${ws}) AS n
        `)) as unknown as { n: string }[]
      )[0].n,
    )

  it('200 KB appends (one page each) into a 2 MB workspace stop after a few (bodies alone would take about nine); the recount counts the index rows', async () => {
    const u = await h.makeUser('idx-n3')
    const ws = await h.makeWorkspace(u)
    const restore = L.setLimitsForTests({ workspaceStorageMb: 2 })
    let pageId = ''
    try {
      await S.recountWorkspaceStorage(ws.id)
      let ok = 0
      let code = ''
      // one page per append, as the review did: each body stays under the per-page cap (a quarter of the limit)
      for (let i = 0; i < 15 && !code; i++) {
        const c = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws.id, title: `amp ${i}` } })
        if (c.statusCode !== 200) {
          code = (c.json() as { error?: { code?: string } }).error?.code ?? String(c.statusCode)
          break
        }
        pageId = (c.json() as { page: { id: string } }).page.id
        const r = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/content`, headers: { cookie: u.cookie }, payload: { markdown: text(200_000), mode: 'append' } })
        if (r.statusCode === 200) ok++
        else code = (r.json() as { error?: { code?: string } }).error?.code ?? String(r.statusCode)
      }
      console.log(`[N3] 200 KB appends into 2 MB: ${ok} taken, then ${code}`)
      assert.equal(code, 'LIMIT_STORAGE')
      assert.ok(ok >= 1 && ok <= 5, `appends taken: ${ok}`)
    } finally {
      restore()
    }
    const { flushDocIndexes } = await import('../docIndexer')
    await flushDocIndexes()
    // a store or index pass that lands after the flush must not fall between the reads: all three see one snapshot
    const { rows, plain, counted } = await db.transaction(
      async (tx) => {
        const rows = await indexRows(tx, ws.id)
        const plain = await S.countWorkspaceStorage(tx, ws.id)
        const restore2 = L.setLimitsForTests({ workspaceStorageMb: 2 })
        try {
          return { rows, plain, counted: await S.countWorkspaceStorage(tx, ws.id) }
        } finally {
          restore2()
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    assert.ok(rows > 100_000, `index rows were written: ${rows}`)
    assert.equal(counted.total - plain.total, rows, 'with a limit the count adds exactly the index rows')
    assert.equal(counted.fileBytes, plain.fileBytes)
  })

  it('without a storage limit: the body store moves no cache (0.22.0)', async () => {
    const u = await h.makeUser('idx-plain')
    const ws = await h.makeWorkspace(u)
    const c = await app.inject({ method: 'POST', url: '/api/pages', headers: { cookie: u.cookie }, payload: { workspaceId: ws.id, title: 'plain' } })
    const pageId = (c.json() as { page: { id: string } }).page.id
    await db.execute(sql`UPDATE workspaces SET storage_bytes = 1234 WHERE id = ${ws.id}`)
    const r = await app.inject({ method: 'POST', url: `/api/pages/${pageId}/content`, headers: { cookie: u.cookie }, payload: { markdown: text(50_000), mode: 'append' } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await S.noteBodyStore(pageId, 100_000), null)
    const [w] = (await db.execute(sql`SELECT storage_bytes AS n FROM workspaces WHERE id = ${ws.id}`)) as unknown as { n: string }[]
    assert.equal(Number(w.n), 1234)
  })
})
