// Chart aggregate endpoint (docs/adr/1602-*): grouping and measuring a collection (through a view's
// filters) or a query, with the collection query path's access rules: membership, visibility,
// range, guests refused; people by member name only, relations by visible title only.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { ChartDataDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] chart aggregate', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const outsider = await h.makeUser('outsider')
  const ws = await h.makeWorkspace(alice, [bob])
  const other = await h.makeWorkspace(alice)
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })
  const bearer = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object })
  const aggregate = (u: U, body: unknown, wsId = ws.id) => as(u, 'POST', `/workspaces/${wsId}/charts/aggregate`, body)
  const ok = async (u: U, body: unknown): Promise<ChartDataDTO> => {
    const res = await aggregate(u, body)
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as ChartDataDTO
  }

  const mkCollection = async (u: U, wsId: string, title: string, extra: Record<string, unknown> = {}) => {
    const res = await as(u, 'POST', '/pages', { workspaceId: wsId, kind: 'collection', title, ...extra })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().page.id as string
  }
  // rows inherit the collection's scope, as POST /pages does for a child
  const rows = async (collectionId: string, wsId: string, by: string, list: { title: string; props: Record<string, unknown> }[], scope: 'shared' | 'private' = 'shared') => {
    if (!list.length) return []
    return db
      .insert(schema.pages)
      .values(list.map((r, i) => ({ workspaceId: wsId, parentId: collectionId, title: r.title, createdBy: by, kind: 'doc' as const, props: r.props, sortOrder: i, scope })))
      .returning({ id: schema.pages.id })
  }

  // alice's private collection: bob must never see its rows, their titles or counts
  const secret = await mkCollection(alice, ws.id, 'Secret plans', { scope: 'private' })
  const [secretRow] = await rows(secret, ws.id, alice.id, [{ title: 'Hidden acquisition', props: {} }], 'private')

  const roadmap = await mkCollection(alice, ws.id, 'Roadmap')
  const putFields = await as(alice, 'PUT', `/pages/${roadmap}/collection/fields`, {
    fields: [
      { id: 'st', name: 'Status', type: 'select', options: [
        { id: 'todo', name: 'Todo', color: 'gray' },
        { id: 'doing', name: 'Doing', color: 'blue' },
        { id: 'done', name: 'Done', color: 'green' },
      ] },
      { id: 'tg', name: 'Tags', type: 'multiSelect', options: [
        { id: 'ui', name: 'UI', color: 'red' },
        { id: 'api', name: 'API', color: 'blue' },
      ] },
      { id: 'ow', name: 'Owner', type: 'person' },
      { id: 'du', name: 'Due', type: 'date' },
      { id: 'pt', name: 'Points', type: 'number' },
      { id: 'ck', name: 'Shipped', type: 'checkbox' },
      { id: 'tx', name: 'Note', type: 'text' },
    ],
  })
  assert.equal(putFields.statusCode, 200, putFields.body)
  // relation field to the secret collection is refused for bob's view later; store links directly
  await rows(roadmap, ws.id, alice.id, [
    { title: 'Login', props: { st: 'done', tg: ['ui', 'api'], ow: alice.id, du: '2026-10-05', pt: 3, ck: true } },
    { title: 'Search', props: { st: 'doing', tg: ['api'], ow: bob.id, du: '2026-10-20', pt: 5 } },
    { title: 'Export', props: { st: 'done', tg: ['ui'], ow: outsider.id, du: '2026-11-02', pt: 8, ck: true } },
    { title: 'Charts', props: { st: 'todo', du: '2026-11-03', pt: 'n/a' } },
    { title: 'Ghost', props: { st: 'gone-option', tx: secretRow.id } },
  ])
  const src = { type: 'collection', collectionId: roadmap }

  it('counts by a select in option order, "no value" last', async () => {
    const d = await ok(bob, { source: src, groupBy: { field: 'st' } })
    assert.deepEqual(d.groups.map((g) => g.label), ['Todo', 'Doing', 'Done', '(empty)'])
    assert.deepEqual(d.values, [1, 1, 2, 1])
    assert.equal(d.rowCount, 5)
    assert.equal(d.group.name, 'Status')
    assert.deepEqual(d.source, { type: 'collection', id: roadmap, title: 'Roadmap' })
  })

  it('sum / avg of a number, multi-select counts a row in each of its groups, dates by month, checkbox', async () => {
    const sum = await ok(bob, { source: src, groupBy: { field: 'st' }, measure: { fn: 'sum', field: 'pt' } })
    assert.deepEqual(sum.values, [0, 5, 11, 0])
    const avg = await ok(bob, { source: src, groupBy: { field: 'st' }, measure: { fn: 'avg', field: 'pt' } })
    assert.deepEqual(avg.values, [null, 5, 5.5, null])
    const tags = await ok(bob, { source: src, groupBy: { field: 'tg' } })
    assert.deepEqual(Object.fromEntries(tags.groups.map((g, i) => [g.label, tags.values[i]])), { UI: 2, API: 2, '(empty)': 2 })
    const months = await ok(bob, { source: src, groupBy: { field: 'du', bucket: 'month' } })
    assert.deepEqual(months.groups.map((g) => g.key), ['2026-10', '2026-11', null])
    assert.deepEqual(months.values, [2, 2, 1])
    const shipped = await ok(bob, { source: src, groupBy: { field: 'ck' }, series: { field: 'st' } })
    assert.deepEqual(shipped.groups.map((g) => g.special), ['checked', 'unchecked'])
    assert.deepEqual(shipped.seriesKeys?.map((s) => s.label), ['Todo', 'Doing', 'Done', '(empty)'])
    assert.deepEqual(shipped.values, [
      [0, 0, 2, 0],
      [1, 1, 0, 1],
    ])
  })

  it('people by member name; a non-member id is "no value" and never sent', async () => {
    const res = await aggregate(bob, { source: src, groupBy: { field: 'ow' } })
    assert.equal(res.statusCode, 200, res.body)
    const d = res.json() as ChartDataDTO
    assert.deepEqual(Object.fromEntries(d.groups.map((g, i) => [g.label, d.values[i]])), { alice: 1, bob: 1, '(empty)': 3 })
    assert.doesNotMatch(res.body, new RegExp(outsider.id))
    assert.doesNotMatch(res.body, /outsider/)
  })

  it("a view's filters choose the rows; a view of another collection is not found", async () => {
    const v = await as(alice, 'POST', `/pages/${roadmap}/collection/views`, {
      name: 'Open',
      type: 'chart',
      config: { filters: [{ fieldId: 'st', op: 'ne', value: 'done' }], chart: { kind: 'donut', groupBy: { field: 'st' } } },
    })
    assert.equal(v.statusCode, 200, v.body)
    assert.equal(v.json().view.type, 'chart')
    assert.equal(v.json().view.config.chart.kind, 'donut')
    const d = await ok(bob, { source: { ...src, viewId: v.json().view.id }, groupBy: { field: 'st' } })
    assert.deepEqual(d.values, [1, 1, 1])
    assert.equal(d.rowCount, 3)
    const otherColl = await mkCollection(bob, ws.id, 'Other')
    const wrong = await aggregate(bob, { source: { type: 'collection', collectionId: otherColl, viewId: v.json().view.id }, groupBy: { field: 'title' } })
    assert.equal(wrong.statusCode, 404)
  })

  it('relations show visible titles only', async () => {
    const res = await as(alice, 'PUT', `/pages/${roadmap}/collection/fields`, {
      fields: [
        ...(await as(alice, 'GET', `/pages/${roadmap}/collection?rows=0`)).json().collection.fields,
        { id: 'rl', name: 'Depends', type: 'relation', relation: { targetPageId: secret } },
      ],
    })
    assert.equal(res.statusCode, 200, res.body)
    const { and, eq } = await import('drizzle-orm')
    const [r] = await db.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.title, 'Ghost'), eq(schema.pages.parentId, roadmap)))
    await db.update(schema.pages).set({ props: { st: 'gone-option', rl: [secretRow.id] } }).where(eq(schema.pages.id, r.id))
    const mine = await ok(alice, { source: src, groupBy: { field: 'rl' } })
    assert.ok(mine.groups.some((g) => g.label === 'Hidden acquisition'), JSON.stringify(mine))
    const theirs = await aggregate(bob, { source: src, groupBy: { field: 'rl' } })
    assert.equal(theirs.statusCode, 200, theirs.body)
    assert.doesNotMatch(theirs.body, /Hidden acquisition/)
    assert.doesNotMatch(theirs.body, new RegExp(secretRow.id))
  })

  it('access: hidden, foreign, non-member, guest, wrong workspace and bad fields', async () => {
    assert.equal((await aggregate(bob, { source: { type: 'collection', collectionId: secret }, groupBy: { field: 'title' } })).statusCode, 404)
    const elsewhere = await mkCollection(alice, other.id, 'Elsewhere')
    // a collection of another workspace through this workspace's path
    assert.equal((await aggregate(alice, { source: { type: 'collection', collectionId: elsewhere }, groupBy: { field: 'title' } })).statusCode, 404)
    assert.equal((await aggregate(alice, { source: { type: 'collection', collectionId: elsewhere }, groupBy: { field: 'title' } }, other.id)).statusCode, 200)
    const nonMember = await aggregate(outsider, { source: src, groupBy: { field: 'st' } })
    assert.ok([403, 404].includes(nonMember.statusCode), `${nonMember.statusCode}`)
    // guest with view access to the collection: refused like every collection read
    const guest = await h.makeUser('guest')
    await h.makeWorkspace(guest)
    // a page_grants row is what makes a guest (docs/adr/1250-*); the grant route is not in this app
    await db.insert(schema.pageGrants).values({ pageId: roadmap, userId: guest.id, level: 'view', createdBy: alice.id })
    const asGuest = await aggregate(guest, { source: src, groupBy: { field: 'st' } })
    assert.ok([403, 404].includes(asGuest.statusCode), `${asGuest.statusCode}`)
    // not a collection
    const doc = await h.makeDocPage(ws.id, alice.id, 'Plain doc', [])
    assert.equal((await aggregate(alice, { source: { type: 'collection', collectionId: doc.id }, groupBy: { field: 'title' } })).statusCode, 404)
    const bad = await aggregate(bob, { source: src, groupBy: { field: 'nope' } })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error.code, 'INVALID_CHART')
    const notNumber = await aggregate(bob, { source: src, groupBy: { field: 'st' }, measure: { fn: 'sum', field: 'tx' } })
    assert.equal(notNumber.statusCode, 400)
    const urlSource = await aggregate(bob, { source: { type: 'url', url: 'https://example.com/a.json' }, groupBy: { field: 'x' } })
    assert.equal(urlSource.statusCode, 400)
  })

  it('tokens: read-only may aggregate; a subtree range outside the collection may not', async () => {
    const mk = async (body: Record<string, unknown>) => {
      const res = await as(bob, 'POST', '/tokens', { name: 'chart', expiresInDays: 30, ...body })
      assert.equal(res.statusCode, 201, res.body)
      return res.json().secret as string
    }
    const ro = await mk({ access: 'read', range: { kind: 'all' } })
    const r1 = await bearer(ro, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: src, groupBy: { field: 'st' } })
    assert.equal(r1.statusCode, 200, r1.body)
    const otherRoot = await mkCollection(bob, ws.id, 'Another root')
    const sub = await mk({ access: 'read', range: { kind: 'subtree', pageId: otherRoot } })
    const r2 = await bearer(sub, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: src, groupBy: { field: 'st' } })
    assert.ok([403, 404].includes(r2.statusCode), `${r2.statusCode} ${r2.body}`)
  })

  it('a query source groups the query result by a column', async () => {
    const d = await ok(bob, { source: { type: 'query', query: 'TABLE Status, Points FROM "Roadmap"' }, groupBy: { field: 'status' }, measure: { fn: 'sum', field: 'Points' } })
    assert.equal(d.source.type, 'query')
    const byLabel = Object.fromEntries(d.groups.map((g, i) => [g.label, d.values[i]]))
    assert.equal(byLabel.Done, 11)
    assert.equal(byLabel.Doing, 5)
    const missing = await aggregate(bob, { source: { type: 'query', query: 'TABLE Status FROM "Roadmap"' }, groupBy: { field: 'Nope' } })
    assert.equal(missing.statusCode, 400)
    assert.match(missing.json().error.message, /columns: "title", "Status"/)
    // bob's query never sees alice's private collection
    const hidden = await ok(bob, { source: { type: 'query', query: 'TABLE file.name FROM "Secret plans"' }, groupBy: { field: 'title' } })
    assert.equal(hidden.rowCount, 0)
  })

  it('plain Markdown export shows the chart as a table; agent notation keeps the token', async () => {
    const { canonicalChartJson } = await import('@inkling/shared')
    const config = canonicalChartJson({ source: { type: 'collection', collectionId: roadmap }, kind: 'bar', groupBy: { field: 'st' }, title: 'By status' })
    const hiddenCfg = canonicalChartJson({ source: { type: 'collection', collectionId: secret }, kind: 'bar', groupBy: { field: 'title' } })
    const doc = await h.makeDocPage(ws.id, bob.id, 'Report', [
      { type: 'paragraph', content: [{ type: 'text', text: 'before', styles: {} }] },
      { type: 'chart', props: { config } },
      { type: 'chart', props: { config: hiddenCfg } },
    ] as never)
    const plain = await as(bob, 'GET', `/pages/${doc.id}/export?format=md`)
    assert.equal(plain.statusCode, 200, plain.body)
    assert.match(plain.body, /\*\*By status\*\*/)
    assert.match(plain.body, /\|\s*Status\s*\|\s*Count\s*\|/)
    assert.match(plain.body, /\|\s*Done\s*\|\s*2\s*\|/)
    assert.doesNotMatch(plain.body, /inkling:chart|Hidden acquisition|Secret plans/)
    const agent = await as(bob, 'GET', `/pages/${doc.id}/export?format=md&notation=agent`)
    assert.equal(agent.statusCode, 200, agent.body)
    assert.equal(agent.body.match(/<!-- inkling:chart \{/g)?.length, 2)
  })

  it('public folder link: a table only for a collection inside the link, nothing for others', async () => {
    const Fastify = (await import('fastify')).default
    const { AppError } = await import('../errors')
    const app2 = Fastify()
    await app2.register(import('@fastify/cookie'))
    app2.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    await app2.register(
      async (api) => {
        await (await import('../routes/pages')).registerPageRoutes(api)
        await (await import('../routes/public')).registerPublicRoutes(api)
      },
      { prefix: '/api' },
    )
    await app2.ready()
    try {
      const { canonicalChartJson } = await import('@inkling/shared')
      const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Published', kind: 'folder', createdBy: alice.id }).returning()
      const inside = await mkCollection(alice, ws.id, 'Inside stats', { parentId: folder.id })
      await as(alice, 'PUT', `/pages/${inside}/collection/fields`, { fields: [{ id: 'k', name: 'Kind', type: 'select', options: [{ id: 'x', name: 'Xeno', color: 'red' }] }] })
      await rows(inside, ws.id, alice.id, [
        { title: 'a', props: { k: 'x' } },
        { title: 'b', props: { k: 'x' } },
      ])
      const cfg = (collectionId: string) => canonicalChartJson({ source: { type: 'collection', collectionId }, kind: 'pie', groupBy: { field: 'k' } })
      await h.makeDocPage(ws.id, alice.id, 'Public report', [
        { type: 'chart', props: { config: cfg(inside) } },
        { type: 'chart', props: { config: canonicalChartJson({ source: { type: 'collection', collectionId: roadmap }, kind: 'bar', groupBy: { field: 'st' } }) } },
        { type: 'chart', props: { config: canonicalChartJson({ source: { type: 'query', query: 'LIST FROM "Roadmap"' }, kind: 'bar', groupBy: { field: 'title' } }) } },
      ] as never, { parentId: folder.id })
      const share = await app2.inject({ method: 'POST', url: `/api/pages/${folder.id}/share`, headers: { cookie: alice.cookie } })
      assert.equal(share.statusCode, 200, share.body)
      const token = share.json().token as string
      const tree = (await app2.inject({ method: 'GET', url: `/api/public/${token}` })).json() as { tree: { ref: string; title: string }[] }
      const ref = tree.tree.find((n) => n.title === 'Public report')!.ref
      const page = await app2.inject({ method: 'GET', url: `/api/public/${token}/p/${ref}` })
      assert.equal(page.statusCode, 200, page.body)
      const html = page.json().html as string
      assert.match(html, /Xeno/)
      assert.match(html, /<table/)
      // the Roadmap collection is outside the link: no labels, counts or ids from it; no config anywhere
      assert.doesNotMatch(html, /Doing|Todo|Login|collectionId|groupBy|inkling/)
      assert.doesNotMatch(html, new RegExp(roadmap))
    } finally {
      await app2.close()
    }
  })

  it('MCP: create_chart writes a token through the section route; read_page shows it with a data line', async () => {
    const { reindexPageChunks } = await import('../context/chunkIndex')
    const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
    const heading = (t: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }] })
    const blocks = [heading('Status'), para('numbers below'), heading('Notes'), para('end')]
    const pg = await h.makeDocPage(ws.id, bob.id, 'Weekly', blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    const B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Bob Agent'))
    try {
      const bad = await B.tool('create_chart', { pageId: pg.id, section: 'status', collectionId: roadmap, kind: 'bar', groupBy: 'Nope' })
      assert.equal(bad.isError, true)
      assert.match(bad.text, /no property "Nope".*"Status" \(select\)/)
      const hidden = await B.tool('create_chart', { pageId: pg.id, collectionId: secret, kind: 'bar', groupBy: 'title' })
      assert.equal(hidden.isError, true)
      assert.match(hidden.text, /not found/)
      const r = await B.tool('create_chart', { pageId: pg.id, section: 'status', collectionId: roadmap, view: 'Open', kind: 'donut', groupBy: 'Status', title: 'Open work' })
      assert.equal(r.isError, false, r.text)
      assert.match(r.text, /Chart inserted at §status/)
      assert.match(r.text, /count by Status: Todo 1, Doing 1, \(empty\) 1 \(3 rows\)/)
      const read = await B.tool('read_page', { pageId: pg.id })
      assert.equal(read.isError, false, read.text)
      assert.match(read.text, /numbers below\n\n<!-- inkling:chart \{"groupBy":\{"field":"st"\},"kind":"donut","source":\{"collectionId":"[0-9a-f-]+","type":"collection","viewId":"[0-9a-f-]+"\},"title":"Open work"\} -->\n<!-- inkling:chart-data count by Status: Todo 1, Doing 1, \(empty\) 1 \(3 rows\) -->/)
      // a section read carries the data line too
      const section = await B.tool('read_page', { pageId: pg.id, section: 'status' })
      assert.match(section.text, /inkling:chart-data count by Status/)
      // sending the read back unchanged writes nothing new (the data line is dropped, the chart kept)
      const md = /<untrusted_content[^>]*>\n([^]*)\n<\/untrusted_content>/.exec(read.text)![1]
      const before = (await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body
      const rep = await B.tool('update_page', { pageId: pg.id, markdown: md, mode: 'replace' })
      assert.equal(rep.isError, false, rep.text)
      assert.equal((await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body.replace(/updated: .*\n/, ''), before.replace(/updated: .*\n/, ''))
      // a suggestion instead of a write
      const sug = await B.tool('create_chart', { pageId: pg.id, section: 'notes', query: 'TABLE Status FROM "Roadmap"', kind: 'bar', groupBy: 'Status', suggest: true })
      assert.equal(sug.isError, false, sug.text)
      assert.match(sug.text, /suggestion/i)
      assert.doesNotMatch((await as(bob, 'GET', `/pages/${pg.id}/section?ref=notes`)).json().markdown, /inkling:chart/)
      // create_view: a chart view with names for fields
      const v = await B.tool('create_view', { collectionId: roadmap, type: 'chart', name: 'Points by owner', chart: { kind: 'bar', groupBy: 'Owner', measure: 'sum', measureField: 'Points' } })
      assert.equal(v.isError, false, v.text)
      assert.match(v.text, /View "Points by owner" \(chart\) created/)
      assert.match(v.text, /sum of Points by Owner: /)
      const board = await B.tool('create_view', { collectionId: roadmap, type: 'board', name: 'Board', config: { groupByFieldId: 'Status' } })
      assert.equal(board.isError, false, board.text)
      const views = (await as(bob, 'GET', `/pages/${roadmap}/collection?rows=0`)).json().collection.views as { name: string; config: { groupByFieldId?: string } }[]
      assert.equal(views.find((x) => x.name === 'Board')?.config.groupByFieldId, 'st')
    } finally {
      await B.close()
    }
    // read-only connection: refused before anything is written
    const R = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes:read'), { canWrite: false })
    try {
      const ro = await R.tool('create_chart', { pageId: pg.id, collectionId: roadmap, kind: 'bar', groupBy: 'Status' })
      assert.equal(ro.isError, true)
    } finally {
      await R.close()
    }
  })

  it('large collections: 2,000 and 10,000 rows within the statement timeout (printed for PERFORMANCE.md)', async () => {
    const statuses = ['todo', 'doing', 'done']
    for (const n of [2000, 10000]) {
      const big = await mkCollection(alice, ws.id, `Big ${n}`)
      await as(alice, 'PUT', `/pages/${big}/collection/fields`, { fields: (await as(alice, 'GET', `/pages/${roadmap}/collection?rows=0`)).json().collection.fields.filter((f: { type: string }) => f.type !== 'relation') })
      const list = Array.from({ length: n }, (_, i) => ({
        title: `Row ${i}`,
        props: { st: statuses[i % 3], tg: i % 2 ? ['ui'] : ['ui', 'api'], ow: i % 2 ? alice.id : bob.id, du: `2026-${String((i % 12) + 1).padStart(2, '0')}-1${i % 9}`, pt: i % 13, tx: `note ${i % 50}` },
      }))
      for (let i = 0; i < list.length; i += 1000) await rows(big, ws.id, alice.id, list.slice(i, i + 1000))
      const body = { source: { type: 'collection', collectionId: big }, groupBy: { field: 'du', bucket: 'month' }, series: { field: 'st' }, measure: { fn: 'sum', field: 'pt' } }
      const times: number[] = []
      for (let k = 0; k < 5; k++) {
        const { clearChartCache } = await import('./aggregate')
        clearChartCache()
        const t0 = performance.now()
        const d = await ok(alice, { ...body, groupBy: { field: k % 2 ? 'du' : 'st', ...(k % 2 ? { bucket: 'month' } : {}) } })
        times.push(performance.now() - t0)
        assert.equal(d.rowCount, n)
      }
      const multi = performance.now()
      await ok(alice, { source: { type: 'collection', collectionId: big }, groupBy: { field: 'tg' }, series: { field: 'ow' } })
      const multiMs = performance.now() - multi
      const warm = performance.now()
      const cached = await ok(alice, { source: { type: 'collection', collectionId: big }, groupBy: { field: 'tg' }, series: { field: 'ow' } })
      const warmMs = performance.now() - warm
      assert.equal(cached.cached, true)
      times.sort((a, b) => a - b)
      console.log(`[chart-perf] rows=${n} cold median=${times[2].toFixed(1)}ms max=${times[4].toFixed(1)}ms multiSelect×person=${multiMs.toFixed(1)}ms cached=${warmMs.toFixed(1)}ms`)
      assert.ok(times[4] < 3000, `aggregate of ${n} rows took ${times[4]} ms`)
    }
  })
})
