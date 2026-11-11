// A workspace read-only for storage refuses the writes that grow it (contract §14, security review F5,
// docs/adr/2533-*). The review's R10: PATCH /pages/:id/props answered 200 five times (≈ 800 KB each) in a
// workspace whose new pages were already refused. Each route below is sent with a real body to a full
// workspace (413 LIMIT_STORAGE) and to one with room (2xx), and once more with no limit set, where the
// same full-flagged workspace takes everything (a stale flag is ignored, the 0.21.1 behaviour).
// Also: growth that the cache did not see yet (props, fields, …) moves it at once, so a run of large
// writes into a workspace with room stops at the limit instead of at the next recount.
process.env.SIGNUP_REQUIRE_KEY = '0'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

describe('[db] writes to a workspace that is read-only for storage (F5)', { skip: !process.env.DATABASE_URL }, async () => {
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const L = await import('../limits')
  const S = await import('./storage')
  const schema = await import('../db/schema')
  const h = await import('../mcpTools/testHarness')
  const app = await h.buildTestApp()
  after(async () => {
    await app.close()
    await closeDb()
    setTimeout(() => process.exit(0), 300).unref()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const idOf = (r: { json: () => unknown }) => {
    const j = r.json() as { page?: { id: string }; view?: { id: string }; template?: { id: string }; comment?: { id: string }; id?: string }
    return j.page?.id ?? j.view?.id ?? j.template?.id ?? j.comment?.id ?? j.id!
  }
  const req = (u: U, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, payload: payload as Record<string, unknown> })
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

  /** A workspace with a document, a collection with a row, a view, a row template and a comment. */
  const setup = async (u: U) => {
    const ws = await h.makeWorkspace(u)
    const doc = await h.makeDocPage(ws.id, u.id, 'Doc', [] as never)
    const coll = idOf(await req(u, 'POST', '/api/pages', { workspaceId: ws.id, kind: 'collection', title: 'db' }))
    const row = idOf(await req(u, 'POST', '/api/pages', { workspaceId: ws.id, parentId: coll, title: 'row' }))
    const view = idOf(await req(u, 'POST', `/api/pages/${coll}/collection/views`, { name: 'v', type: 'table' }))
    const tpl = (await req(u, 'POST', `/api/pages/${coll}/collection/row-templates`, { name: 't' })).json() as { template: { id: string } }
    const comment = idOf(await req(u, 'POST', `/api/pages/${doc.id}/comments`, { blockId: 'b1', body: 'first' }))
    return { ws: ws.id, doc: doc.id, coll, row, view, tpl: tpl.template.id, comment }
  }
  const big = (n: number) => randomBytes(Math.floor((n * 3) / 4)).toString('base64')
  /** The writes that grow a workspace, with real bodies. */
  const writes = (x: Awaited<ReturnType<typeof setup>>): [string, 'POST' | 'PUT' | 'PATCH', string, unknown][] => [
    ['row props (R10)', 'PATCH', `/api/pages/${x.row}/props`, { props: { note: big(2000) } }],
    ['collection fields', 'PUT', `/api/pages/${x.coll}/collection/fields`, { fields: [{ id: 'f1', name: 'Notes', type: 'text' }] }],
    ['new view', 'POST', `/api/pages/${x.coll}/collection/views`, { name: 'board', type: 'board' }],
    ['view config', 'PATCH', `/api/collection-views/${x.view}`, { name: 'renamed' }],
    ['new row template', 'POST', `/api/pages/${x.coll}/collection/row-templates`, { name: 'second', title: big(200) }],
    ['row template', 'PATCH', `/api/collection-row-templates/${x.tpl}`, { title: big(200) }],
    ['rows batch', 'PATCH', `/api/pages/${x.coll}/collection/rows/batch`, { rows: [{ id: x.row, props: { note: big(500) } }] }],
    ['page title', 'PATCH', `/api/pages/${x.doc}`, { title: 'A new title' }],
    ['page aliases', 'PATCH', `/api/pages/${x.doc}`, { aliases: ['other name'] }],
    ['edited comment', 'PATCH', `/api/comments/${x.comment}`, { body: big(1000) }],
    ['new comment', 'POST', `/api/pages/${x.doc}/comments`, { blockId: 'b1', body: 'second' }],
    ['custom template', 'POST', `/api/workspaces/${x.ws}/templates`, { name: 'Mine', fromPageId: x.doc }],
    ['share link', 'POST', `/api/pages/${x.doc}/share`, {}],
    ['new page', 'POST', '/api/pages', { workspaceId: x.ws, title: 'one more' }],
  ]
  /** Really full: a 2 MB file row, recounted (a write that does not fit recounts once before refusing). */
  const full = async (ws: string, by: string) => {
    await db.insert(schema.files).values({ id: randomUUID(), workspaceId: ws, createdBy: by, name: 'big.bin', mime: 'application/octet-stream', size: 2 * 1024 * 1024 })
    if (L.limits.workspaceStorageMb != null) assert.equal((await S.recountWorkspaceStorage(ws)).over, true)
    else await db.execute(sql`UPDATE workspaces SET over_storage = true, storage_bytes = 2000000 WHERE id = ${ws}`)
  }

  it('R10 and the other growing writes: 413 LIMIT_STORAGE in a full workspace, 2xx with room', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      const u = await h.makeUser('ro-full')
      const fullWs = await setup(u)
      const roomy = await setup(u)
      await full(fullWs.ws, u.id)
      const refused: string[] = []
      for (const [name, method, url, body] of writes(fullWs)) {
        const r = await req(u, method, url, body)
        refused.push(`${name}=${r.statusCode}`)
        assert.equal(r.statusCode, 413, `${name}: ${r.body}`)
        assert.equal(codeOf(r), 'LIMIT_STORAGE', name)
      }
      // R10 exactly: five ~800 KB property writes
      const r10: number[] = []
      for (let i = 0; i < 5; i++) {
        const props: Record<string, string> = {}
        for (let k = 0; k < 20; k++) props[`k${i}_${k}`] = randomBytes(30_000).toString('base64')
        r10.push((await req(u, 'PATCH', `/api/pages/${fullWs.row}/props`, { props })).statusCode)
      }
      console.log(`[F5] full workspace: ${refused.join(', ')}; R10 five ~800 KB prop writes: ${r10.join(',')}`)
      assert.deepEqual(r10, [413, 413, 413, 413, 413])
      // control: the same writes in a workspace with room
      for (const [name, method, url, body] of writes(roomy)) {
        const r = await req(u, method, url, body)
        assert.ok(r.statusCode < 300, `${name} with room: ${r.statusCode} ${r.body}`)
      }
      // what stays open in a full workspace: moving a page, resolving a comment, deleting
      assert.ok((await req(u, 'PATCH', `/api/pages/${fullWs.doc}`, { sortOrder: 5 })).statusCode < 300, 'moving')
      assert.ok((await req(u, 'PATCH', `/api/comments/${fullWs.comment}`, { resolved: true })).statusCode < 300, 'resolving')
      const del = await app.inject({ method: 'DELETE', url: `/api/pages/${fullWs.row}`, headers: { cookie: u.cookie } })
      assert.ok(del.statusCode < 300, `deleting: ${del.body}`)
    } finally {
      restore()
    }
  })

  it('growth the cache has not seen yet counts at once: large writes into a workspace with room stop at the limit', async () => {
    const restore = L.setLimitsForTests({ workspaceStorageMb: 1 })
    try {
      const u = await h.makeUser('ro-grow')
      const x = await setup(u)
      await S.recountWorkspaceStorage(x.ws)
      const codes: number[] = []
      for (let i = 0; i < 6; i++) {
        const props: Record<string, string> = {}
        for (let k = 0; k < 8; k++) props[`k${i}_${k}`] = randomBytes(30_000).toString('base64') // ≈ 320 KB
        codes.push((await req(u, 'PATCH', `/api/pages/${x.row}/props`, { props })).statusCode)
      }
      const c = await S.countWorkspaceStorage(db, x.ws)
      console.log(`[F5] six ≈320 KB prop writes into a 1 MB workspace: ${codes.join(',')}; stored ${c.total}`)
      assert.ok(codes.includes(413), 'refused before the next recount')
      assert.ok(c.total <= L.mbToBytes(1), `stored ${c.total}`)
    } finally {
      restore()
    }
  })

  it('without a storage limit: the same writes all go through, even with a stale full flag (0.21.1)', async () => {
    assert.equal(L.limits.workspaceStorageMb, null)
    const u = await h.makeUser('ro-off')
    const x = await setup(u)
    await full(x.ws, u.id)
    for (const [name, method, url, body] of writes(x)) {
      const r = await req(u, method, url, body)
      assert.ok(r.statusCode < 300, `${name}: ${r.statusCode} ${r.body}`)
    }
    const [w] = (await db.execute(sql`SELECT storage_bytes AS n FROM workspaces WHERE id = ${x.ws}`)) as unknown as { n: string }[]
    assert.equal(Number(w.n), 2000000, 'the cache is not moved without a limit')
  })
})
