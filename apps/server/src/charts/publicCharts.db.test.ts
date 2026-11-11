// Charts on public pages (docs/adr/2440-*): off per link by default (nothing of a chart in the page
// JSON or HTML, except a folder link's own collections), turned on by a manager and aggregated as that
// person while they are a member; the response carries labels and numbers only — never collection,
// view or field ids, query text or row titles the chart does not group by — checked on the whole body.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-publiccharts-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR = DATA
mkdirSync(`${DATA}/uploads`, { recursive: true })

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import type { PublicChartDTO, PublicPageDTO, ShareStatusDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] public pages: charts', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { canonicalChartJson } = await import('@inkling/shared')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/collections')).registerCollectionRoutes(api)
      await (await import('../routes/public')).registerPublicRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type M = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  const call = (u: U, method: M, url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: M, url: string, payload?: unknown) => {
    const res = await call(u, method, url, payload)
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }
  const visit = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

  const W = randomBytes(3).toString('hex')
  const alice = await h.makeUser(`Alice${W}`)
  const bob = await h.makeUser(`Bob${W}`)
  const carol = await h.makeUser(`Carol${W}`)
  const ws = await h.makeWorkspace(alice, [bob, carol])
  await db.update(schema.workspaceMembers).set({ role: 'admin' }).where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, carol.id)))
  // another workspace Alice owns: its collections never show on this workspace's pages
  const ws2 = await h.makeWorkspace(alice, [], `Other ${W}`)

  // field ids long enough to search for in a response
  const F = { st: `fst${W}`, pts: `fpts${W}`, pri: `fpri${W}` }
  const opt = { todo: `otodo${W}`, done: `odone${W}`, hi: `ohi${W}`, lo: `olo${W}` }

  const newCollection = async (wsId: string, title: string, rows: [string, keyof typeof opt, number, keyof typeof opt][], parentId?: string) => {
    const id = (await ok(alice, 'POST', '/pages', { workspaceId: wsId, kind: 'collection', title, ...(parentId ? { parentId } : {}) })).page.id as string
    await ok(alice, 'PUT', `/pages/${id}/collection/fields`, {
      fields: [
        { id: F.st, name: 'Status', type: 'select', options: [{ id: opt.todo, name: `Todo${W}`, color: 'gray' }, { id: opt.done, name: `Done${W}`, color: 'green' }] },
        { id: F.pts, name: 'Points', type: 'number' },
        { id: F.pri, name: 'Priority', type: 'select', options: [{ id: opt.hi, name: `High${W}`, color: 'red' }, { id: opt.lo, name: `Low${W}`, color: 'blue' }] },
      ],
    })
    const rowIds: string[] = []
    for (const [t, st, pts, pri] of rows) {
      rowIds.push((await ok(alice, 'POST', `/pages/${id}/collection/rows`, { title: t, props: { [F.st]: opt[st], [F.pts]: pts, [F.pri]: opt[pri] }, template: null })).row.id)
    }
    return { id, rowIds }
  }

  // ── sources ───────────────────────────────────────────────────────────────
  const sales = await newCollection(ws.id, `SalesTitle${W}`, [
    [`SalesRowA${W}`, 'todo', 3, 'hi'],
    [`SalesRowB${W}`, 'done', 5, 'lo'],
    [`SalesRowC${W}`, 'done', 7, 'hi'],
  ])
  const view = (await ok(alice, 'POST', `/pages/${sales.id}/collection/views`, {
    name: `ViewSecret${W}`,
    type: 'table',
    config: { filters: [{ fieldId: F.st, op: 'eq', value: opt.done }] },
  })).view as { id: string }
  const tasks = await newCollection(ws.id, `TasksTitle${W}`, [[`TaskLabelOne${W}`, 'todo', 1, 'lo']])
  const foreign = await newCollection(ws2.id, `ForeignTitle${W}`, [[`ForeignRow${W}`, 'todo', 9, 'hi']])
  const query = `LIST FROM "TasksTitle${W}"`

  const chart = (c: Record<string, unknown>) => ({ type: 'chart', props: { config: canonicalChartJson(c as never) }, children: [] })
  const charts = {
    bar: chart({ source: { type: 'collection', collectionId: sales.id }, kind: 'bar', groupBy: { field: F.st }, title: `BarTitle${W}` }),
    stacked: chart({
      source: { type: 'collection', collectionId: sales.id, viewId: view.id },
      kind: 'stackedBar',
      groupBy: { field: F.st },
      series: { field: F.pri },
      measure: { fn: 'sum', field: F.pts },
      title: `StackTitle${W}`,
    }),
    line: chart({ source: { type: 'collection', collectionId: sales.id }, kind: 'line', groupBy: { field: F.pri }, measure: { fn: 'sum', field: F.pts } }),
    query: chart({ source: { type: 'query', query }, kind: 'pie', groupBy: { field: 'title' }, title: `QueryTitle${W}` }),
    foreign: chart({ source: { type: 'collection', collectionId: foreign.id }, kind: 'bar', groupBy: { field: F.st }, title: `ForeignChart${W}` }),
  }
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }], children: [] })
  const report = await h.makeDocPage(ws.id, alice.id, `Report${W}`, [
    para('Intro'),
    charts.bar,
    charts.stacked,
    charts.line,
    charts.query,
    charts.foreign,
    para('Outro'),
  ] as never)

  /** Strings that must never be in a public response, whatever the setting. */
  const SECRET = [
    sales.id, view.id, tasks.id, foreign.id, ...sales.rowIds, ...Object.values(F), ...Object.values(opt),
    `ViewSecret${W}`, `SalesTitle${W}`, `TasksTitle${W}`, `ForeignTitle${W}`, `ForeignRow${W}`, `ForeignChart${W}`,
    `SalesRowA${W}`, `SalesRowB${W}`, `SalesRowC${W}`, 'LIST FROM', 'collectionId', 'viewId', 'groupBy', 'inkling:',
  ]
  /** Strings of the charts' titles and numbers (absent while the setting is off). */
  const CHART_TEXT = [`BarTitle${W}`, `StackTitle${W}`, `QueryTitle${W}`, `Todo${W}`, `Done${W}`, `High${W}`, `Low${W}`, `TaskLabelOne${W}`]
  const assertNone = (body: string, words: string[], what: string) => {
    for (const w of words) assert.ok(!body.includes(w), `${what} must not contain ${w}`)
  }

  const share = (await ok(alice, 'POST', `/pages/${report.id}/share`)) as ShareStatusDTO
  const token = share.token!
  const page = async () => {
    const res = await visit(`/api/public/${token}`)
    assert.equal(res.statusCode, 200, res.body)
    return { body: res.body, dto: res.json() as PublicPageDTO }
  }

  it('off by default: a new link says how many charts it leaves out, and the page has none of them', async () => {
    assert.equal(share.includeCharts, false)
    assert.deepEqual(share.charts, { total: 5, hidden: 5 })
    const { body, dto } = await page()
    assert.equal(dto.charts, undefined)
    assertNone(body, [...SECRET, ...CHART_TEXT], 'off page')
    assert.match(dto.html, /Intro/)
    assert.match(dto.html, /Outro/)
  })

  it('only the managers of the link turn it on; audited; the dialog names whose access it uses', async () => {
    assert.equal((await call(bob, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })).statusCode, 403)
    const stranger = await h.makeUser(`Stranger${W}`)
    assert.equal((await call(stranger, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })).statusCode, 404)
    // a new link never takes it
    assert.equal((await call(alice, 'POST', `/pages/${tasks.id}/share`, { includeCharts: true })).statusCode, 400)
    const on = (await ok(carol, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })) as ShareStatusDTO
    assert.equal(on.includeCharts, true)
    assert.equal(on.chartsBy, `Carol${W}`)
    // the foreign workspace's collection is left out even for a person who can see it
    assert.deepEqual(on.charts, { total: 5, hidden: 1 })
    const [row] = await db.select({ by: schema.pages.shareChartsBy }).from(schema.pages).where(eq(schema.pages.id, report.id))
    assert.equal(row.by, carol.id)
    // sending it again keeps who turned it on
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })
    const [again] = await db.select({ by: schema.pages.shareChartsBy }).from(schema.pages).where(eq(schema.pages.id, report.id))
    assert.equal(again.by, carol.id)
    const audit = await db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.targetId, report.id), eq(schema.workspaceAuditEvents.action, 'share.charts_changed')))
    assert.equal(audit.length, 1)
    assert.deepEqual(audit[0].before, { includeCharts: false })
    assert.deepEqual(audit[0].after, { includeCharts: true })
    const status = (await ok(bob, 'GET', `/pages/${report.id}/share`)) as ShareStatusDTO
    assert.equal(status.includeCharts, true)
    assert.deepEqual(status.charts, { total: 5, hidden: 1 })
  })

  it('on: aggregates as labels and numbers, in place of each chart; no ids, query text or other rows', async () => {
    const { body, dto } = await page()
    const list = dto.charts as PublicChartDTO[]
    assert.equal(list.length, 4)
    assert.deepEqual(list.map((c) => c.kind), ['bar', 'stackedBar', 'line', 'pie'])
    const [bar, stacked, line, pie] = list
    assert.equal(bar.title, `BarTitle${W}`)
    assert.deepEqual(bar.groups.map((g) => g.label), [`Todo${W}`, `Done${W}`])
    assert.deepEqual(bar.values, [1, 2])
    assert.deepEqual(bar.measure, { fn: 'count' })
    assert.equal(bar.group, 'Status')
    // the view's filter (Done only), split by priority, summed
    assert.deepEqual(stacked.groups.map((g) => g.label), [`Done${W}`])
    assert.deepEqual(stacked.seriesKeys?.map((g) => g.label), [`High${W}`, `Low${W}`])
    assert.deepEqual(stacked.values, [[7, 5]])
    assert.deepEqual(stacked.measure, { fn: 'sum', name: 'Points' })
    assert.equal(line.title, undefined)
    assert.deepEqual(line.values, [10, 5])
    // a query source as the manager who turned it on: row titles are its labels
    assert.deepEqual(pie.groups.map((g) => g.label), [`TaskLabelOne${W}`])
    // every chart has its place in the HTML: title block and table block by anchor
    for (const c of list) {
      assert.match(c.anchor, /^ic-[0-9a-f]{12}-\d+$/)
      assert.ok(dto.html.includes(`data-id="${c.anchor}-t"`), `table of ${c.kind}`)
      assert.equal(dto.html.includes(`data-id="${c.anchor}"`), !!c.title, `title of ${c.kind}`)
      assert.deepEqual(Object.keys(c).sort(), [
        'anchor', 'group', 'groups', 'kind', 'measure', 'omittedGroups', 'omittedSeries', 'values',
        ...(c.series ? ['series', 'seriesKeys'] : []), ...(c.title ? ['title'] : []),
      ].sort())
    }
    assert.match(dto.html, new RegExp(`BarTitle${W}`))
    assert.match(dto.html, /<table/)
    // the whole response, not only the chart part
    assertNone(body, SECRET, 'on page')
    assert.ok(!body.includes(`"key"`), 'no group keys')
  })

  it('the Markdown download has each chart as its title and a table', async () => {
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { allowDownload: true })
    const res = await visit(`/api/public/${token}/export.md`)
    assert.equal(res.statusCode, 200, res.body)
    assert.match(res.body, new RegExp(`\\*\\*BarTitle${W}\\*\\*\\n\\n\\| Status +\\| Count +\\|`))
    assert.match(res.body, new RegExp(`\\| Done${W} +\\| 7 +\\| 5 +\\|`))
    assertNone(res.body, SECRET, 'markdown')
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { allowDownload: false })
  })

  it('a password or expiry comes first: nothing of a chart before the link opens', async () => {
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { password: 'hunter22-long' })
    const locked = await visit(`/api/public/${token}`)
    assert.equal(locked.statusCode, 401)
    assertNone(locked.body, [...SECRET, ...CHART_TEXT], 'locked page')
    const unlock = await app.inject({ method: 'POST', url: `/api/public/${token}/unlock`, payload: { password: 'hunter22-long' } })
    assert.equal(unlock.statusCode, 204, unlock.body)
    const cookie = String(unlock.headers['set-cookie']).split(';')[0]
    const open = await visit(`/api/public/${token}`, cookie)
    assert.equal((open.json() as PublicPageDTO).charts?.length, 4)
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { password: null })
    await db.update(schema.pages).set({ shareExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.pages.id, report.id))
    const expired = await visit(`/api/public/${token}`)
    assert.equal(expired.statusCode, 410)
    assertNone(expired.body, [...SECRET, ...CHART_TEXT], 'expired page')
    await db.update(schema.pages).set({ shareExpiresAt: null }).where(eq(schema.pages.id, report.id))
  })

  it('off again: gone at once from a warm cache', async () => {
    assert.equal((await page()).dto.charts?.length, 4)
    assert.equal((await page()).dto.charts?.length, 4) // served from the render cache
    const off = (await ok(alice, 'PATCH', `/pages/${report.id}/share`, { includeCharts: false })) as ShareStatusDTO
    assert.equal(off.includeCharts, false)
    assert.equal(off.chartsBy, undefined)
    assert.deepEqual(off.charts, { total: 5, hidden: 5 })
    const { body, dto } = await page()
    assert.equal(dto.charts, undefined)
    assertNone(body, [...SECRET, ...CHART_TEXT], 'page after off')
  })

  it('the person who turned it on leaves the workspace: the charts go, cache or not', async () => {
    await ok(carol, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })
    assert.equal((await page()).dto.charts?.length, 4)
    assert.equal((await page()).dto.charts?.length, 4)
    await ok(alice, 'DELETE', `/workspaces/${ws.id}/members/${carol.id}`)
    const { body, dto } = await page()
    assert.equal(dto.charts, undefined)
    assertNone(body, [...SECRET, ...CHART_TEXT], 'page after the enabler left')
    const status = (await ok(alice, 'GET', `/pages/${report.id}/share`)) as ShareStatusDTO
    assert.equal(status.includeCharts, true)
    assert.deepEqual(status.charts, { total: 5, hidden: 5 })
    // a manager turns it off and on again: their own access from now on
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { includeCharts: false })
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })
    assert.equal((await page()).dto.charts?.length, 4)
  })

  it('a source the person can no longer see goes (the next render of the page)', async () => {
    // Bob turns it on; Alice's private collection is hers only
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: bob.id, role: 'admin' }).onConflictDoUpdate({
      target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
      set: { role: 'admin' },
    })
    await ok(alice, 'PATCH', `/pages/${report.id}/share`, { includeCharts: false })
    await ok(bob, 'PATCH', `/pages/${report.id}/share`, { includeCharts: true })
    assert.equal((await page()).dto.charts?.length, 4)
    await db.update(schema.pages).set({ scope: 'private', ownerId: alice.id }).where(eq(schema.pages.id, sales.id))
    await db.update(schema.pages).set({ updatedAt: sql`now()` }).where(eq(schema.pages.id, report.id))
    const { dto } = await page()
    assert.deepEqual(dto.charts?.map((c) => c.kind), ['pie'])
    const status = (await ok(bob, 'GET', `/pages/${report.id}/share`)) as ShareStatusDTO
    assert.deepEqual(status.charts, { total: 5, hidden: 4 })
    await db.update(schema.pages).set({ scope: 'shared', ownerId: null }).where(eq(schema.pages.id, sales.id))
  })

  it('unpublishing clears it; a new link starts off', async () => {
    await ok(alice, 'DELETE', `/pages/${report.id}/share`)
    const [row] = await db
      .select({ on: schema.pages.shareIncludeCharts, by: schema.pages.shareChartsBy })
      .from(schema.pages)
      .where(eq(schema.pages.id, report.id))
    assert.deepEqual(row, { on: false, by: null })
    const again = (await ok(alice, 'POST', `/pages/${report.id}/share`)) as ShareStatusDTO
    assert.equal(again.includeCharts, false)
    const res = await visit(`/api/public/${again.token}`)
    assert.equal((res.json() as PublicPageDTO).charts, undefined)
    // before a link exists the dialog still counts (the setting is off then)
    const draft = await h.makeDocPage(ws.id, alice.id, `Draft${W}`, [charts.bar] as never)
    const status = (await ok(alice, 'GET', `/pages/${draft.id}/share`)) as ShareStatusDTO
    assert.equal(status.shared, false)
    assert.deepEqual(status.charts, { total: 1, hidden: 1 })
  })

  it('folder link: its own collections are charts when off; the rest only when on', async () => {
    const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Folder${W}`, kind: 'folder', createdBy: alice.id }).returning()
    const inside = await newCollection(ws.id, `InsideTitle${W}`, [[`InsideRow${W}`, 'done', 2, 'lo']], folder.id)
    const child = await h.makeDocPage(
      ws.id,
      alice.id,
      `Child${W}`,
      [
        chart({ source: { type: 'collection', collectionId: inside.id }, kind: 'donut', groupBy: { field: F.st }, title: `InsideChart${W}` }),
        charts.bar,
        charts.foreign,
      ] as never,
      { parentId: folder.id },
    )
    const s = (await ok(alice, 'POST', `/pages/${folder.id}/share`)) as ShareStatusDTO
    assert.deepEqual(s.charts, { total: 3, hidden: 2 })
    const tree = (await visit(`/api/public/${s.token}`)).json() as { tree: { ref: string; title: string }[] }
    const ref = tree.tree.find((n) => n.title === `Child${W}`)!.ref
    const get = async () => (await visit(`/api/public/${s.token}/p/${ref}`)).json() as PublicPageDTO
    const off = await get()
    assert.deepEqual(off.charts?.map((c) => c.title), [`InsideChart${W}`])
    assert.deepEqual(off.charts?.[0].groups.map((g) => g.label), [`Done${W}`])
    assertNone(JSON.stringify(off), [...SECRET, `BarTitle${W}`, `Todo${W}`, inside.id], 'folder page off')
    const on = (await ok(alice, 'PATCH', `/pages/${folder.id}/share`, { includeCharts: true })) as ShareStatusDTO
    assert.deepEqual(on.charts, { total: 3, hidden: 1 })
    const both = await get()
    assert.deepEqual(both.charts?.map((c) => c.title), [`InsideChart${W}`, `BarTitle${W}`])
    assertNone(JSON.stringify(both), [...SECRET, inside.id], 'folder page on')
    void child
  })
})
