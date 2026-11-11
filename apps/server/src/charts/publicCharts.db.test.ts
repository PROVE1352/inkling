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
      await (await import('../routes/pageContent')).registerPageContentRoutes(api)
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
    assert.deepEqual(share.charts, { total: 5, hidden: 5, pending: 0 })
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
    assert.deepEqual(on.charts, { total: 5, hidden: 1, pending: 0 })
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
    // turning on approves the three sources the page's charts use (docs/adr/2444-*)
    assert.deepEqual(audit[0].after, { includeCharts: true, sources: 3 })
    const status = (await ok(bob, 'GET', `/pages/${report.id}/share`)) as ShareStatusDTO
    assert.equal(status.includeCharts, true)
    assert.deepEqual(status.charts, { total: 5, hidden: 1, pending: 0 })
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
    assert.deepEqual(off.charts, { total: 5, hidden: 5, pending: 0 })
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
    assert.deepEqual(status.charts, { total: 5, hidden: 5, pending: 0 })
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
    assert.deepEqual(status.charts, { total: 5, hidden: 4, pending: 0 })
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
    assert.deepEqual(status.charts, { total: 1, hidden: 1, pending: 0 })
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
    assert.deepEqual(s.charts, { total: 3, hidden: 2, pending: 0 })
    const tree = (await visit(`/api/public/${s.token}`)).json() as { tree: { ref: string; title: string }[] }
    const ref = tree.tree.find((n) => n.title === `Child${W}`)!.ref
    const get = async () => (await visit(`/api/public/${s.token}/p/${ref}`)).json() as PublicPageDTO
    const off = await get()
    assert.deepEqual(off.charts?.map((c) => c.title), [`InsideChart${W}`])
    assert.deepEqual(off.charts?.[0].groups.map((g) => g.label), [`Done${W}`])
    assertNone(JSON.stringify(off), [...SECRET, `BarTitle${W}`, `Todo${W}`, inside.id], 'folder page off')
    const on = (await ok(alice, 'PATCH', `/pages/${folder.id}/share`, { includeCharts: true })) as ShareStatusDTO
    assert.deepEqual(on.charts, { total: 3, hidden: 1, pending: 0 })
    const both = await get()
    assert.deepEqual(both.charts?.map((c) => c.title), [`InsideChart${W}`, `BarTitle${W}`])
    assertNone(JSON.stringify(both), [...SECRET, inside.id], 'folder page on')
    void child
  })
  it('approved sources only (docs/adr/2444-*): an editor’s new chart of another database waits for a manager', async () => {
    const dave = await h.makeUser(`Dave${W}`)
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: dave.id, role: 'member' })
    // a database only Alice can see, and its rows
    const budget = await newCollection(ws.id, `BudgetTitle${W}`, [[`BudgetRowSecret${W}`, 'todo', 40, 'hi']])
    await db.update(schema.pages).set({ scope: 'private', ownerId: alice.id }).where(eq(schema.pages.id, budget.id))
    assert.equal((await call(dave, 'GET', `/pages/${budget.id}`)).statusCode, 404)
    const q1 = `LIST FROM "TasksTitle${W}"`
    const page2 = await h.makeDocPage(ws.id, alice.id, `Approval${W}`, [
      chart({ source: { type: 'collection', collectionId: sales.id }, kind: 'bar', groupBy: { field: F.st }, title: `ApprovedBar${W}` }),
      chart({ source: { type: 'query', query: q1 }, kind: 'pie', groupBy: { field: 'title' }, title: `ApprovedQuery${W}` }),
    ] as never)
    const s0 = (await ok(alice, 'POST', `/pages/${page2.id}/share`)) as ShareStatusDTO
    // approving needs charts on; and no token can approve (the route is session-only)
    assert.equal((await call(alice, 'PATCH', `/pages/${page2.id}/share`, { approveChartSources: true })).statusCode, 409)
    const on = (await ok(alice, 'PATCH', `/pages/${page2.id}/share`, { includeCharts: true })) as ShareStatusDTO
    assert.deepEqual(on.charts, { total: 2, hidden: 0, pending: 0 })
    const [stored] = await db.select({ src: schema.pages.shareChartSources }).from(schema.pages).where(eq(schema.pages.id, page2.id))
    assert.equal((stored.src as string[]).length, 2)
    assert.ok((stored.src as string[]).includes(`c:${sales.id}`))
    const get = async () => {
      const res = await visit(`/api/public/${s0.token}`)
      assert.equal(res.statusCode, 200, res.body)
      return { body: res.body, dto: res.json() as PublicPageDTO }
    }
    const titles = async () => ((await get()).dto.charts ?? []).map((c) => c.title)
    assert.deepEqual(await titles(), [`ApprovedBar${W}`, `ApprovedQuery${W}`])
    // Dave (a member who cannot see Budget) adds a chart of it, grouped by row title
    const sneak = { source: { type: 'collection', collectionId: budget.id }, kind: 'bar', groupBy: { field: 'title' }, title: `SneakTitle${W}` }
    const md = (c: Record<string, unknown>) => `<!-- inkling:chart ${canonicalChartJson(c as never)} -->`
    await ok(dave, 'POST', `/pages/${page2.id}/content`, { mode: 'append', markdown: md(sneak) })
    {
      const { body, dto } = await get()
      assert.deepEqual(dto.charts?.map((c) => c.title), [`ApprovedBar${W}`, `ApprovedQuery${W}`])
      assertNone(body, [`SneakTitle${W}`, `BudgetRowSecret${W}`, `BudgetTitle${W}`, budget.id], 'page with a waiting chart')
    }
    const waiting = (await ok(alice, 'GET', `/pages/${page2.id}/share`)) as ShareStatusDTO
    assert.deepEqual(waiting.charts, { total: 3, hidden: 1, pending: 1 })
    // a new chart of an approved database shows at once; so does an approved query written with other spaces
    await ok(dave, 'POST', `/pages/${page2.id}/content`, {
      mode: 'append',
      markdown: `${md({ source: { type: 'collection', collectionId: sales.id }, kind: 'line', groupBy: { field: F.pri }, title: `SameDbNew${W}` })}\n\n${md({ source: { type: 'query', query: `  LIST   FROM "TasksTitle${W}" ` }, kind: 'donut', groupBy: { field: 'title' }, title: `SameQuery${W}` })}`,
    })
    assert.deepEqual(await titles(), [`ApprovedBar${W}`, `ApprovedQuery${W}`, `SameDbNew${W}`, `SameQuery${W}`])
    // another query text waits
    await ok(dave, 'POST', `/pages/${page2.id}/content`, {
      mode: 'append',
      markdown: md({ source: { type: 'query', query: `TABLE Points FROM "SalesTitle${W}"` }, kind: 'bar', groupBy: { field: 'title' }, title: `OtherQuery${W}` }),
    })
    assert.ok(!(await titles()).includes(`OtherQuery${W}`))
    assert.ok(!(await get()).body.includes(`SalesRowA${W}`))
    assert.deepEqual(((await ok(alice, 'GET', `/pages/${page2.id}/share`)) as ShareStatusDTO).charts, { total: 6, hidden: 2, pending: 2 })
    // a member cannot approve; a token cannot either (session only)
    assert.equal((await call(dave, 'PATCH', `/pages/${page2.id}/share`, { approveChartSources: true })).statusCode, 403)
    const token = await h.mintToken(alice, 'notes write')
    const viaToken = await app.inject({ method: 'PATCH', url: `/api/pages/${page2.id}/share`, headers: { authorization: `Bearer ${token}` }, payload: { approveChartSources: true } })
    assert.ok(viaToken.statusCode === 403 || viaToken.statusCode === 401, `token: ${viaToken.statusCode}`)
    assert.ok(!(await titles()).includes(`SneakTitle${W}`))
    // Bob (an admin) approves: aggregated as Bob, who cannot see Budget either, so it stays out; the query shows
    const byBob = (await ok(bob, 'PATCH', `/pages/${page2.id}/share`, { approveChartSources: true })) as ShareStatusDTO
    assert.equal(byBob.chartsBy, `Bob${W}`)
    assert.deepEqual(byBob.charts, { total: 6, hidden: 1, pending: 0 })
    assert.ok(!(await titles()).includes(`SneakTitle${W}`))
    // Alice approves: now her access, and the chart of her database is published by her choice
    const byAlice = (await ok(alice, 'PATCH', `/pages/${page2.id}/share`, { approveChartSources: true })) as ShareStatusDTO
    assert.deepEqual(byAlice.charts, { total: 6, hidden: 0, pending: 0 })
    const after = await get()
    assert.ok(after.dto.charts?.some((c) => c.title === `SneakTitle${W}` && c.groups.some((g) => g.label === `BudgetRowSecret${W}`)))
    assert.ok(after.dto.charts?.some((c) => c.title === `OtherQuery${W}`))
    const audit = await db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.targetId, page2.id), eq(schema.workspaceAuditEvents.action, 'share.charts_changed')))
    assert.equal(audit.length, 3)
    // off forgets the list; a new link starts without one
    await ok(alice, 'PATCH', `/pages/${page2.id}/share`, { includeCharts: false })
    const [offRow] = await db.select({ src: schema.pages.shareChartSources }).from(schema.pages).where(eq(schema.pages.id, page2.id))
    assert.equal(offRow.src, null)
    assert.equal((await get()).dto.charts, undefined)
    await ok(alice, 'PATCH', `/pages/${page2.id}/share`, { includeCharts: true })
    await ok(alice, 'DELETE', `/pages/${page2.id}/share`)
    const [gone] = await db.select({ src: schema.pages.shareChartSources, by: schema.pages.shareChartsBy }).from(schema.pages).where(eq(schema.pages.id, page2.id))
    assert.deepEqual(gone, { src: null, by: null })
  })

  it('charts inside columns (docs/adr/2420-*): counted, approved and drawn in their column; a waiting one stays out', async () => {
    const erin = await h.makeUser(`Erin${W}`)
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: erin.id, role: 'member' })
    const vault = await newCollection(ws.id, `VaultTitle${W}`, [[`VaultRowSecret${W}`, 'todo', 11, 'hi']])
    await db.update(schema.pages).set({ scope: 'private', ownerId: alice.id }).where(eq(schema.pages.id, vault.id))
    const colQuery = `LIST FROM "SalesTitle${W}"`
    const page3 = await h.makeDocPage(ws.id, alice.id, `Columns${W}`, [
      para('Before'),
      {
        type: 'columnList',
        props: {},
        children: [
          {
            type: 'column',
            props: {},
            children: [para('LeftCol'), chart({ source: { type: 'collection', collectionId: sales.id }, kind: 'bar', groupBy: { field: F.st }, title: `ColBar${W}` })],
          },
          {
            type: 'column',
            props: {},
            children: [para('RightCol'), chart({ source: { type: 'query', query: colQuery }, kind: 'pie', groupBy: { field: 'title' }, title: `ColQuery${W}` })],
          },
        ],
      },
      para('After'),
    ] as never)
    const s = (await ok(alice, 'POST', `/pages/${page3.id}/share`)) as ShareStatusDTO
    assert.deepEqual(s.charts, { total: 2, hidden: 2, pending: 0 })
    const get = async () => {
      const res = await visit(`/api/public/${s.token}`)
      assert.equal(res.statusCode, 200, res.body)
      return { body: res.body, dto: res.json() as PublicPageDTO }
    }
    const COL_TEXT = [`ColBar${W}`, `ColQuery${W}`, `Todo${W}`, `Done${W}`, `SalesRowA${W}`]
    {
      const { body, dto } = await get()
      assert.equal(dto.charts, undefined)
      assertNone(body, [...SECRET, ...COL_TEXT, 'SalesTitle', 'inkling:'], 'columns page off')
      assert.equal((dto.html.match(/data-node-type="columnList"/g) ?? []).length, 1)
      assert.equal((dto.html.match(/data-node-type="column"/g) ?? []).length, 2)
      assert.ok(dto.html.indexOf('LeftCol') < dto.html.indexOf('RightCol'))
    }
    // turning on approves the sources of the charts inside the columns too
    const on = (await ok(alice, 'PATCH', `/pages/${page3.id}/share`, { includeCharts: true })) as ShareStatusDTO
    assert.deepEqual(on.charts, { total: 2, hidden: 0, pending: 0 })
    const [stored] = await db.select({ src: schema.pages.shareChartSources }).from(schema.pages).where(eq(schema.pages.id, page3.id))
    assert.equal((stored.src as string[]).length, 2)
    assert.ok((stored.src as string[]).includes(`c:${sales.id}`))
    {
      const { body, dto } = await get()
      const list = dto.charts as PublicChartDTO[]
      assert.deepEqual(list.map((c) => c.title), [`ColBar${W}`, `ColQuery${W}`])
      assert.deepEqual(list[0].values, [1, 2])
      const at = (needle: string) => {
        const i = dto.html.indexOf(needle)
        assert.ok(i >= 0, `html has ${needle}`)
        return i
      }
      // each chart's stand-in sits in its own column, in order
      assert.ok(at('Before') < at('LeftCol'))
      assert.ok(at('LeftCol') < at(`data-id="${list[0].anchor}-t"`))
      assert.ok(at(`data-id="${list[0].anchor}-t"`) < at('RightCol'))
      assert.ok(at('RightCol') < at(`data-id="${list[1].anchor}-t"`))
      assert.ok(at(`data-id="${list[1].anchor}-t"`) < at('After'))
      assertNone(body, [...SECRET.filter((x) => x !== `SalesRowA${W}` && x !== `SalesRowB${W}` && x !== `SalesRowC${W}`), 'LIST FROM'], 'columns page on')
    }
    // an editor adds a column group whose chart reads a database only Alice can see: it waits
    const md = (c: Record<string, unknown>) => `<!-- inkling:chart ${canonicalChartJson(c as never)} -->`
    await ok(erin, 'POST', `/pages/${page3.id}/content`, {
      mode: 'append',
      markdown: [
        '<!-- inkling:columns -->',
        '<!-- inkling:column -->',
        'ErinLeft',
        '',
        md({ source: { type: 'collection', collectionId: vault.id }, kind: 'bar', groupBy: { field: 'title' }, title: `ColSneak${W}` }),
        '<!-- inkling:column -->',
        'ErinRight',
        '<!-- /inkling:columns -->',
      ].join('\n'),
    })
    {
      const { body, dto } = await get()
      assert.deepEqual(dto.charts?.map((c) => c.title), [`ColBar${W}`, `ColQuery${W}`])
      assert.ok(dto.html.includes('ErinLeft') && dto.html.includes('ErinRight'), 'the new columns are on the page')
      assert.equal((dto.html.match(/data-node-type="columnList"/g) ?? []).length, 2, 'the appended markers made a column group')
      assertNone(body, [`ColSneak${W}`, `VaultRowSecret${W}`, `VaultTitle${W}`, vault.id], 'columns page with a waiting chart')
    }
    assert.deepEqual(((await ok(alice, 'GET', `/pages/${page3.id}/share`)) as ShareStatusDTO).charts, { total: 3, hidden: 1, pending: 1 })
    // the Markdown download: the approved charts as title and table inside the column markers, the waiting one absent
    await ok(alice, 'PATCH', `/pages/${page3.id}/share`, { allowDownload: true })
    const dl = await visit(`/api/public/${s.token}/export.md`)
    assert.equal(dl.statusCode, 200, dl.body)
    assert.match(dl.body, new RegExp(`\\*\\*ColBar${W}\\*\\*\\n\\n\\| Status +\\| Count +\\|`))
    assert.match(dl.body, new RegExp(`\\*\\*ColQuery${W}\\*\\*`))
    assert.ok(dl.body.indexOf('LeftCol') < dl.body.indexOf(`ColBar${W}`) && dl.body.indexOf(`ColBar${W}`) < dl.body.indexOf('RightCol'))
    assertNone(dl.body, [`ColSneak${W}`, `VaultRowSecret${W}`, vault.id, 'LIST FROM', 'collectionId'], 'columns markdown')
    // approving publishes the waiting chart in its column
    const approved = (await ok(alice, 'PATCH', `/pages/${page3.id}/share`, { approveChartSources: true })) as ShareStatusDTO
    assert.deepEqual(approved.charts, { total: 3, hidden: 0, pending: 0 })
    const { dto } = await get()
    const sneak = dto.charts?.find((c) => c.title === `ColSneak${W}`)
    assert.ok(sneak && sneak.groups.some((g) => g.label === `VaultRowSecret${W}`))
    assert.ok(dto.html.indexOf('ErinLeft') < dto.html.indexOf(`data-id="${sneak.anchor}-t"`))
    assert.ok(dto.html.indexOf(`data-id="${sneak.anchor}-t"`) < dto.html.indexOf('ErinRight'))
  })

  it('a column holding only a chart: the page still renders off, on, waiting, as Markdown and in a folder link', async () => {
    const fred = await h.makeUser(`Fred${W}`)
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: fred.id, role: 'member' })
    const hidden = await newCollection(ws.id, `HiddenTitle${W}`, [[`HiddenRowSecret${W}`, 'todo', 4, 'hi']])
    await db.update(schema.pages).set({ scope: 'private', ownerId: alice.id }).where(eq(schema.pages.id, hidden.id))
    const only = (title: string, collectionId: string) =>
      ({ type: 'column', props: {}, children: [chart({ source: { type: 'collection', collectionId }, kind: 'bar', groupBy: { field: F.st }, title })] })
    const blocks = [
      para('Top'),
      // a chart alone on the left, text on the right
      { type: 'columnList', props: {}, children: [only(`OnlyLeft${W}`, sales.id), { type: 'column', props: {}, children: [para('NextToChart')] }] },
      // every column only a chart, one of them from another workspace (never shown)
      { type: 'columnList', props: {}, children: [only(`OnlyA${W}`, sales.id), only(`OnlyForeign${W}`, foreign.id)] },
      para('Bottom'),
    ]
    const page4 = await h.makeDocPage(ws.id, alice.id, `ChartOnly${W}`, blocks as never)
    const s = (await ok(alice, 'POST', `/pages/${page4.id}/share`)) as ShareStatusDTO
    await ok(alice, 'PATCH', `/pages/${page4.id}/share`, { allowDownload: true })
    const both = async (what: string) => {
      const res = await visit(`/api/public/${s.token}`)
      assert.equal(res.statusCode, 200, `${what}: ${res.body.slice(0, 300)}`)
      const dto = res.json() as PublicPageDTO
      for (const w of ['Top', 'NextToChart', 'Bottom']) assert.ok(dto.html.includes(w), `${what}: html has ${w}`)
      assertNone(res.body, [...SECRET, `OnlyForeign${W}`, `HiddenRowSecret${W}`, `HiddenTitle${W}`, hidden.id], `${what} page`)
      const md = await visit(`/api/public/${s.token}/export.md`)
      assert.equal(md.statusCode, 200, `${what} markdown: ${md.body.slice(0, 300)}`)
      for (const w of ['Top', 'NextToChart', 'Bottom']) assert.ok(md.body.includes(w), `${what}: markdown has ${w}`)
      // the column markers are the 0.20 notation (docs/adr/2422-*); nothing else of the notation
      assertNone(md.body, [...SECRET.filter((x) => x !== 'inkling:'), 'inkling:chart', `OnlyForeign${W}`, `HiddenRowSecret${W}`, hidden.id], `${what} markdown`)
      return { dto, md: md.body }
    }
    {
      const { dto, md } = await both('off')
      assert.equal(dto.charts, undefined)
      assertNone(dto.html + md, [`OnlyLeft${W}`, `OnlyA${W}`], 'off')
    }
    await ok(alice, 'PATCH', `/pages/${page4.id}/share`, { includeCharts: true })
    {
      const { dto, md } = await both('on')
      assert.deepEqual(dto.charts?.map((c) => c.title), [`OnlyLeft${W}`, `OnlyA${W}`])
      assert.ok(md.includes(`**OnlyLeft${W}**`) && md.includes(`**OnlyA${W}**`))
      assert.ok(dto.html.indexOf(`data-id="${dto.charts![0].anchor}-t"`) < dto.html.indexOf('NextToChart'))
    }
    // a member adds a group whose only column is a chart of a database only Alice can see: it waits
    await ok(fred, 'POST', `/pages/${page4.id}/content`, {
      mode: 'append',
      markdown: [
        '<!-- inkling:columns -->',
        '<!-- inkling:column -->',
        `<!-- inkling:chart ${canonicalChartJson({ source: { type: 'collection', collectionId: hidden.id }, kind: 'bar', groupBy: { field: 'title' }, title: `OnlyHidden${W}` } as never)} -->`,
        '<!-- inkling:column -->',
        `<!-- inkling:chart ${canonicalChartJson({ source: { type: 'collection', collectionId: foreign.id }, kind: 'bar', groupBy: { field: F.st }, title: `OnlyForeign2${W}` } as never)} -->`,
        '<!-- /inkling:columns -->',
        '',
        'FredAfter',
      ].join('\n'),
    })
    {
      const { dto, md } = await both('waiting')
      assert.deepEqual(dto.charts?.map((c) => c.title), [`OnlyLeft${W}`, `OnlyA${W}`])
      assert.ok(dto.html.includes('FredAfter') && md.includes('FredAfter'))
      assertNone(dto.html + md, [`OnlyHidden${W}`, `OnlyForeign2${W}`], 'waiting')
    }
    assert.deepEqual(((await ok(alice, 'GET', `/pages/${page4.id}/share`)) as ShareStatusDTO).charts, { total: 5, hidden: 3, pending: 1 })
    // the same blocks inside a folder link, charts off (its own collections only): no chart of the page shows
    const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `ColFolder${W}`, kind: 'folder', createdBy: alice.id }).returning()
    await h.makeDocPage(ws.id, alice.id, `ColChild${W}`, blocks as never, { parentId: folder.id })
    const fs = (await ok(alice, 'POST', `/pages/${folder.id}/share`)) as ShareStatusDTO
    const tree = (await visit(`/api/public/${fs.token}`)).json() as { tree: { ref: string; title: string }[] }
    const ref = tree.tree.find((n) => n.title === `ColChild${W}`)!.ref
    const child = await visit(`/api/public/${fs.token}/p/${ref}`)
    assert.equal(child.statusCode, 200, child.body.slice(0, 300))
    const cdto = child.json() as PublicPageDTO
    assert.equal(cdto.charts, undefined)
    for (const w of ['Top', 'NextToChart', 'Bottom']) assert.ok(cdto.html.includes(w), `folder child: html has ${w}`)
    assertNone(child.body, [...SECRET, `OnlyLeft${W}`, `OnlyA${W}`, `OnlyForeign${W}`], 'folder child')
  })
})
