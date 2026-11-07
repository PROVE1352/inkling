// [db] route-level template tests (docs/adr/0920-0925): instantiation, remapping, atomicity,
// caps, visibility, legacy rows, export/import and the MCP tools.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-templates-${process.pid}`

import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] templates', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { createSession, SESSION_COOKIE } = await import('../auth')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { sql, eq, and, inArray } = await import('drizzle-orm')
  const { markdownToBlocks, blocksToStateBuffer, stateToBlocks } = await import('../md/convert')
  const JSZip = (await import('jszip')).default
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION' } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/templates')).registerTemplateRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/collections')).registerCollectionRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.register(async (root) => {
    await (await import('../mcp')).registerMcpRoutes(root, app)
  })
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  const tag = () => randomUUID().slice(0, 8)
  async function user(name = 'u') {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `${name}-${tag()}@t.t`, name, passwordHash: 'x' })
      .returning()
    const { token } = await createSession(u.id)
    return { ...u, cookie: `${SESSION_COOKIE}=${token}` }
  }
  async function workspace(owner: { id: string }, members: { id: string }[] = [], name = 'Acme') {
    const [ws] = await db.insert(schema.workspaces).values({ name, inviteCode: `T${tag()}` }).returning()
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: ws.id, userId: owner.id, role: 'owner' as const },
      ...members.map((m) => ({ workspaceId: ws.id, userId: m.id, role: 'member' as const })),
    ])
    return ws
  }
  async function page(wsId: string, by: string, v: Partial<typeof schema.pages.$inferInsert> = {}) {
    const [p] = await db
      .insert(schema.pages)
      .values({ workspaceId: wsId, title: v.title ?? 'p', createdBy: by, ...v })
      .returning()
    return p
  }
  async function setDoc(pageId: string, md: string, resolve: (t: string) => string | null = () => null) {
    const state = blocksToStateBuffer(await markdownToBlocks(md, resolve))
    await db.insert(schema.pageDocs).values({ pageId, state }).onConflictDoUpdate({ target: schema.pageDocs.pageId, set: { state } })
  }
  async function docBlocks(pageId: string) {
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return stateToBlocks(d.state)
  }
  const req = (cookie: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'GET', url, headers: { cookie, ...headers }, payload: payload as object })
  function links(blocks: unknown): string[] {
    return [...JSON.stringify(blocks).matchAll(/"href":"([^"]+)"/g)].map((m) => m[1])
  }
  function multipart(filename: string, body: Buffer) {
    const boundary = `----t${randomBytes(8).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
  }

  let owner: Awaited<ReturnType<typeof user>>
  let member: Awaited<ReturnType<typeof user>>
  let ws: Awaited<ReturnType<typeof workspace>>
  before(async () => {
    owner = await user('Owner')
    member = await user('Member')
    ws = await workspace(owner, [member])
  })

  it('instantiates the built-in Project: tree, inputs, remapped links, cursor, date in the creator zone', async () => {
    const res = await req(owner.cookie, 'POST', '/api/pages/from-template', {
      workspaceId: ws.id,
      builtinKey: 'project',
      inputs: { 'What is this project for?': 'Ship v1 to beta users' },
      date: '2026-11-07',
      tz: 'Asia/Seoul',
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { page: { id: string; title: string }; pages: { id: string; title: string; kind: string; parentId: string | null }[]; cursor?: { pageId: string; blockId: string; offset: number } }
    assert.equal(body.page.title, 'Project')
    assert.deepEqual(
      body.pages.map((p) => p.kind),
      // depth-first: root, Tasks + its 3 rows, Meeting notes + kickoff
      ['doc', 'collection', 'doc', 'doc', 'doc', 'folder', 'doc'],
    )
    const tasks = body.pages.find((p) => p.title === 'Tasks')!
    const notes = body.pages.find((p) => p.title === 'Meeting notes')!
    assert.ok(body.pages.some((p) => p.title === 'Kickoff — 2026-11-07' && p.parentId === notes.id))
    const root = await docBlocks(body.page.id)
    const text = JSON.stringify(root)
    assert.match(text, /Ship v1 to beta users/)
    assert.match(text, /"text":"TBD"|TBD/)
    assert.match(text, /Owner/) // {{author}}
    assert.ok(!text.includes('{{'), 'no variable left')
    const hrefs = links(root)
    assert.ok(hrefs.includes(`/w/${ws.id}/p/${tasks.id}`))
    assert.ok(hrefs.includes(`/w/${ws.id}/p/${notes.id}`))
    assert.equal(body.cursor?.pageId, body.page.id)
    assert.ok(root.some((b) => b.id === body.cursor!.blockId))
    const coll = ((await req(owner.cookie, 'GET', `/api/pages/${tasks.id}/collection`)).json() as { collection: { fields: { id: string; type: string }[]; views: { type: string }[] } }).collection
    assert.deepEqual(coll.views.map((v) => v.type), ['board', 'table', 'calendar'])
    const [kick] = await db.select().from(schema.pages).where(and(eq(schema.pages.parentId, tasks.id), eq(schema.pages.title, 'Hold the kickoff meeting')))
    assert.equal((kick.props as Record<string, unknown>).due, '2026-11-07')
    assert.equal((kick.props as Record<string, unknown>).status, 'todo')
  })

  it('lists built-ins in the request language with categories, kinds and inputs', async () => {
    const res = await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates`, undefined, { 'accept-language': 'ko' })
    const list = (res.json() as { templates: { id: string; name: string; category: string; kind: string; pageCount: number; inputs: unknown[] }[] }).templates
    const project = list.find((t) => t.id === 'project')!
    assert.equal(project.name, '프로젝트')
    assert.equal(project.category, 'projects')
    assert.equal(project.kind, 'structure')
    assert.equal(project.pageCount, 7)
    assert.equal(project.inputs.length, 2)
    assert.equal(list.find((t) => t.id === 'meeting')!.kind, 'doc')
    const created = (await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, builtinKey: 'weeklyReview', date: '2026-11-07' }, { 'accept-language': 'ko' })).json() as { page: { title: string }; pages: unknown[] }
    assert.equal(created.page.title, '2026년 45주차 회고')
    assert.equal(created.pages.length, 9)
  })

  it('saves a subtree and remaps links, relations, row values and canvas page nodes on instantiation', async () => {
    const root = await page(ws.id, owner.id, { title: 'Proj {{title}}' })
    const child = await page(ws.id, owner.id, { title: 'Spec', parentId: root.id, sortOrder: 1 })
    const people = await page(ws.id, owner.id, { title: 'People', parentId: root.id, kind: 'collection', sortOrder: 2 })
    const work = await page(ws.id, owner.id, { title: 'Work', parentId: root.id, kind: 'collection', sortOrder: 3 })
    const canvas = await page(ws.id, owner.id, { title: 'Map', parentId: root.id, kind: 'canvas', sortOrder: 4 })
    const outside = await page(ws.id, owner.id, { title: 'Outside' })
    await setDoc(root.id, 'See [[Spec]] and [[Outside]] — {{date}}', (t) =>
      t === 'Spec' ? `/w/${ws.id}/p/${child.id}` : t === 'Outside' ? `/w/${ws.id}/p/${outside.id}` : null,
    )
    await setDoc(child.id, 'Back to [[Proj]]', () => `/w/${ws.id}/p/${root.id}`)
    await db.insert(schema.collections).values([
      { pageId: people.id, fields: [{ id: 'role', name: 'Role', type: 'text' }, { id: 'work', name: 'Work', type: 'relation', relation: { targetPageId: work.id, twoWay: true, pairFieldId: 'who' } }] },
      { pageId: work.id, fields: [{ id: 'who', name: 'Who', type: 'relation', relation: { targetPageId: people.id, twoWay: true, pairFieldId: 'work' } }, { id: 'ext', name: 'Ext', type: 'relation', relation: { targetPageId: outside.id } }] },
    ])
    await db.insert(schema.collectionViews).values([{ pageId: work.id, name: 'Board', type: 'board', config: { groupByFieldId: 'who' } }])
    const w1 = await page(ws.id, owner.id, { title: 'Task {{input:First task|Draft}}', parentId: work.id })
    const p1 = await page(ws.id, owner.id, { title: 'Alice', parentId: people.id, props: { role: 'Lead of {{title}}', work: [w1.id] } })
    await db.update(schema.pages).set({ props: { who: [p1.id], ext: [outside.id] } }).where(eq(schema.pages.id, w1.id))
    const cdoc = new Y.Doc()
    cdoc.getMap('cnodes').set('n1', { id: 'n1', type: 'page', pageId: child.id, x: 0, y: 0, width: 200, height: 60 })
    cdoc.getMap('cnodes').set('n2', { id: 'n2', type: 'text', text: 'Due {{date:MMM D}}', x: 0, y: 100, width: 200, height: 60 })
    await db.insert(schema.pageDocs).values({ pageId: canvas.id, state: Buffer.from(Y.encodeStateAsUpdate(cdoc)) })

    const saved = await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, {
      fromPageId: root.id,
      name: 'Proj tpl',
      category: 'projects',
      includeSubpages: true,
      includeRows: true,
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const tpl = (saved.json() as { template: { id: string; kind: string; pageCount: number; inputs: { name: string }[]; category: string } }).template
    assert.equal(tpl.kind, 'structure')
    assert.equal(tpl.pageCount, 7)
    assert.equal(tpl.category, 'projects')
    assert.deepEqual(tpl.inputs.map((i) => i.name), ['First task'])

    const made = await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: tpl.id, title: 'Apollo', date: '2026-03-02', inputs: { 'First task': 'Launch' } })
    assert.equal(made.statusCode, 200, made.body)
    const out = (made.json() as { pages: { id: string; title: string; kind: string }[] }).pages
    const byTitle = new Map(out.map((p) => [p.title, p]))
    const nChild = byTitle.get('Spec')!
    const nPeople = byTitle.get('People')!
    const nWork = byTitle.get('Work')!
    const nTask = byTitle.get('Task Launch')!
    const nAlice = byTitle.get('Alice')!
    assert.equal(out[0].title, 'Apollo')
    const rootLinks = links(await docBlocks(out[0].id))
    assert.ok(rootLinks.includes(`/w/${ws.id}/p/${nChild.id}`), 'internal link remapped')
    assert.ok(rootLinks.includes(`/w/${ws.id}/p/${outside.id}`), 'outside link kept')
    assert.ok(links(await docBlocks(nChild.id)).includes(`/w/${ws.id}/p/${out[0].id}`))
    const [pc] = await db.select().from(schema.collections).where(eq(schema.collections.pageId, nPeople.id))
    const [wc] = await db.select().from(schema.collections).where(eq(schema.collections.pageId, nWork.id))
    const pf = pc.fields as { id: string; relation?: { targetPageId: string; twoWay?: boolean } }[]
    const wf = wc.fields as { id: string; relation?: { targetPageId: string; twoWay?: boolean; pairFieldId?: string } }[]
    assert.equal(pf[1].relation!.targetPageId, nWork.id)
    assert.equal(wf[0].relation!.targetPageId, nPeople.id)
    assert.equal(wf[0].relation!.twoWay, true)
    assert.equal(wf[1].relation!.targetPageId, outside.id)
    assert.equal(wf[1].relation!.twoWay, undefined, 'relation to outside becomes one-way')
    const rows = await db.select().from(schema.pages).where(inArray(schema.pages.id, [nTask.id, nAlice.id]))
    const task = rows.find((r) => r.id === nTask.id)!
    const alice = rows.find((r) => r.id === nAlice.id)!
    assert.deepEqual((task.props as Record<string, unknown>).who, [nAlice.id])
    assert.deepEqual((task.props as Record<string, unknown>).ext, [outside.id])
    assert.deepEqual((alice.props as Record<string, unknown>).work, [nTask.id])
    assert.equal((alice.props as Record<string, unknown>).role, 'Lead of Apollo')
    const [views] = await db.select().from(schema.collectionViews).where(eq(schema.collectionViews.pageId, nWork.id))
    assert.equal(views.type, 'board')
    const [cv] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, byTitle.get('Map')!.id))
    const cd = new Y.Doc()
    Y.applyUpdate(cd, cv.state)
    const nodes = cd.getMap('cnodes').toJSON() as Record<string, { pageId?: string; text?: string }>
    assert.equal(nodes.n1.pageId, nChild.id)
    assert.equal(nodes.n2.text, 'Due Mar 2')

    // includeRows=false keeps fields and views but no rows
    const noRows = await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: root.id, name: 'No rows', includeSubpages: true })
    assert.equal((noRows.json() as { template: { pageCount: number } }).template.pageCount, 5)
    // without sub-pages: a document template
    const flat = await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: root.id, name: 'Flat' })
    assert.equal((flat.json() as { template: { kind: string } }).template.kind, 'doc')

    // export → import round trip keeps the structure, inputs and internal references
    const exp = await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates/${tpl.id}/export`)
    assert.equal(exp.statusCode, 200)
    assert.equal(exp.headers['content-type'], 'application/zip')
    const zip = await JSZip.loadAsync(exp.rawPayload)
    const manifest = JSON.parse(await zip.file('inkling-template.json')!.async('string'))
    assert.equal(manifest['inkling-template'], 1)
    assert.equal(manifest.name, 'Proj tpl')
    assert.ok(!JSON.stringify(manifest).includes(work.id), 'no database ids in the manifest')
    const mp = multipart('proj.zip', exp.rawPayload)
    const imp = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/templates/import`, headers: { cookie: owner.cookie, ...mp.headers }, payload: mp.payload })
    assert.equal(imp.statusCode, 200, imp.body)
    const itpl = (imp.json() as { template: { id: string; pageCount: number; inputs: unknown[]; category: string } }).template
    assert.equal(itpl.pageCount, 7)
    assert.equal(itpl.category, 'projects')
    assert.equal(itpl.inputs.length, 1)
    const again = (await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: itpl.id, title: 'Gemini' })).json() as { pages: { id: string; title: string }[] }
    const g = new Map(again.pages.map((p) => [p.title, p.id]))
    assert.ok(links(await docBlocks(again.pages[0].id)).includes(`/w/${ws.id}/p/${g.get('Spec')}`))
    const [gw] = await db.select().from(schema.collections).where(eq(schema.collections.pageId, g.get('Work')!))
    assert.equal((gw.fields as { relation?: { targetPageId: string } }[])[0].relation!.targetPageId, g.get('People'))
    assert.equal((gw.fields as { type: string }[])[1].type, 'text', 'relation outside the template becomes text on import')
    const [gt] = await db.select().from(schema.pages).where(eq(schema.pages.id, g.get('Task Draft')!))
    assert.deepEqual((gt.props as Record<string, unknown>).who, [g.get('Alice')])
  })

  it('a failure part-way through creates nothing (one transaction)', async () => {
    const root = await page(ws.id, owner.id, { title: `Atomic ${tag()}` })
    const coll = await page(ws.id, owner.id, { title: 'Coll', parentId: root.id, kind: 'collection' })
    await setDoc(root.id, 'body')
    await db.insert(schema.collections).values({ pageId: coll.id, fields: [] })
    await db.insert(schema.collectionViews).values({ pageId: coll.id, name: 'BOOM', type: 'table', config: {} })
    const saved = (await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: root.id, name: 'Atomic', includeSubpages: true })).json() as { template: { id: string } }
    const title = `Never ${tag()}`
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION tpl_boom() RETURNS trigger AS $$ BEGIN IF NEW.name = 'BOOM' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`))
    await db.execute(sql.raw(`CREATE TRIGGER tpl_boom BEFORE INSERT ON collection_views FOR EACH ROW EXECUTE FUNCTION tpl_boom()`))
    try {
      const res = await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: saved.template.id, title })
      assert.equal(res.statusCode, 500)
    } finally {
      await db.execute(sql.raw('DROP TRIGGER tpl_boom ON collection_views'))
      await db.execute(sql.raw('DROP FUNCTION tpl_boom()'))
    }
    const left = await db.select().from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.title, title)))
    assert.equal(left.length, 0)
    const orphans = await db.select().from(schema.pages).where(and(eq(schema.pages.workspaceId, ws.id), eq(schema.pages.title, 'Coll')))
    assert.equal(orphans.length, 1, 'only the source collection exists')
  })

  it('enforces the depth and page caps', async () => {
    // a chain 62 levels deep: a 3-level template (Project) no longer fits under its bottom
    let parent: string | null = null
    for (let i = 0; i < 62; i++) parent = (await page(ws.id, owner.id, { title: `d${i}`, parentId: parent })).id
    const before = await db.$count(schema.pages, eq(schema.pages.workspaceId, ws.id))
    const res = await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, builtinKey: 'project', parentId: parent })
    assert.equal(res.statusCode, 400)
    assert.equal(await db.$count(schema.pages, eq(schema.pages.workspaceId, ws.id)), before)

    const big = await page(ws.id, owner.id, { title: 'Big' })
    await db.insert(schema.pages).values(Array.from({ length: 200 }, (_, i) => ({ workspaceId: ws.id, parentId: big.id, title: `c${i}`, createdBy: owner.id })))
    const tooBig = await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: big.id, name: 'Big', includeSubpages: true })
    assert.equal(tooBig.statusCode, 400)
    assert.equal((tooBig.json() as { error: { code: string } }).error.code, 'TEMPLATE_TOO_LARGE')
  })

  it('private templates are visible to their creator only', async () => {
    const priv = await page(ws.id, member.id, { title: 'My private', scope: 'private' })
    await setDoc(priv.id, 'secret {{title}}')
    const t1 = (await req(member.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: priv.id, name: 'Secret' })).json() as { template: { id: string; scope: string; mine: boolean } }
    assert.equal(t1.template.scope, 'private')
    assert.equal(t1.template.mine, true)
    const shared = await page(ws.id, member.id, { title: 'Shared page' })
    const t2 = (await req(member.cookie, 'POST', `/api/workspaces/${ws.id}/templates`, { fromPageId: shared.id, name: 'Only me', private: true })).json() as { template: { id: string; scope: string } }
    assert.equal(t2.template.scope, 'private')

    const ownerList = (await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates`)).json() as { templates: { id: string }[] }
    assert.ok(!ownerList.templates.some((t) => t.id === t1.template.id || t.id === t2.template.id))
    for (const tid of [t1.template.id, t2.template.id]) {
      assert.equal((await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates/${tid}/preview`)).statusCode, 404)
      assert.equal((await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates/${tid}/export`)).statusCode, 404)
      assert.equal((await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: tid })).statusCode, 404)
      assert.equal((await req(owner.cookie, 'DELETE', `/api/templates/${tid}`)).statusCode, 404)
    }
    const mine = (await req(member.cookie, 'GET', `/api/workspaces/${ws.id}/templates`)).json() as { templates: { id: string }[] }
    assert.ok(mine.templates.some((t) => t.id === t1.template.id))
    const used = (await req(member.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: t1.template.id, scope: 'private' })).json() as { page: { scope: string; title: string } }
    assert.equal(used.page.scope, 'private')
    // a template from another workspace is not found here
    const other = await workspace(member)
    assert.equal((await req(member.cookie, 'POST', '/api/pages/from-template', { workspaceId: other.id, templateId: t1.template.id })).statusCode, 404)
  })

  it('keeps legacy rows (block arrays) working', async () => {
    const blocks = await markdownToBlocks('Hello {{title}} — {{input:Topic|General}} **{{author}}**', () => null)
    const [row] = await db
      .insert(schema.templates)
      .values({ workspaceId: ws.id, name: 'Old', content: blocks, defaultProps: { withDate: true }, createdBy: owner.id })
      .returning()
    const list = (await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates`)).json() as { templates: { id: string; kind: string; inputs: { name: string; default: string }[]; withDate: boolean; category: string }[] }
    const t = list.templates.find((x) => x.id === row.id)!
    assert.equal(t.kind, 'doc')
    assert.equal(t.withDate, true)
    assert.equal(t.category, 'custom')
    assert.deepEqual(t.inputs, [{ name: 'Topic', default: 'General' }])
    const made = (await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: row.id, date: '2026-01-02' })).json() as { page: { id: string; title: string } }
    assert.equal(made.page.title, 'Old')
    const b = await docBlocks(made.page.id)
    assert.match(JSON.stringify(b), /Hello Old — General/)
    assert.ok(JSON.stringify(b).includes('"bold":true'))
    const [p] = await db.select().from(schema.pages).where(eq(schema.pages.id, made.page.id))
    assert.deepEqual((p.properties as { value: string }[])[0].value, '2026-01-02')

    // .md export carries the meta in flat frontmatter and imports back
    const exp = await req(owner.cookie, 'GET', `/api/workspaces/${ws.id}/templates/${row.id}/export`)
    const md = exp.body
    assert.match(md, /^---\ninkling-template: 1\nname: "Old"\ncategory: custom\nwith-date: true\nvariables:\n {2}- "Topic\|General"\n---\n/)
    assert.match(md, /Hello \{\{title\}\}/)
    const mp = multipart('old.md', Buffer.from(md))
    const imp = (await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/templates/import?private=1`, headers: { cookie: owner.cookie, ...mp.headers }, payload: mp.payload })).json() as { template: { name: string; withDate: boolean; scope: string; inputs: unknown[] } }
    assert.equal(imp.template.name, 'Old')
    assert.equal(imp.template.withDate, true)
    assert.equal(imp.template.scope, 'private')
    assert.equal(imp.template.inputs.length, 1)
  })

  it('imports an Obsidian Templater file; code tags stay text', async () => {
    const md = '# Daily\n\nCreated <% tp.date.now("YYYY-MM-DD") %> for <% tp.file.title %>\n\n<% tp.file.cursor() %>\n\n<%* tR += "x" %>\n'
    const mp = multipart('Daily log.md', Buffer.from(md))
    const imp = (await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/templates/import`, headers: { cookie: owner.cookie, ...mp.headers }, payload: mp.payload })).json() as { template: { id: string; name: string } }
    assert.equal(imp.template.name, 'Daily log')
    const made = (await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: ws.id, templateId: imp.template.id, title: 'Log', date: '2026-05-05' })).json() as { page: { id: string }; cursor?: { pageId: string } }
    const text = JSON.stringify(await docBlocks(made.page.id))
    assert.match(text, /Created 2026-05-05 for Log/)
    assert.match(text, /<%\* tR \+= \\"x\\" %>/)
    assert.equal(made.cursor?.pageId, made.page.id)
    // a broken archive is refused cleanly
    const bad = multipart('x.zip', Buffer.from('PK not a zip'))
    const r = await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/templates/import`, headers: { cookie: owner.cookie, ...bad.headers }, payload: bad.payload })
    assert.equal(r.statusCode, 400)
  })

  it('MCP: list_templates and create_from_template act as the token user', async () => {
    const token = `tok_${randomBytes(16).toString('hex')}`
    const clientId = `c_${tag()}`
    await db.insert(schema.oauthClients).values({ id: clientId, name: 'test', redirectUris: ['http://localhost/cb'] })
    await db.insert(schema.oauthGrants).values({
      clientId,
      userId: member.id,
      accessHash: createHash('sha256').update(token).digest('hex'),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshHash: randomBytes(16).toString('hex'),
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
    })
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      })
      assert.equal(res.statusCode, 200, res.body)
      const out = res.json() as { result: { isError?: boolean; content: { text: string }[] } }
      return { isError: out.result.isError === true, text: out.result.content[0].text }
    }
    const listed = await rpc('list_templates', { workspaceId: ws.id })
    const items = JSON.parse(listed.text) as { id: string; kind: string; inputs: unknown[] }[]
    assert.ok(items.some((t) => t.id === 'meetingSeries' && t.kind === 'structure'))
    const created = await rpc('create_from_template', {
      workspaceId: ws.id,
      template: 'meetingSeries',
      title: 'Design sync',
      private: true,
      inputs: { 'When does this meeting happen?': 'Thursdays 15:00' },
    })
    assert.equal(created.isError, false, created.text)
    const c = JSON.parse(created.text) as { id: string; section: string; created: number; url: string }
    assert.equal(c.section, 'private')
    assert.equal(c.created, 3)
    assert.match(JSON.stringify(await docBlocks(c.id)), /Thursdays 15:00/)
    const denied = await rpc('list_templates', { workspaceId: (await workspace(owner)).id })
    assert.equal(denied.isError, true)
  })

  it('a deleted workspace answers 404 on every template route', async () => {
    const gone = await workspace(owner)
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, gone.id))
    assert.equal((await req(owner.cookie, 'GET', `/api/workspaces/${gone.id}/templates`)).statusCode, 404)
    assert.equal((await req(owner.cookie, 'GET', `/api/workspaces/${gone.id}/templates/project/preview`)).statusCode, 404)
    assert.equal((await req(owner.cookie, 'POST', '/api/pages/from-template', { workspaceId: gone.id, builtinKey: 'meeting' })).statusCode, 404)
  })
})
