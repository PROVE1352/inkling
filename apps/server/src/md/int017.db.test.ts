// 0.17 cross-stream checks (integration, wave 16): the 0.17 collection features (automatic values,
// OR / NOT filters, sub-items, guests; docs/adr/2140-2146) as inline database views outside the app
// (public pages, the Markdown download, chart aggregates; docs/adr/2120-2122), and Mermaid fences
// and section links (docs/adr/2100, 2104) on public folder links, in embedded pages and through the
// file export round trip next to X2's snapshot markers (docs/adr/2122-*, 2190-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] 0.17 integration: database views, Mermaid and section links outside the app', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { aggregateCollection } = await import('../charts/aggregate')
  const { stateToBlocks } = await import('./convert')

  const Fastify = (await import('fastify')).default
  const app: FastifyInstance = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: String(err.issues[0]?.message) } })
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String((err as Error).message) } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/pageContent')).registerPageContentRoutes(api)
      await (await import('../routes/pageAccess')).registerPageAccessRoutes(api)
      await (await import('../routes/collections')).registerCollectionRoutes(api)
      await (await import('../routes/exportImport')).registerExportImportRoutes(api)
      await (await import('../routes/public')).registerPublicRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: string, url: string, payload?: unknown) => {
    const res = await as(u, method, url, payload)
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }
  const visit = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '10.9.9.8' })
  const share = async (u: U, pageId: string) => (await ok(u, 'POST', `/pages/${pageId}/share`)).token as string
  const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }], children: [] })
  const heading = (t: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }], children: [] })
  const embed = (pageId: string, viewId = '') => ({ type: 'pageEmbed', props: { pageId, viewId }, children: [] })
  const code = (language: string, text: string) => ({ type: 'codeBlock', props: { language }, content: [{ type: 'text', text, styles: {} }], children: [] })
  const stripFront = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n\n/, '')
  const W = randomBytes(3).toString('hex')

  const alice = await h.makeUser(`Alice${W}`)
  const bob = await h.makeUser(`Bob${W}`)
  const gwen = await h.makeUser(`Gwen${W}`)
  const ws = await h.makeWorkspace(alice, [bob])

  const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Pub ${W}`, kind: 'folder', createdBy: alice.id }).returning()
  const newCollection = async (title: string, parentId: string | null) =>
    (await ok(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title, ...(parentId ? { parentId } : {}) })).page.id as string

  // ── a 0.17 collection inside the public folder ────────────────────────────
  const tasks = await newCollection(`Tasks ${W}`, folder.id)
  await ok(alice, 'PUT', `/pages/${tasks}/collection/fields`, {
    fields: [
      { id: 'st', name: 'Status', type: 'select', options: [
        { id: 'todo', name: 'Todo', color: 'gray' },
        { id: 'doing', name: 'Doing', color: 'blue' },
        { id: 'done', name: 'Done', color: 'green' },
      ] },
      { id: 'pts', name: 'Points', type: 'number' },
      { id: 'tid', name: 'Key', type: 'uniqueId', uniqueId: { prefix: 'T' } },
      { id: 'cb', name: 'Author', type: 'createdBy' },
      { id: 'eb', name: 'Editor', type: 'editedBy' },
      { id: 'ct', name: 'Created', type: 'createdTime' },
      { id: 'par', name: 'Parent item', type: 'relation', relation: { targetPageId: tasks, subItems: true } },
    ],
  })
  const newRow = async (title: string, props: Record<string, unknown>) =>
    (await ok(alice, 'POST', `/pages/${tasks}/collection/rows`, { title, props, template: null })).row.id as string
  const alpha = await newRow('Alpha', { st: 'doing', pts: 5 })
  const beta = await newRow('Beta', { st: 'todo', pts: 1 })
  const gamma = await newRow('Gamma', { st: 'todo', pts: 8 })
  await newRow('Delta', { st: 'done', pts: 2, par: [alpha] })
  await newRow('Epsilon', { st: 'doing', pts: 9, par: [gamma] })
  // an agent's edit of Beta: last edited by bob, through a connection
  await db.update(schema.pages).set({ editedBy: bob.id, editedVia: 'Claude' }).where(eq(schema.pages.id, beta))

  // status = Doing OR NOT (points > 2), by ID descending (creation order would be the reverse): Epsilon
  // (T5, its parent Gamma is filtered out: top level), Beta (T2), Alpha (T1) with Delta (T4) under it
  const filter = { mode: 'or', items: [{ fieldId: 'st', op: 'eq', value: 'doing' }, { mode: 'and', not: true, items: [{ fieldId: 'pts', op: 'gt', value: 2 }] }] }
  const mixedConfig = { filter, sorts: [{ fieldId: 'tid', dir: 'desc' }], hiddenFields: ['ct', 'par'] }
  const mixed = (await ok(alice, 'POST', `/pages/${tasks}/collection/views`, { name: 'Mixed', type: 'table', config: mixedConfig })) as { view?: { id: string }; id?: string }
  const mixedId = (mixed.view?.id ?? mixed.id) as string
  const flat = (await ok(alice, 'POST', `/pages/${tasks}/collection/views`, { name: 'Flat list', type: 'list', config: { ...mixedConfig, subItems: 'flat' } })) as { view?: { id: string }; id?: string }
  const flatId = (flat.view?.id ?? flat.id) as string
  const EXPECTED = ['Epsilon', 'Beta', 'Alpha', '↳ Delta']

  // ── pages for Mermaid and section links ───────────────────────────────────
  const MERMAID = 'graph TD\n  A[[Start]] --> B{Ready?}\n<!-- inkling:snapshot -->\n  B -->|yes| C[Ship]'
  const target = await h.makeDocPage(ws.id, alice.id, `Guide ${W}`, [heading('Setup'), para('setup body')] as never, { parentId: folder.id })
  const outside = await h.makeDocPage(ws.id, alice.id, `Outside ${W}`, [heading('Secret part'), para('outside body')] as never)
  const sectionLink = (pageId: string, title: string, head: string) => ({
    type: 'link',
    href: `/w/${ws.id}/p/${pageId}#h=${encodeURIComponent(head)}&p=${encodeURIComponent(title)}`,
    content: [{ type: 'text', text: `${title}#${head}`, styles: {} }],
  })
  const linkPara = (...links: ReturnType<typeof sectionLink>[]) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: 'See ', styles: {} }, ...links.flatMap((l, i) => (i ? [{ type: 'text', text: ' ', styles: {} }, l] : [l]))],
    children: [],
  })
  const embedded = await h.makeDocPage(
    ws.id,
    alice.id,
    `Embedded ${W}`,
    [para('embedded body'), code('mermaid', 'graph LR\n  E1 --> E2'), linkPara(sectionLink(target.id, `Guide ${W}`, 'Setup'))] as never,
    { parentId: folder.id },
  )
  const hostBlocks = [
    para('host text'),
    embed(tasks, mixedId),
    code('mermaid', MERMAID),
    embed(tasks, flatId),
    linkPara(sectionLink(target.id, `Guide ${W}`, 'Setup'), sectionLink(outside.id, `Outside ${W}`, 'Secret part')),
    embed(embedded.id),
    code('mmd', 'sequenceDiagram\n  A->>B: hi'),
  ]
  const host = await h.makeDocPage(ws.id, alice.id, `Host ${W}`, hostBlocks as never, { parentId: folder.id })

  const tableRows = (md: string, from: string) => {
    const start = md.indexOf(from)
    assert.ok(start >= 0, `no "${from}" in\n${md}`)
    const lines = md.slice(start).split('\n')
    const out: string[][] = []
    let inTable = false
    for (const line of lines) {
      if (line.startsWith('|')) {
        inTable = true
        out.push(line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()))
      } else if (inTable) break
    }
    return out.slice(2) // header and separator
  }

  const folderToken = await share(alice, folder.id)
  const publicHtml = async (title: string) => {
    const tree = (await visit(`/api/public/${folderToken}`)).json() as { tree: { ref: string; title: string }[] }
    const node = tree.tree.find((n) => n.title === title)
    assert.ok(node, `${title} in ${JSON.stringify(tree.tree.map((n) => n.title))}`)
    const page = await visit(`/api/public/${folderToken}/p/${node!.ref}`)
    assert.equal(page.statusCode, 200, page.body)
    return { html: page.json().html as string, refs: tree.tree }
  }
  const htmlRows = (html: string, nth: number) => {
    const table = [...html.matchAll(/<table[\s\S]*?<\/table>/g)][nth]?.[0]
    assert.ok(table, `table ${nth} in\n${html}`)
    return [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].slice(1).map((m) => [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim()))
  }

  it('export and public page: OR / NOT filter, ID order and sub-items give the same rows; automatic values are filled', async () => {
    const res = await as(alice, 'GET', `/pages/${host.id}/export?format=md&notation=file`)
    assert.equal(res.statusCode, 200, res.body)
    const md = res.body
    const exp = tableRows(md, `**Tasks ${W} · Mixed**`)
    assert.deepEqual(exp.map((r) => r[0]), EXPECTED)
    // columns: Title, Status, Points, Key, Author, Editor (Created and Parent item hidden)
    const beta = exp.find((r) => r[0] === 'Beta')!
    assert.deepEqual(beta.slice(1), ['Todo', '1', 'T-2', `Alice${W}`, `Bob${W} (via Claude)`])
    assert.equal(exp.find((r) => r[0] === 'Alpha')![3], 'T-1')
    assert.equal(exp.find((r) => r[0] === 'Alpha')![5], `Alice${W}`)
    // a list view set to flat: same rows, no tree
    assert.deepEqual(tableRows(md, `**Tasks ${W} · Flat list**`).map((r) => r[0]), ['Epsilon', 'Delta', 'Beta', 'Alpha'])

    const { html } = await publicHtml(`Host ${W}`)
    const pub = htmlRows(html, 0)
    assert.deepEqual(pub.map((r) => r[0]), EXPECTED)
    const pubBeta = pub.find((r) => r[0] === 'Beta')!
    // public: member names as the person rule (C-L11), no connection name (docs/adr/2190-*)
    assert.deepEqual(pubBeta.slice(1), ['Todo', '1', 'T-2', `Alice${W}`, `Bob${W}`])
    assert.doesNotMatch(html, /via Claude/)
    assert.deepEqual(htmlRows(html, 1).map((r) => r[0]), ['Epsilon', 'Delta', 'Beta', 'Alpha'])
  })

  it('the whole database exported or shared on its own shows the automatic values too', async () => {
    const md = (await as(alice, 'GET', `/pages/${tasks}/export?format=md`)).body
    const rows = tableRows(md, '| Title')
    const alphaRow = rows.find((r) => r[0] === 'Alpha')!
    assert.ok(alphaRow.includes('T-1'), JSON.stringify(alphaRow))
    assert.ok(alphaRow.includes(`Alice${W}`))
    assert.ok(alphaRow.some((c) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c)), 'created time as ISO UTC')
    const { html } = await publicHtml(`Tasks ${W}`)
    assert.match(html, /T-5/)
    assert.doesNotMatch(html, /via Claude/)
  })

  it('a chart over the same view counts the same rows, for a member and for a public reader', async () => {
    const target = { collectionId: tasks, workspaceId: ws.id, title: `Tasks ${W}`, view: { name: 'Mixed', config: mixedConfig as never } }
    const input = { groupBy: { field: 'st' } } as never
    const member = await aggregateCollection(target, input, { kind: 'user', userId: alice.id })
    const anon = await aggregateCollection(target, input, { kind: 'public' })
    assert.equal(member.rowCount, EXPECTED.length)
    assert.equal(anon.rowCount, EXPECTED.length)
    // grouped by the author (createdBy): a member name, never an id
    const byAuthor = await aggregateCollection(target, { groupBy: { field: 'cb' } } as never, { kind: 'public' })
    assert.deepEqual(byAuthor.groups.map((g) => g.label), [`Alice${W}`])
  })

  it('query rows: automatic values are the same whether the filter or sort reads them (SQL) or not (filled in JS)', async () => {
    const q = async (params: string) => {
      const r = await as(alice, 'GET', `/pages/${tasks}/collection/query?fields=Key,Author,Editor,Created&${params}`)
      assert.equal(r.statusCode, 200, r.body)
      return r.json() as { columns: string[]; rows: { id: string; version: string; cells: string[] }[] }
    }
    const plain = await q('limit=50')
    const viaSql = await q(`limit=50&filter=${encodeURIComponent('Key >= 1 AND Created > 2000-01-01')}&sort=${encodeURIComponent('Key desc')}`)
    assert.equal(plain.rows.length, 5)
    assert.deepEqual(viaSql.rows.map((r) => r.cells[1]), ['T-5', 'T-4', 'T-3', 'T-2', 'T-1'])
    const byId = new Map(plain.rows.map((r) => [r.id, r]))
    for (const r of viaSql.rows) {
      assert.deepEqual(r.cells, byId.get(r.id)!.cells)
      assert.equal(r.version, byId.get(r.id)!.version, 'the row version is the stored props either way')
    }
    assert.ok(plain.rows.some((r) => r.cells.includes(`Bob${W} (via Claude)`)), JSON.stringify(plain.rows))
    assert.ok(plain.rows.every((r) => /^\d{4}-\d\d-\d\d/.test(r.cells[4])), JSON.stringify(plain.rows))
  })

  it('a page guest sees a database view block of a shared database, not one outside the share', async () => {
    const hub = await h.makeDocPage(ws.id, alice.id, `Hub ${W}`, [para('hub')] as never)
    const inHub = await newCollection(`Hub DB ${W}`, hub.id)
    await ok(alice, 'PUT', `/pages/${inHub}/collection/fields`, { fields: [{ id: 'own', name: 'Owner', type: 'person' }, { id: 'cb', name: 'Author', type: 'createdBy' }] })
    await ok(alice, 'POST', `/pages/${inHub}/collection/rows`, { title: 'hub row', props: { own: bob.id }, template: null })
    const hubView = (await ok(alice, 'GET', `/pages/${inHub}/collection`)).collection.views[0].id as string
    const elsewhere = await newCollection(`Elsewhere DB ${W}`, null)
    await ok(alice, 'POST', `/pages/${elsewhere}/collection/rows`, { title: `elsewhere row ${W}`, props: {}, template: null })
    // the hub page shows both databases as views
    await db.update(schema.pageDocs).set({ state: (await import('./convert')).blocksToStateBuffer([para('hub'), embed(inHub, hubView), embed(elsewhere)] as never) }).where(eq(schema.pageDocs.pageId, hub.id))
    await ok(alice, 'PUT', `/pages/${hub.id}/access`, { userId: gwen.id, level: 'view' })

    // the page list the block looks its target up in: the shared database, not the other one
    const list = (await ok(gwen, 'GET', `/workspaces/${ws.id}/pages`)).pages as { id: string }[]
    assert.ok(list.some((p) => p.id === inHub))
    assert.ok(!list.some((p) => p.id === elsewhere))
    // the block's rows: the shared database answers with its rows and the people's names
    const bundle = await ok(gwen, 'GET', `/pages/${inHub}/collection`)
    assert.deepEqual(bundle.rows.map((r: { title: string }) => r.title), ['hub row'])
    assert.equal(bundle.people?.[bob.id], `Bob${W}`)
    assert.equal(bundle.people?.[alice.id], `Alice${W}`)
    // outside the share: the same 404 as an unknown id ("Database not available")
    const out = await as(gwen, 'GET', `/pages/${elsewhere}/collection`)
    assert.equal(out.statusCode, 404)
    assert.doesNotMatch(out.body, new RegExp(`Elsewhere DB ${W}|elsewhere row`))
    // nor through the collection's other reads
    for (const url of [`/pages/${elsewhere}/collection/row-options`, `/pages/${elsewhere}/collection/query`]) {
      const r = await as(gwen, 'GET', url)
      assert.ok(r.statusCode === 403 || r.statusCode === 404, `${url}: ${r.statusCode}`)
      assert.doesNotMatch(r.body, new RegExp(`Elsewhere DB ${W}|elsewhere row`))
    }
  })

  it('public folder link: Mermaid fences stay code (host and embedded page), section links follow the share', async () => {
    const { html, refs } = await publicHtml(`Host ${W}`)
    // BlockNote's code block HTML: the language is on the block (`data-language`), the code in <pre><code>
    const codes = [...html.matchAll(/data-content-type="codeBlock" data-language="(mermaid|mmd)"><pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)]
    assert.deepEqual(codes.map((m) => m[1]), ['mermaid', 'mermaid', 'mmd'], html)
    // the source as text, HTML-escaped (the snapshot-marker line inside the fence too)
    assert.match(codes[0][2], /A\[\[Start\]\] --&gt; B\{Ready\?\}/)
    assert.match(codes[0][2], /&lt;!-- inkling:snapshot --&gt;/)
    assert.match(codes[1][2], /E1 --&gt; E2/)
    // the section link to a page inside the share goes to its public page; one outside is text
    const guideRef = refs.find((n) => n.title === `Guide ${W}`)!.ref
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])
    const toGuide = links.filter(([, text]) => text === `Guide ${W}#Setup`)
    assert.equal(toGuide.length, 2, JSON.stringify(links)) // host and embedded page
    for (const [href] of toGuide) assert.equal(href, `/s/${folderToken}/p/${guideRef}`)
    assert.ok(!links.some(([href]) => href.includes(outside.id) || href.includes('/w/')))
    assert.match(html, new RegExp(`Outside ${W}#Secret part`))
    assert.doesNotMatch(html, /outside body|#h=/)
  })

  it('file export round trip: Mermaid fences byte for byte next to snapshots, section links kept', async () => {
    const first = (await as(alice, 'GET', `/pages/${host.id}/export?format=md&notation=file`)).body
    assert.ok(first.includes('```mermaid\n' + MERMAID + '\n```'), first)
    assert.ok(first.includes('```mmd\nsequenceDiagram\n  A->>B: hi\n```'))
    assert.match(first, new RegExp(`\\[\\[Guide ${W}#Setup\\]\\]`))
    assert.match(first, new RegExp(`\\[\\[Outside ${W}#Secret part\\]\\]`))
    // the views' snapshots are closed before the fence that follows them
    const i = first.indexOf('```mermaid')
    assert.ok(first.lastIndexOf('<!-- /inkling:snapshot -->', i) > first.lastIndexOf('<!-- inkling:snapshot -->\n\n**', i))

    const boundary = `----x${randomBytes(6).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Host copy.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from(first),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const imp = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/import`,
      headers: { cookie: alice.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(imp.statusCode, 200, imp.body)
    const copyId = (imp.json() as { pages: { id: string }[] }).pages[0].id
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, copyId))
    const blocks = stateToBlocks(d.state)
    const fences = blocks.filter((b) => b.type === 'codeBlock')
    assert.deepEqual(
      fences.map((b) => [b.props?.language, (b.content as { text: string }[]).map((c) => c.text).join('')]),
      [['mermaid', MERMAID], ['mmd', 'sequenceDiagram\n  A->>B: hi']],
    )
    // database views come back as blocks; the embedded page was written as a link (docs/adr/2122-*)
    assert.deepEqual(blocks.filter((b) => b.type === 'pageEmbed').map((b) => b.props), [{ pageId: tasks, viewId: mixedId }, { pageId: tasks, viewId: flatId }])
    assert.equal(blocks.filter((b) => b.type === 'table').length, 0)
    const hrefs = JSON.stringify(blocks).match(/\/w\/[^"]+#h=[^"]+/g) ?? []
    assert.ok(hrefs.some((x) => x.includes(target.id) && x.includes('h=Setup')), JSON.stringify(hrefs))
    const second = (await as(alice, 'GET', `/pages/${copyId}/export?format=md&notation=file`)).body
    assert.equal(stripFront(second), stripFront(first))
  })
})
