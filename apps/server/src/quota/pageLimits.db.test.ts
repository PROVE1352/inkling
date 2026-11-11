// LIMIT_PAGES_PER_WORKSPACE on every path that creates pages (docs/adr/2505-*): just below the limit
// succeeds, at the limit LIMIT_PAGES and nothing is created (batch paths: no partial result),
// concurrent requests pass only as many as there is room for, the MCP tools are refused through REST.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

describe('[db] page limit on every creating path', { skip: !process.env.DATABASE_URL }, () => {
  let app: import('fastify').FastifyInstance
  let h: typeof import('../mcpTools/testHarness')
  let L: typeof import('../limits')
  let db: typeof import('../db/index').db
  let sql: typeof import('drizzle-orm').sql
  let closeDb: () => Promise<void>
  let restore: (() => void) | null = null

  before(async () => {
    h = await import('../mcpTools/testHarness')
    L = await import('../limits')
    ;({ db, closeDb } = await import('../db/index'))
    ;({ sql } = await import('drizzle-orm'))
    app = await h.buildTestApp()
  })
  after(async () => {
    restore?.()
    await app?.close()
    await closeDb()
  })

  const count = async (ws: string) =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${ws}`)) as unknown as { n: number }[])[0].n)
  /** Room for exactly `n` more pages in `ws`. */
  const roomFor = async (ws: string, n: number) => {
    restore?.()
    restore = L.setLimitsForTests({ pagesPerWorkspace: (await count(ws)) + n })
  }
  const unlimited = () => {
    restore?.()
    restore = null
  }

  async function fresh(name: string) {
    const u = await h.makeUser(name)
    const ws = await h.makeWorkspace(u)
    return { u, ws }
  }
  const call = (u: { cookie: string }, method: 'POST' | 'GET' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  /** The path succeeds while there is room for `need`, and the same request at the limit is refused with nothing made. */
  async function limited(ws: string, need: number, run: () => Promise<{ statusCode: number; body: string }>) {
    await roomFor(ws, need)
    const ok = await run()
    assert.ok(ok.statusCode < 300, `just below the limit: ${ok.statusCode} ${ok.body}`)
    const before = await count(ws)
    const refused = await run()
    assert.equal(refused.statusCode, 403, refused.body)
    const err = JSON.parse(refused.body).error
    assert.equal(err.code, 'LIMIT_PAGES')
    assert.equal(typeof err.limit, 'number')
    assert.equal(err.used, before)
    assert.equal(await count(ws), before, 'nothing created')
    unlimited()
  }

  it('POST /pages: below, at and past the limit', async () => {
    const { u, ws } = await fresh('pl-create')
    await limited(ws.id, 1, () => call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'p' }))
  })

  it('POST /pages: concurrent requests, only as many as there is room for', async () => {
    const { u, ws } = await fresh('pl-race')
    await roomFor(ws.id, 3)
    const before = await count(ws.id)
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: `r${i}` })))
    assert.equal(res.filter((r) => r.statusCode === 200).length, 3)
    assert.equal(res.filter((r) => r.statusCode === 403).length, 5)
    assert.equal(await count(ws.id), before + 3)
    unlimited()
  })

  it('duplicate copies the whole subtree or nothing', async () => {
    const { u, ws } = await fresh('pl-dup')
    const root = (await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'root' })).json().page
    await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'child', parentId: root.id })
    // room for one page, the copy needs two: refused whole
    await roomFor(ws.id, 1)
    const before = await count(ws.id)
    const r = await call(u, 'POST', `/api/pages/${root.id}/duplicate`)
    assert.equal(r.statusCode, 403, r.body)
    assert.equal(r.json().error.code, 'LIMIT_PAGES')
    assert.equal(await count(ws.id), before)
    await limited(ws.id, 2, () => call(u, 'POST', `/api/pages/${root.id}/duplicate`))
  })

  it('expand to canvas', async () => {
    const { u, ws } = await fresh('pl-canvas')
    const p = (await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'doc' })).json().page
    await limited(ws.id, 1, () => call(u, 'POST', `/api/pages/${p.id}/expand-canvas`))
  })

  it('collection rows, one and in a batch (all or none)', async () => {
    const { u, ws } = await fresh('pl-rows')
    const coll = (await call(u, 'POST', '/api/pages', { workspaceId: ws.id, title: 'db', kind: 'collection' })).json().page
    await limited(ws.id, 1, () => call(u, 'POST', `/api/pages/${coll.id}/collection/rows`, { title: 'row' }))
    await roomFor(ws.id, 2)
    const before = await count(ws.id)
    const r = await call(u, 'POST', `/api/pages/${coll.id}/collection/rows/batch`, { rows: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    assert.equal(r.statusCode, 403, r.body)
    assert.equal(await count(ws.id), before, 'no partial batch')
    await limited(ws.id, 3, () => call(u, 'POST', `/api/pages/${coll.id}/collection/rows/batch`, { rows: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }))
  })

  it('page from a template, the to-do document, the onboarding sample', async () => {
    const { u, ws } = await fresh('pl-tpl')
    await roomFor(ws.id, 0)
    const tpl = await call(u, 'POST', '/api/pages/from-template', { workspaceId: ws.id, builtinKey: 'meeting' })
    assert.equal(tpl.statusCode, 403, tpl.body)
    assert.equal(tpl.json().error.code, 'LIMIT_PAGES')
    const todo = await call(u, 'POST', `/api/workspaces/${ws.id}/tasks`, { title: 'x', date: '2026-11-12' })
    assert.equal(todo.json().error?.code, 'LIMIT_PAGES', todo.body)
    const sample = await call(u, 'POST', '/api/me/onboarding/sample', { workspaceId: ws.id })
    assert.equal(sample.json().error?.code, 'LIMIT_PAGES', sample.body)
    assert.equal(await count(ws.id), 0)
    unlimited()
  })

  it('Markdown import (single file and folder zip)', async () => {
    const { u, ws } = await fresh('pl-import')
    const boundary = '----w22a'
    const md = (name: string, body: string) => ({
      payload:
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n` +
        body +
        `\r\n--${boundary}--\r\n`,
      headers: { cookie: u.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    await limited(ws.id, 1, () => app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/import`, ...md('a.md', '# A\n\ntext') }))
  })

  it('web clipper', async () => {
    const { u, ws } = await fresh('pl-clip')
    await limited(ws.id, 1, () => call(u, 'POST', '/api/clip', { workspaceId: ws.id, title: 'clip', text: 'hello', mode: 'link' }))
  })

  it('MCP tools are refused through REST: create_page, create_row, create_collection, create_from_template, import_folder, split_page', async () => {
    const { u, ws } = await fresh('pl-mcp')
    const M = await h.connectMcp(app, u, await h.mintToken(u))
    try {
      const doc = await M.tool('create_page', { workspaceId: ws.id, title: 'long', markdown: '## One\n\na\n\n## Two\n\nb\n' })
      assert.equal(doc.isError, false, doc.text)
      const coll = await M.tool('create_collection', { workspaceId: ws.id, title: 'db', fields: [] })
      assert.equal(coll.isError, false, coll.text)
      const collId = /[0-9a-f-]{36}/.exec(coll.text)![0]
      const docId = /[0-9a-f-]{36}/.exec(doc.text)![0]
      await roomFor(ws.id, 0)
      const before = await count(ws.id)
      for (const [name, args] of [
        ['create_page', { workspaceId: ws.id, title: 'x' }],
        ['create_row', { collectionId: collId, title: 'r' }],
        ['create_collection', { workspaceId: ws.id, title: 'db2', fields: [] }],
        ['create_from_template', { workspaceId: ws.id, template: 'meeting' }],
        ['import_folder', { workspaceId: ws.id, folderName: 'f', files: [{ path: 'a.md', markdown: '# a' }] }],
        ['split_page', { pageId: docId, level: 2 }],
      ] as const) {
        const r = await M.tool(name, args as Record<string, unknown>)
        assert.equal(r.isError, true, `${name}: ${r.text}`)
        assert.match(r.text, /LIMIT_PAGES|page limit|pages \(the trash counts too\)|of \d+ pages/i, `${name}: ${r.text}`)
      }
      assert.equal(await count(ws.id), before)
    } finally {
      unlimited()
      await M.close()
    }
  })

  it('no limit set: the room check reads nothing and refuses nothing', async () => {
    unlimited()
    const { assertWorkspaceRoom, assertUserRoom, assertWorkspaceWritable } = await import('./room')
    const exec = { execute: async () => { throw new Error('read the database') } }
    await assertWorkspaceRoom(exec, '00000000-0000-0000-0000-000000000000', { pages: 1000, bytes: 1e12, members: 1000 })
    await assertUserRoom(exec, '00000000-0000-0000-0000-000000000000', { workspaces: 1000 })
    await assertWorkspaceWritable(exec, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  })
})
