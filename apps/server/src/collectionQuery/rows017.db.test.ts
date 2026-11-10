// 0.17 collection rows end to end (docs/adr/2140-*, 2141-*, 2142-*, 2144-*, 2146-*): automatic values
// (created / edited time and by, unique IDs with the 0051 triggers), email / phone, the view filter
// tree in the chart aggregate, sub-items (one parent, no cycles, trash, query_rows under/depth, MCP
// parent), and page guests opening a collection without learning anything outside their trees.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-rows017-${process.pid}`

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { CollectionField, RowDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL
mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })

describe('[db] 0.17 collection rows: automatic values, IDs, sub-items, guests', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('../errors')
  const collab = await import('../collab')
  const changeLog = await import('../context/changeLog')

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(import('@fastify/cookie'))
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: String(err.issues[0]?.message) } })
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
      console.error(err)
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app.register(
      async (api) => {
        const r = (m: Promise<Record<string, unknown>>, fn: string) => m.then((x) => (x[fn] as (a: FastifyInstance) => Promise<void>)(api))
        await r(import('../routes/workspaces'), 'registerWorkspaceRoutes')
        await r(import('../routes/workspaceAdmin'), 'registerWorkspaceAdminRoutes')
        await r(import('../routes/pages'), 'registerPageRoutes')
        await r(import('../routes/pageContent'), 'registerPageContentRoutes')
        await r(import('../routes/editLock'), 'registerEditLockRoutes')
        await r(import('../routes/pageAccess'), 'registerPageAccessRoutes')
        await r(import('../routes/collections'), 'registerCollectionRoutes')
        await r(import('../routes/charts'), 'registerChartRoutes')
        await r(import('../routes/templates'), 'registerTemplateRoutes')
        await r(import('../routes/memberStatus'), 'registerMemberStatusRoutes')
        await r(import('../routes/teamAgents'), 'registerTeamAgentRoutes')
        await r(import('../routes/agentTaint'), 'registerAgentTaintRoutes')
        await r(import('../routes/oauth'), 'registerOAuthApiRoutes')
      },
      { prefix: '/api' },
    )
    await app.ready()
    return app
  }

  const app = await buildApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: string, url: string, payload?: unknown) => {
    const res = await as(u, method, url, payload)
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }
  const W = `r17${randomBytes(3).toString('hex')}`

  let O: U
  let M: U
  let G: U
  let ws: { id: string }

  const newCollection = async (u: U, title: string, fields: CollectionField[]): Promise<string> => {
    const { page } = await ok(u, 'POST', '/api/pages', { workspaceId: ws.id, kind: 'collection', title })
    if (fields.length) await ok(u, 'PUT', `/api/pages/${page.id}/collection/fields`, { fields })
    return page.id as string
  }
  const newRow = async (u: U, coll: string, title: string, props: Record<string, unknown> = {}): Promise<RowDTO> =>
    (await ok(u, 'POST', `/api/pages/${coll}/collection/rows`, { title, props, template: null })).row as RowDTO
  const rowsOf = async (u: U, coll: string) => (await ok(u, 'GET', `/api/pages/${coll}/collection`)) as { rows: RowDTO[]; refs: Record<string, unknown>; people?: Record<string, string>; collection: { fields: CollectionField[] } }
  const numbers = async (coll: string) =>
    (await db.select({ id: schema.pages.id, n: schema.pages.rowNumber, title: schema.pages.title }).from(schema.pages).where(eq(schema.pages.parentId, coll)))

  before(async () => {
    O = await h.makeUser('Olivia')
    M = await h.makeUser('Minho')
    G = await h.makeUser('Gwen')
    ws = await h.makeWorkspace(O, [M])
  })

  describe('unique IDs (migration 0051 triggers)', () => {
    let coll = ''
    it('a new ID property numbers the existing rows in manual order, trashed rows included', async () => {
      coll = await newCollection(O, `Tasks ${W}`, [{ id: 'st', name: 'Status', type: 'text' }])
      const a = await newRow(O, coll, 'first')
      const b = await newRow(O, coll, 'second')
      const c = await newRow(O, coll, 'third')
      await ok(O, 'DELETE', `/api/pages/${c.id}`)
      for (const r of await numbers(coll)) assert.equal(r.n, null, 'no number before the property exists')
      await ok(O, 'PUT', `/api/pages/${coll}/collection/fields`, {
        fields: [{ id: 'st', name: 'Status', type: 'text' }, { id: 'tid', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'TASK' } }],
      })
      const by = new Map((await numbers(coll)).map((r) => [r.id, r.n]))
      assert.deepEqual([by.get(a.id), by.get(b.id), by.get(c.id)], [1, 2, 3])
      const view = await rowsOf(O, coll)
      assert.equal(view.rows.find((r) => r.id === a.id)?.props.tid, 1)
    })

    it('new rows continue the counter; a trashed or purged number is never handed out again', async () => {
      const d = await newRow(O, coll, 'fourth')
      assert.equal(d.props.tid, 4, 'the create answer carries the number')
      await ok(O, 'DELETE', `/api/pages/${d.id}`)
      const e = await newRow(O, coll, 'fifth')
      assert.equal(e.props.tid, 5)
    })

    it('raw parallel inserts on separate connections (no app lock) get distinct numbers from the trigger', async () => {
      const made = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          db.transaction(async (tx) => {
            const [r] = await tx.insert(schema.pages).values({ workspaceId: ws.id, parentId: coll, title: `raw${i}`, createdBy: O.id }).returning({ n: schema.pages.rowNumber })
            await tx.execute(sql`SELECT pg_sleep(0.02)`)
            return r.n
          }),
        ),
      )
      assert.equal(new Set(made).size, 12)
      assert.ok(made.every((n) => typeof n === 'number'))
      await db.delete(schema.pages).where(sql`${schema.pages.parentId} = ${coll} AND ${schema.pages.title} LIKE 'raw%'`)
    })

    it('parallel creates get distinct consecutive numbers', async () => {
      const made = await Promise.all(Array.from({ length: 16 }, (_, i) => newRow(O, coll, `p${i}`)))
      const ns = made.map((r) => r.props.tid as number).sort((x, y) => x - y)
      assert.equal(new Set(ns).size, 16)
      assert.deepEqual(ns, Array.from({ length: 16 }, (_, i) => 18 + i), "after the 12 raw inserts, whose numbers are not reused")
    })

    it('writes to an ID are ignored by PATCH; a copied row gets a new number; a moved row the next one of its new collection', async () => {
      const [first] = (await numbers(coll)).filter((r) => r.title === 'first')
      const res = await ok(O, 'PATCH', `/api/pages/${first.id}/props`, { props: { tid: 999, st: 'x' } })
      assert.equal(res.row.props.tid, 1)
      // a copy inserted with the same props (as duplicate / templates do) still gets its own number
      const [copy] = await db
        .insert(schema.pages)
        .values({ workspaceId: ws.id, parentId: coll, title: 'copy', createdBy: O.id, props: { st: 'x', tid: 1 }, rowNumber: 1 })
        .returning({ n: schema.pages.rowNumber, props: schema.pages.props })
      assert.equal(copy.n, 34)
      const other = await newCollection(O, `Other ${W}`, [{ id: 'oid', name: 'Key', type: 'uniqueId' }])
      const o1 = await newRow(O, other, 'o1')
      assert.equal(o1.props.oid, 1)
      await db.update(schema.pages).set({ parentId: other }).where(eq(schema.pages.id, first.id))
      const [moved] = await db.select({ n: schema.pages.rowNumber }).from(schema.pages).where(eq(schema.pages.id, first.id))
      assert.equal(moved.n, 2)
      const [ctr] = await db.select({ s: schema.collections.rowSeq }).from(schema.collections).where(eq(schema.collections.pageId, coll))
      assert.equal(ctr.s, 34, 'the counter never goes back')
    })

    it('only one ID property per collection', async () => {
      const res = await as(O, 'PUT', `/api/pages/${coll}/collection/fields`, {
        fields: [{ id: 'tid', name: 'ID', type: 'uniqueId' }, { id: 'tid2', name: 'ID2', type: 'uniqueId' }],
      })
      assert.equal(res.statusCode, 400)
    })
  })

  describe('automatic values, last editor and via, email / phone', () => {
    let coll = ''
    let row: RowDTO
    const fields: CollectionField[] = [
      { id: 'ct', name: 'Created', type: 'createdTime' },
      { id: 'et', name: 'Edited', type: 'editedTime' },
      { id: 'cb', name: 'Author', type: 'createdBy' },
      { id: 'eb', name: 'Editor', type: 'editedBy' },
      { id: 'n', name: 'Note', type: 'text' },
      { id: 'em', name: 'Mail', type: 'email' },
      { id: 'ph', name: 'Phone', type: 'phone' },
      { id: 'uid', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'T' } },
      { id: 'f', name: 'Twice', type: 'formula', formula: { expression: 'prop("ID") * 2' } },
    ]
    before(async () => {
      coll = await newCollection(O, `Auto ${W}`, fields)
      row = await newRow(O, coll, 'auto row', { n: 'x' })
    })

    it('rows are served with created / edited time and by, never stored in props', async () => {
      const r = (await rowsOf(O, coll)).rows[0]
      assert.match(String(r.props.ct), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      assert.equal(r.props.cb, O.id)
      assert.equal(r.props.eb, O.id, 'the creator is the last editor until someone edits')
      assert.equal(r.props.uid, 1)
      assert.equal(r.props.f, 2, 'a formula reads the ID number')
      const [stored] = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, row.id))
      const keys = Object.keys(stored.props as object)
      for (const k of ['ct', 'et', 'cb', 'eb', 'uid']) assert.ok(!keys.includes(k), `${k} is not stored`)
    })

    it('the member who edits a property becomes the last editor; writes to automatic values are ignored', async () => {
      await ok(M, 'PATCH', `/api/pages/${row.id}/props`, { props: { n: 'by minho', cb: M.id, eb: O.id, ct: '2000-01-01' } })
      const r = (await rowsOf(O, coll)).rows[0]
      assert.equal(r.props.eb, M.id)
      assert.equal(r.props.cb, O.id)
      assert.notEqual(String(r.props.ct).slice(0, 4), '2000')
      assert.ok(String(r.props.et) >= String(r.props.ct))
    })

    it('an agent edit makes its person the last editor with the client name as via', async () => {
      const mcp = await h.connectMcp(app, M, await h.mintToken(M, 'notes', 'Claude Code'), { user: { ...M, via: 'Claude Code' } })
      const q = await mcp.tool('query_rows', { collectionId: coll, fields: ['Note', 'Editor', 'ID', 'Mail'] })
      assert.equal(q.isError, false, q.text)
      const version = q.text.split('\n').find((l) => l.startsWith(row.id))!.split(' | ')[1]
      const up = await mcp.tool('update_row', { rowId: row.id, baseVersion: version, properties: { Note: 'by agent', Mail: 'a@b.co', Phone: '+82 10-1234-5678' } })
      assert.equal(up.isError, false, up.text)
      const r = (await rowsOf(O, coll)).rows[0]
      assert.equal(r.props.eb, M.id)
      assert.equal(r.props['via:eb'], 'Claude Code')
      assert.equal(r.props.em, 'a@b.co')
      const q2 = await mcp.tool('query_rows', { collectionId: coll, fields: ['Editor', 'ID'] })
      assert.ok(q2.text.includes('Minho (via Claude Code)'), q2.text)
      assert.ok(q2.text.includes('| T-1'), q2.text)
      // automatic values refuse writes with a clear error; a bad email is an error, not a silent drop
      const bad = await mcp.tool('update_row', { rowId: row.id, baseVersion: (await mcp.tool('query_rows', { collectionId: coll })).text.split('\n').find((l) => l.startsWith(row.id))!.split(' | ')[1], properties: { Created: '2020-01-01', ID: 3, Mail: 'nope' } })
      assert.equal(bad.isError, true)
      assert.match(bad.text, /"Created" is an automatic value/)
      assert.match(bad.text, /"ID" is an automatic value/)
      assert.match(bad.text, /"Mail" \(email\)/)
      const cr = await mcp.tool('create_row', { collectionId: coll, title: 'x', properties: { Editor: 'me' } })
      assert.equal(cr.isError, true)
      assert.match(cr.text, /automatic value/)
      await mcp.close()
    })

    it('query_rows filters and sorts on the automatic values (ID as TASK-n or n, created time by day)', async () => {
      const mcp = await h.connectMcp(app, O, await h.mintToken(O))
      await newRow(O, coll, 'second auto')
      const today = new Date().toISOString().slice(0, 10)
      const byId = await mcp.tool('query_rows', { collectionId: coll, filter: 'ID = T-2', fields: ['ID'] })
      assert.ok(byId.text.includes('second auto') && !byId.text.includes('auto row'), byId.text)
      const byNum = await mcp.tool('query_rows', { collectionId: coll, filter: 'ID > 1', fields: ['ID'] })
      assert.ok(byNum.text.includes('second auto') && !byNum.text.includes('| auto row'), byNum.text)
      const byDay = await mcp.tool('query_rows', { collectionId: coll, filter: `Created = ${today} AND Author = me`, sort: 'Created desc', fields: ['ID'] })
      const lines = byDay.text.split('\n').filter((l) => / \| T-\d/.test(l))
      assert.equal(lines.length, 2, byDay.text)
      assert.ok(lines[0].includes('T-2'), 'newest first by the whole timestamp')
      const desc = await mcp.tool('query_rows', { collectionId: coll, describe: true })
      assert.match(desc.text, /ID \(ID T-N, automatic, read-only\)/)
      await mcp.close()
    })

    it('the chart aggregate reads automatic values and the OR / NOT filter tree', async () => {
      const { view } = await ok(O, 'POST', `/api/pages/${coll}/collection/views`, {
        name: 'filtered',
        type: 'table',
        config: {
          filter: { mode: 'or', items: [{ fieldId: 'uid', op: 'eq', value: 'T-1' }, { mode: 'and', not: true, items: [{ fieldId: 'n', op: 'notEmpty' }] }] },
        },
      })
      assert.equal(view.config.filter.items.length, 2, 'the tree is stored as given')
      await newRow(O, coll, 'third auto', { n: 'has a note' })
      const res = await as(O, 'POST', `/api/workspaces/${ws.id}/charts/aggregate`, { source: { type: 'collection', collectionId: coll, viewId: view.id }, groupBy: { field: 'eb' }, measure: { fn: 'count' } })
      assert.equal(res.statusCode, 200, res.body)
      const d = res.json() as { rowCount: number; groups: { label: string }[] }
      // T-1 (by the OR) + "second auto" (no note: NOT(note not empty)); "third auto" has a note and is not T-1
      assert.equal(d.rowCount, 2, res.body)
      assert.deepEqual(d.groups.map((g) => g.label).sort(), ['Minho', 'Olivia'], 'grouped by last editor names')
    })
  })

  describe('sub-items', () => {
    let coll = ''
    const R: Record<string, string> = {}
    before(async () => {
      coll = await newCollection(O, `Tree ${W}`, [{ id: 'k', name: 'Key', type: 'uniqueId', uniqueId: { prefix: 'K' } }])
      const { collection } = await ok(O, 'GET', `/api/pages/${coll}/collection?rows=0`)
      await ok(O, 'PUT', `/api/pages/${coll}/collection/fields`, {
        fields: [...collection.fields, { id: 'par', name: 'Parent item', type: 'relation', relation: { targetPageId: coll, subItems: true } }],
      })
      for (const t of ['root', 'a', 'b', 'a1', 'a1x']) R[t] = (await newRow(O, coll, t)).id
    })

    it('a Parent item is one-way, to the same collection, one per collection', async () => {
      const other = await newCollection(O, `Elsewhere ${W}`, [])
      const { collection } = await ok(O, 'GET', `/api/pages/${coll}/collection?rows=0`)
      const fs = collection.fields as CollectionField[]
      for (const bad of [
        [...fs, { id: 'p2', name: 'P2', type: 'relation', relation: { targetPageId: coll, subItems: true } }],
        fs.map((f) => (f.id === 'par' ? { ...f, relation: { targetPageId: other, subItems: true } } : f)),
        fs.map((f) => (f.id === 'par' ? { ...f, relation: { targetPageId: coll, subItems: true, twoWay: true } } : f)),
      ]) {
        const res = await as(O, 'PUT', `/api/pages/${coll}/collection/fields`, { fields: bad })
        assert.equal(res.statusCode, 400, res.body)
      }
    })

    it('one parent per row; never itself or one of its own sub-items', async () => {
      await ok(O, 'PATCH', `/api/pages/${R.a}/props`, { props: { par: [R.root] } })
      await ok(O, 'PATCH', `/api/pages/${R.b}/props`, { props: { par: [R.root, R.a] } })
      await ok(O, 'PATCH', `/api/pages/${R.a1}/props`, { props: { par: [R.a] } })
      await ok(O, 'PATCH', `/api/pages/${R.a1x}/props`, { props: { par: [R.a1] } })
      const rows = (await rowsOf(O, coll)).rows
      assert.deepEqual(rows.find((r) => r.id === R.b)?.props.par, [R.root], 'only the first parent is kept')
      for (const [row, parent] of [[R.root, R.a1x], [R.a, R.a1], [R.a, R.a]]) {
        const res = await as(O, 'PATCH', `/api/pages/${row}/props`, { props: { par: [parent] } })
        assert.equal(res.statusCode, 400, `${row} under ${parent}`)
        assert.equal(res.json().error.code, 'SUBITEM_CYCLE')
      }
    })

    it('concurrent moves cannot close a loop', async () => {
      const x = (await newRow(O, coll, 'x')).id
      const y = (await newRow(O, coll, 'y')).id
      const [r1, r2] = await Promise.all([
        as(O, 'PATCH', `/api/pages/${x}/props`, { props: { par: [y] } }),
        as(O, 'PATCH', `/api/pages/${y}/props`, { props: { par: [x] } }),
      ])
      assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 400])
    })

    it('a trashed parent leaves its sub-items at the top level; restoring it brings the tree back', async () => {
      await ok(O, 'DELETE', `/api/pages/${R.a}`)
      let a1 = (await rowsOf(O, coll)).rows.find((r) => r.id === R.a1)!
      assert.deepEqual(a1.props.par, [], 'the link to a trashed row is not served')
      const [stored] = await db.select({ props: schema.pages.props }).from(schema.pages).where(eq(schema.pages.id, R.a1))
      assert.deepEqual((stored.props as Record<string, unknown>).par, [R.a], 'but it is kept')
      await ok(O, 'POST', `/api/pages/${R.a}/restore`, {})
      a1 = (await rowsOf(O, coll)).rows.find((r) => r.id === R.a1)!
      assert.deepEqual(a1.props.par, [R.a])
    })

    it('query_rows: under a row (id, ID or title), to a depth; the parent shows as its ID; create_row parent', async () => {
      const mcp = await h.connectMcp(app, O, await h.mintToken(O))
      const one = await mcp.tool('query_rows', { collectionId: coll, under: 'root' })
      assert.equal(one.isError, false, one.text)
      const titles = (t: string) => t.split('\n').filter((l) => /^[0-9a-f-]{36} \| /.test(l)).map((l) => l.split(' | ')[2]).sort()
      assert.deepEqual(titles(one.text), ['a', 'b'])
      const kRoot = (await rowsOf(O, coll)).rows.find((r) => r.id === R.root)!.props.k
      const deep = await mcp.tool('query_rows', { collectionId: coll, under: `K-${kRoot}`, depth: 3 })
      assert.deepEqual(titles(deep.text), ['a', 'a1', 'a1x', 'b'])
      assert.ok(one.text.includes(`| K-${kRoot}`), `parent shown as its ID: ${one.text}`)
      const made = await mcp.tool('create_row', { collectionId: coll, title: 'b1', parent: 'b' })
      assert.equal(made.isError, false, made.text)
      const b1 = (await rowsOf(O, coll)).rows.find((r) => r.title === 'b1')!
      assert.deepEqual(b1.props.par, [R.b])
      const noTree = await newCollection(O, `Flat ${W}`, [])
      const refused = await mcp.tool('create_row', { collectionId: noTree, title: 'z', parent: 'x' })
      assert.equal(refused.isError, true)
      assert.match(refused.text, /no sub-items/)
      const badDepth = await mcp.tool('query_rows', { collectionId: noTree, under: 'x' })
      assert.equal(badDepth.isError, true)
      await mcp.close()
    })
  })

  describe('agent task board template (docs/adr/2147-*)', () => {
    it('instantiates with TASK IDs and sub-tasks linked to their parent in the new collection', async () => {
      const res = await as(O, 'POST', '/api/pages/from-template', { workspaceId: ws.id, builtinKey: 'agentBoard' })
      assert.equal(res.statusCode, 200, res.body)
      const root = res.json().page as { id: string; kind: string }
      assert.equal(root.kind, 'collection')
      const d = await rowsOf(O, root.id)
      const parentField = d.collection.fields.find((f) => f.relation?.subItems)!
      assert.equal(parentField.relation!.targetPageId, root.id, 'the Parent task points at the new collection')
      const ids = d.rows.map((r) => r.props.taskId as number).sort()
      assert.deepEqual(ids, [1, 2, 3])
      const top = d.rows.find((r) => !(r.props[parentField.id] as string[] | undefined)?.length)!
      const subs = d.rows.filter((r) => r.id !== top.id)
      assert.equal(subs.length, 2)
      for (const r of subs) assert.deepEqual(r.props[parentField.id], [top.id])
      assert.ok(d.collection.fields.some((f) => f.type === 'uniqueId' && f.uniqueId?.prefix === 'TASK'))
    })
  })

  describe('page guests open a shared collection (docs/adr/2146-*)', () => {
    let secret = ''
    let tasks = ''
    let board = ''
    let secretRow = ''
    let taskRow = ''
    let boardRow = ''
    before(async () => {
      secret = await newCollection(O, `Secret ${W}`, [{ id: 's', name: 'Hidden note', type: 'text' }])
      secretRow = (await newRow(O, secret, `SecretRow ${W}`, { s: `classified ${W}` })).id
      tasks = await newCollection(O, `GuestTasks ${W}`, [
        { id: 'own', name: 'Owner', type: 'person' },
        { id: 'cb', name: 'Author', type: 'createdBy' },
        { id: 'rel', name: 'Linked', type: 'relation', relation: { targetPageId: secret } },
        { id: 'cnt', name: 'Linked count', type: 'rollup', rollup: { relationFieldId: 'rel', targetFieldId: 'title', fn: 'count' } },
        { id: 'uniq', name: 'Linked names', type: 'rollup', rollup: { relationFieldId: 'rel', targetFieldId: 's', fn: 'showUnique' } },
      ])
      taskRow = (await newRow(O, tasks, 'shared task', { own: M.id, rel: [secretRow] })).id
      board = await newCollection(O, `GuestBoard ${W}`, [{ id: 'own', name: 'Owner', type: 'person' }, { id: 'n', name: 'Note', type: 'text' }])
      boardRow = (await newRow(O, board, 'board row')).id
      await changeLog.drainChangeLog()
      await ok(O, 'PUT', `/api/pages/${tasks}/access`, { userId: G.id, level: 'view' })
      await ok(O, 'PUT', `/api/pages/${board}/access`, { userId: G.id, level: 'edit' })
    })

    const assertNoLeak = (body: string, what: string) => {
      assert.ok(!body.includes(secret) && !body.includes(secretRow), `${what}: leaks a secret id`)
      assert.ok(!body.includes(`SecretRow ${W}`) && !body.includes(`classified ${W}`), `${what}: leaks secret text`)
      assert.ok(!body.includes(M.email) && !body.includes(O.email), `${what}: leaks an email`)
    }

    it('a view guest reads the shared collection; links, rollups and people outside their trees stay hidden', async () => {
      const res = await as(G, 'GET', `/api/pages/${tasks}/collection`)
      assert.equal(res.statusCode, 200, res.body)
      assertNoLeak(res.body, 'GET collection')
      const rel = (res.json() as { collection: { fields: CollectionField[] } }).collection.fields.find((f) => f.id === 'rel')!
      assert.equal(rel.relation!.targetPageId, '00000000-0000-0000-0000-000000000000', 'a hidden target is named by no id')
      const d = res.json() as { rows: RowDTO[]; people: Record<string, string>; refs: Record<string, unknown> }
      const r = d.rows.find((x) => x.id === taskRow)!
      assert.deepEqual(r.props.rel, [])
      assert.equal(r.props.cnt, 0)
      assert.deepEqual(r.props.uniq, [])
      assert.deepEqual(d.refs, {})
      assert.deepEqual(d.people, { [M.id]: 'Minho', [O.id]: 'Olivia' }, 'names of the people in the cells, nothing else')
      // a member still sees the link
      const m = (await rowsOf(M, tasks)).rows.find((x) => x.id === taskRow)!
      assert.deepEqual(m.props.rel, [secretRow])
      assert.equal(m.props.cnt, 1)
    })

    it('nothing outside: other collections, the member list, search, the agent query route', async () => {
      for (const [method, url, code] of [
        ['GET', `/api/pages/${secret}/collection`, 404],
        ['GET', `/api/pages/${secret}/collection/row-options`, 404],
        ['GET', `/api/workspaces/${ws.id}/members`, 403],
        ['GET', `/api/workspaces/${ws.id}/search?q=${W}`, 403],
        ['GET', `/api/pages/${tasks}/collection/query`, 403],
        ['GET', `/api/pages/${taskRow}/row`, 403],
      ] as [string, string, number][]) {
        const res = await as(G, method, url)
        assert.equal(res.statusCode, code, `${url}: ${res.statusCode} ${res.body.slice(0, 200)}`)
        assertNoLeak(res.body, url)
      }
      const opts = await as(G, 'GET', `/api/pages/${tasks}/collection/row-options`)
      assert.equal(opts.statusCode, 200)
      assert.ok(opts.body.includes(taskRow))
      assertNoLeak(opts.body, 'row-options')
    })

    it('levels: view refuses cell edits and new rows; edit allows them but never people or the schema', async () => {
      assert.equal((await as(G, 'PATCH', `/api/pages/${taskRow}/props`, { props: { rel: [] } })).statusCode, 403)
      assert.equal((await as(G, 'POST', `/api/pages/${tasks}/collection/rows`, { title: 'nope' })).statusCode, 403)
      const edit = await as(G, 'PATCH', `/api/pages/${boardRow}/props`, { props: { n: 'guest note' } })
      assert.equal(edit.statusCode, 200, edit.body)
      const person = await as(G, 'PATCH', `/api/pages/${boardRow}/props`, { props: { own: M.id } })
      assert.equal(person.statusCode, 403)
      assert.equal(person.json().error.code, 'GUEST_PERSON')
      const made = await as(G, 'POST', `/api/pages/${board}/collection/rows`, { title: 'by guest', template: null })
      assert.equal(made.statusCode, 200, made.body)
      const madeWithPerson = await as(G, 'POST', `/api/pages/${board}/collection/rows`, { title: 'x', props: { own: M.id }, template: null })
      assert.equal(madeWithPerson.statusCode, 403)
      assert.equal((await as(G, 'PUT', `/api/pages/${board}/collection/fields`, { fields: [] })).statusCode, 403)
      assert.equal((await as(G, 'POST', `/api/pages/${board}/collection/views`, { name: 'v', type: 'table' })).statusCode, 403)
      // the guest's own edit makes them the last editor of that row (names reach other viewers as usual)
      const [p] = await db.select({ by: schema.pages.editedBy }).from(schema.pages).where(eq(schema.pages.id, boardRow))
      assert.equal(p.by, G.id)
    })

    it('a stranger and a revoked guest get nothing', async () => {
      const X = await h.makeUser('Xavier')
      assert.equal((await as(X, 'GET', `/api/pages/${tasks}/collection`)).statusCode, 404)
      await db.execute(sql`SELECT 1`)
    })
  })
})
