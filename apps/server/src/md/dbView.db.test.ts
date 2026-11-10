// Inline database views (page embeds of a collection with a view, docs/adr/2120-*), the blocks with
// data from elsewhere on public pages (2121) and in the Markdown download (2122), and how agents read
// them (2123). Public assertions are on the final HTML: nothing from outside what the link shares.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

describe('[db] inline database views, public pages and the file export', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { AppError } = await import('../errors')
  const JSZip = (await import('jszip')).default
  const app = await h.buildTestApp()

  // public routes on their own app (no session), as charts.db.test.ts does
  const Fastify = (await import('fastify')).default
  const pub = Fastify()
  await pub.register(import('@fastify/cookie'))
  pub.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await pub.register(
    async (api) => {
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/public')).registerPublicRoutes(api)
    },
    { prefix: '/api' },
  )
  await pub.ready()
  after(async () => {
    await collab.destroyCollab()
    await pub.close()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })
  const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }], children: [] })
  const heading = (t: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }], children: [] })
  const embed = (pageId: string, viewId = '') => ({ type: 'pageEmbed', props: { pageId, viewId }, children: [] })
  const query = (q: string) => ({ type: 'codeBlock', props: { language: 'dataview' }, content: [{ type: 'text', text: q, styles: {} }], children: [] })
  const stripFront = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n\n/, '')

  const mkCollection = async (u: U, title: string, extra: Record<string, unknown> = {}) => {
    const res = await as(u, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title, ...extra })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().page.id as string
  }
  const rows = async (collectionId: string, by: string, list: { title: string; props: Record<string, unknown> }[], scope: 'shared' | 'private' = 'shared') =>
    db
      .insert(schema.pages)
      .values(list.map((r, i) => ({ workspaceId: ws.id, parentId: collectionId, title: r.title, createdBy: by, kind: 'doc' as const, props: r.props, sortOrder: i, scope })))
      .returning({ id: schema.pages.id, title: schema.pages.title })
  const mkView = async (collectionId: string, body: unknown) => {
    const res = await as(alice, 'POST', `/pages/${collectionId}/collection/views`, body)
    assert.equal(res.statusCode, 200, res.body)
    const j = res.json() as { view?: { id: string }; id?: string }
    return (j.view?.id ?? j.id) as string
  }

  // Roadmap: a shared collection with a filtered, sorted view that hides a column
  const roadmap = await mkCollection(alice, 'Roadmap')
  assert.equal(
    (
      await as(alice, 'PUT', `/pages/${roadmap}/collection/fields`, {
        fields: [
          { id: 'st', name: 'Status', type: 'select', options: [
            { id: 'todo', name: 'Todo', color: 'gray' },
            { id: 'doing', name: 'Doing', color: 'blue' },
            { id: 'done', name: 'Done', color: 'green' },
          ] },
          { id: 'pt', name: 'Points', type: 'number' },
          { id: 'nt', name: 'Note', type: 'text' },
        ],
      })
    ).statusCode,
    200,
  )
  const roadRows = await rows(roadmap, alice.id, [
    { title: 'Login', props: { st: 'done', pt: 3, nt: 'internal note' } },
    { title: 'Search', props: { st: 'doing', pt: 5 } },
    { title: 'Charts', props: { st: 'todo', pt: 8 } },
    { title: 'Export', props: { st: 'done', pt: 1 } },
  ])
  const openView = await mkView(roadmap, {
    name: 'Open',
    type: 'table',
    config: { filters: [{ fieldId: 'st', op: 'ne', value: 'done' }], sorts: [{ fieldId: 'pt', dir: 'desc' }], hiddenFields: ['nt'] },
  })

  // alice's private collection: bob never sees its name or rows
  const secret = await mkCollection(alice, 'Secret plans', { scope: 'private' })
  await rows(secret, alice.id, [{ title: 'Hidden acquisition', props: {} }], 'private')
  const secretView = await mkView(secret, { name: 'All secret', type: 'table' })

  const spec = await h.makeDocPage(ws.id, bob.id, 'Spec', [para('spec body')] as never)
  const reportBlocks = [
    para('Report intro'),
    embed(roadmap, openView),
    embed(secret, secretView),
    embed(spec.id),
    { type: 'linkEmbed', props: { url: 'https://example.com/x', display: 'card' }, children: [] },
    query('TABLE Points FROM "Roadmap" SORT Points DESC'),
    para('Report end'),
  ]
  const report = await h.makeDocPage(ws.id, bob.id, 'Report', reportBlocks as never)

  it('file export: database view token + its view as a table, query results after the query, embeds as links', async () => {
    const res = await as(bob, 'GET', `/pages/${report.id}/export?format=md&notation=file`)
    assert.equal(res.statusCode, 200, res.body)
    const md = res.body
    assert.match(md, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${roadmap}","viewId":"${openView}"\\} -->\\n\\n<!-- inkling:snapshot -->\\n\\n\\*\\*Roadmap · Open\\*\\*`))
    // the view: not done, Points descending, Note hidden
    const view = md.slice(md.indexOf('**Roadmap · Open**'), md.indexOf('<!-- /inkling:snapshot -->'))
    assert.match(view, /\| Title\s*\| Status\s*\| Points\s*\|/)
    assert.ok(view.indexOf('Charts') < view.indexOf('Search'))
    assert.doesNotMatch(view, /Login|Export|Note|internal note/)
    // bob cannot see the secret collection: no name, no row, no snapshot (the embed is left out)
    assert.doesNotMatch(md, /Secret plans|Hidden acquisition|All secret/)
    assert.ok(!md.includes(secret))
    // a page embed is a link; a link embed is a link
    assert.match(md, /\[\[Spec\]\]/)
    assert.match(md, /https:\/\/example\.com\/x/)
    // the query block stays a fence, its results follow as a snapshot
    assert.match(md, /```dataview\nTABLE Points FROM "Roadmap" SORT Points DESC\n```\n\n<!-- inkling:snapshot -->/)
    const q = md.slice(md.lastIndexOf('<!-- inkling:snapshot -->'))
    assert.ok(q.indexOf('Charts') < q.indexOf('Search') && q.indexOf('Search') < q.indexOf('Login'), q)
    // the default md export (link previews) is unchanged: no tokens
    const plain = await as(bob, 'GET', `/pages/${report.id}/export?format=md`)
    assert.doesNotMatch(plain.body, /inkling:/)
  })

  it('file export round trip: import restores the blocks and a second export is the same file', async () => {
    const first = (await as(bob, 'GET', `/pages/${report.id}/export?format=md&notation=file`)).body
    const boundary = `----x${randomBytes(6).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Report copy.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from(first),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const imp = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/import`,
      headers: { cookie: bob.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(imp.statusCode, 200, imp.body)
    const copyId = (imp.json() as { pages: { id: string; title: string }[] }).pages[0].id
    const { stateToBlocks } = await import('./convert')
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, copyId))
    const blocks = stateToBlocks(d.state)
    const view = blocks.find((b) => b.type === 'pageEmbed')
    assert.deepEqual(view?.props, { pageId: roadmap, viewId: openView })
    assert.equal(blocks.filter((b) => b.type === 'table').length, 0, 'snapshots are not imported as tables')
    assert.equal(blocks.filter((b) => b.type === 'codeBlock' && b.props?.language === 'dataview').length, 1)
    const second = (await as(bob, 'GET', `/pages/${copyId}/export?format=md&notation=file`)).body
    assert.equal(stripFront(second), stripFront(first))
  })

  it('zip export writes the file form by default; notation=plain gives the 0.16 output', async () => {
    const read = async (q: string) => {
      const res = await as(bob, 'GET', `/pages/${report.id}/export?format=zip${q}`)
      assert.equal(res.statusCode, 200, res.body.slice(0, 200))
      const zip = await JSZip.loadAsync(res.rawPayload)
      return zip.file('Report.md')!.async('string')
    }
    const file = await read('')
    assert.match(file, /<!-- inkling:pageEmbed \{"pageId":"[^"]+","viewId":"[^"]+"\} -->/)
    assert.match(file, /inkling:snapshot/)
    const plain = await read('&notation=plain')
    assert.doesNotMatch(plain, /inkling:/)
  })

  // ── public pages ────────────────────────────────────────────────────────
  const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Published', kind: 'folder', createdBy: alice.id }).returning()
  const insideDb = await mkCollection(alice, 'Inside DB', { parentId: folder.id })
  assert.equal(
    (
      await as(alice, 'PUT', `/pages/${insideDb}/collection/fields`, {
        fields: [
          { id: 'k', name: 'Kind', type: 'select', options: [
            { id: 'x', name: 'Xeno', color: 'red' },
            { id: 'y', name: 'Yeti', color: 'blue' },
          ] },
          { id: 'rl', name: 'Links', type: 'relation', relation: { targetPageId: roadmap } },
        ],
      })
    ).statusCode,
    200,
  )
  await rows(insideDb, alice.id, [
    { title: 'Alpha row', props: { k: 'x', rl: [roadRows[0].id] } },
    { title: 'Beta row', props: { k: 'y' } },
  ])
  await rows(insideDb, alice.id, [{ title: 'Gamma private row', props: { k: 'x' } }], 'private')
  const onlyX = await mkView(insideDb, { name: 'Only X', type: 'table', config: { filters: [{ fieldId: 'k', op: 'eq', value: 'x' }] } })
  const embedded = await h.makeDocPage(ws.id, alice.id, 'Embedded doc', [para('embedded body')] as never, { parentId: folder.id })
  const privNote = await h.makeDocPage(ws.id, alice.id, 'Private note', [para('private body')] as never, { parentId: folder.id, scope: 'private' })
  const outside = await h.makeDocPage(ws.id, alice.id, 'Outside doc', [para('outside body')] as never)
  const host = await h.makeDocPage(
    ws.id,
    alice.id,
    'Public report',
    [
      para('host text'),
      embed(insideDb, onlyX),
      embed(roadmap, openView),
      embed(embedded.id),
      embed(outside.id),
      embed(privNote.id),
      embed(secret, secretView),
      { type: 'linkEmbed', props: { url: 'https://example.com/card', display: 'card' }, children: [] },
      query('LIST'),
      query('TABLE Links, file.folder FROM "Published"'),
      para('host end'),
    ] as never,
    { parentId: folder.id },
  )

  const visit = (url: string) => pub.inject({ method: 'GET', url, remoteAddress: '10.9.9.9' })
  const share = async (pageId: string, body?: unknown) => {
    const res = await pub.inject({ method: 'POST', url: `/api/pages/${pageId}/share`, headers: { cookie: alice.cookie }, payload: body as object })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().token as string
  }
  const OUTSIDE = /Login|Search|Charts|Roadmap|outside body|Outside doc|Private note|private body|Gamma private row|Secret plans|Hidden acquisition|All secret|Spec|Report intro|Open\b/
  const INTERNALS = /inkling|pageId|viewId|dataview|LIST|TABLE Links|FROM "Published"/
  /**
   * UUIDs in the HTML other than a public file URL's and the editor's block ids (`data-id`, random
   * per block, on every public page since M15): any page, collection or view id would be a leak.
   */
  const pageIds = new Set<string>()
  const strayIds = (html: string) =>
    [...html.matchAll(UUID_G)]
      .filter((m) => !/(\/f\/|data-id=")$/.test(html.slice(Math.max(0, m.index! - 9), m.index)))
      .map((m) => m[0])
      .concat([...pageIds].filter((id) => html.includes(id)))
  for (const id of [roadmap, openView, secret, secretView, spec.id, report.id, folder.id, insideDb, onlyX, embedded.id, privNote.id, outside.id, host.id, ...roadRows.map((r) => r.id)]) {
    pageIds.add(id)
  }

  const folderToken = await share(folder.id)
  const hostHtml = async () => {
    const tree = (await visit(`/api/public/${folderToken}`)).json() as { tree: { ref: string; title: string; children: { ref: string; title: string }[] }[] }
    const ref = tree.tree.find((n) => n.title === 'Public report')!.ref
    const page = await visit(`/api/public/${folderToken}/p/${ref}`)
    assert.equal(page.statusCode, 200, page.body)
    return page.json().html as string
  }

  it('public folder link: a view of a collection inside, an embedded page inside, nothing from outside', async () => {
    const html = await hostHtml()
    assert.match(html, /host text/)
    assert.match(html, /Alpha row/)
    assert.match(html, /Inside DB/)
    assert.match(html, /embedded body/)
    assert.match(html, /Embedded doc/)
    assert.match(html, /example\.com\/card/)
    assert.match(html, /<table/)
    // what is outside the link: no titles, rows, bodies; the relation to Roadmap shows no title
    assert.doesNotMatch(html, OUTSIDE)
    assert.doesNotMatch(html, INTERNALS)
    assert.deepEqual(strayIds(html), [], html)
    // the out-of-link embeds are said once each, without saying what they were
    assert.equal(html.match(/not part of this link/g)?.length, 4)
  })

  it('public folder link: making an embedded page private, moving the database out or trashing a page hides them at once', async () => {
    await db.update(schema.pages).set({ scope: 'private' }).where(eq(schema.pages.id, embedded.id))
    let html = await hostHtml()
    assert.doesNotMatch(html, /embedded body|Embedded doc/)
    await db.update(schema.pages).set({ scope: 'shared' }).where(eq(schema.pages.id, embedded.id))
    assert.match(await hostHtml(), /embedded body/)
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, embedded.id))
    assert.doesNotMatch(await hostHtml(), /embedded body|Embedded doc/)
    await db.update(schema.pages).set({ parentId: null }).where(eq(schema.pages.id, insideDb))
    html = await hostHtml()
    assert.doesNotMatch(html, /Alpha row|Inside DB/)
    assert.deepEqual(strayIds(html), [], html)
    // put things back for the next cases
    await db.update(schema.pages).set({ parentId: folder.id }).where(eq(schema.pages.id, insideDb))
    await db.update(schema.pages).set({ deletedAt: null }).where(eq(schema.pages.id, embedded.id))
  })

  it('public single-page link: only that page is inside — every embed, view and query shows nothing of others', async () => {
    const token = await share(host.id)
    const res = await visit(`/api/public/${token}`)
    assert.equal(res.statusCode, 200, res.body)
    const html = res.json().html as string
    assert.match(html, /host text/)
    assert.doesNotMatch(html, /Alpha row|Beta row|Inside DB|embedded body|Embedded doc/)
    assert.doesNotMatch(html, OUTSIDE)
    assert.doesNotMatch(html, INTERNALS)
    assert.deepEqual(strayIds(html), [], html)
    assert.equal(html.match(/not part of this link/g)?.length, 6)
    // the LIST query sees the page itself at most
    assert.doesNotMatch(html, /Published/)
  })

  it('password, not started and expired links answer before any block is rendered (page and folder child routes)', async () => {
    const token = await share(host.id)
    const locked = await pub.inject({ method: 'PATCH', url: `/api/pages/${host.id}/share`, headers: { cookie: alice.cookie }, payload: { password: 'correct horse' } })
    assert.equal(locked.statusCode, 200, locked.body)
    const r401 = await visit(`/api/public/${token}`)
    assert.equal(r401.statusCode, 401)
    assert.doesNotMatch(r401.body, /host text|Alpha|Xeno/)
    await pub.inject({ method: 'PATCH', url: `/api/pages/${host.id}/share`, headers: { cookie: alice.cookie }, payload: { password: null } })

    // the folder child route of "Public report", rendered (and cached) while the link is open
    const tree = (await visit(`/api/public/${folderToken}`)).json() as { tree: { ref: string; title: string }[] }
    const ref = tree.tree.find((n) => n.title === 'Public report')!.ref
    const child = `/api/public/${folderToken}/p/${ref}`
    assert.equal((await visit(child)).statusCode, 200)
    const noData = /Alpha|Xeno|embedded|host text/
    const folderLocked = await pub.inject({ method: 'PATCH', url: `/api/pages/${folder.id}/share`, headers: { cookie: alice.cookie }, payload: { password: 'folder secret' } })
    assert.equal(folderLocked.statusCode, 200, folderLocked.body)
    const c401 = await visit(child)
    assert.equal(c401.statusCode, 401)
    assert.doesNotMatch(c401.body, noData)
    await pub.inject({ method: 'PATCH', url: `/api/pages/${folder.id}/share`, headers: { cookie: alice.cookie }, payload: { password: null } })
    assert.equal((await visit(child)).statusCode, 200)
    await db.update(schema.pages).set({ shareStartsAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.pages.id, folder.id))
    assert.equal((await visit(`/api/public/${folderToken}`)).statusCode, 404)
    const c404 = await visit(child)
    assert.equal(c404.statusCode, 404)
    assert.doesNotMatch(c404.body, noData)
    await db.update(schema.pages).set({ shareStartsAt: null, shareExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.pages.id, folder.id))
    assert.equal((await visit(`/api/public/${folderToken}`)).statusCode, 410)
    const c410 = await visit(child)
    assert.equal(c410.statusCode, 410)
    assert.doesNotMatch(c410.body, noData)
    await db.update(schema.pages).set({ shareExpiresAt: null }).where(eq(schema.pages.id, folder.id))
    assert.equal((await visit(child)).statusCode, 200)
  })

  it('public query blocks in a folder nested under another page: no ancestor title, no page outside through FROM [[…]]', async () => {
    const { reindexPageLinks } = await import('./linkIndex')
    const [parent] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Zebra parent title', kind: 'folder', createdBy: alice.id }).returning()
    const [nested] = await db
      .insert(schema.pages)
      .values({ workspaceId: ws.id, parentId: parent.id, title: 'Nested pub', kind: 'folder', createdBy: alice.id })
      .returning()
    const linkBlocks = [
      { type: 'paragraph', content: [{ type: 'link', href: `/w/${ws.id}/p/${outside.id}`, content: [{ type: 'text', text: 'Outside doc', styles: {} }] }], children: [] },
    ]
    const linker = await h.makeDocPage(ws.id, alice.id, 'Linker page', linkBlocks as never, { parentId: nested.id })
    await reindexPageLinks(linker.id, linkBlocks as never)
    await h.makeDocPage(
      ws.id,
      alice.id,
      'Nested report',
      [para('nested host'), query('TABLE file.folder, file.path'), query('LIST FROM [[Outside doc]]'), query('LIST FROM "Zebra parent title"')] as never,
      { parentId: nested.id },
    )
    // control: for a member the same queries do reach outside (the folder path, the linking page)
    const asMember = async (source: string) => {
      const r = await as(alice, 'POST', `/workspaces/${ws.id}/query`, { source })
      assert.equal(r.statusCode, 200, r.body)
      return JSON.stringify(r.json())
    }
    assert.match(await asMember('TABLE file.folder FROM "Zebra parent title"'), /Zebra parent title\/Nested pub/)
    assert.match(await asMember('LIST FROM [[Outside doc]]'), /Linker page/)
    const token = await share(nested.id)
    const tree = (await visit(`/api/public/${token}`)).json() as { tree: { ref: string; title: string }[] }
    const ref = tree.tree.find((n) => n.title === 'Nested report')!.ref
    const res = await visit(`/api/public/${token}/p/${ref}`)
    assert.equal(res.statusCode, 200, res.body)
    const html = res.json().html as string
    assert.match(html, /nested host/)
    assert.doesNotMatch(html, /Zebra|Outside doc|outside body|Roadmap|Published/)
    // file.folder needs the folder tree from the top of the workspace, which is outside the link:
    // nothing rather than a path; FROM [[Outside doc]] names a page outside the link: nothing
    assert.equal(html.match(/No results inside this link/g)?.length, 3)
    assert.deepEqual(strayIds(html), [], html)
  })

  // ── agents ──────────────────────────────────────────────────────────────
  it('MCP: read_page shows the token with ids and a name line; update_page and patch_section keep the view', async () => {
    const { reindexPageChunks } = await import('../context/chunkIndex')
    const blocks = [heading('Board'), para('numbers below'), embed(roadmap, openView), heading('Hidden'), embed(secret, secretView), heading('Notes'), para('end')]
    const pg = await h.makeDocPage(ws.id, bob.id, 'Weekly', blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    const B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Bob Agent'))
    try {
      const read = await B.tool('read_page', { pageId: pg.id })
      assert.equal(read.isError, false, read.text)
      assert.match(read.text, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${roadmap}","viewId":"${openView}"\\} -->\\n<!-- inkling:view-info database "Roadmap", view "Open" \\(table\\); its rows: query_rows -->`))
      // the secret database: no name, no view name, only "unavailable"
      assert.match(read.text, /<!-- inkling:view-info unavailable: this database is not visible to you/)
      assert.doesNotMatch(read.text, /Secret plans|All secret|Hidden acquisition|Login|Charts/)
      const section = await B.tool('read_page', { pageId: pg.id, section: 'board' })
      assert.match(section.text, /inkling:view-info database "Roadmap"/)

      // the read sent back unchanged writes nothing new (the info lines are dropped, the blocks kept)
      const before = (await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body
      const md = /<untrusted_content[^>]*>\n([^]*)\n<\/untrusted_content>/.exec(read.text)![1]
      const baseVersion = /^- version: (\S+)$/m.exec(read.text)![1]
      const rep = await B.tool('update_page', { pageId: pg.id, markdown: md, mode: 'replace', baseVersion })
      assert.equal(rep.isError, false, rep.text)
      assert.equal((await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body.replace(/updated: .*\n/, ''), before.replace(/updated: .*\n/, ''))

      // patch_section over the section that holds the view keeps it
      const sec = await B.tool('read_page', { pageId: pg.id, section: 'board' })
      const v = /v=(\S+?)\)/.exec(sec.text)?.[1]
      const body = /<untrusted_content[^>]*>\n([^]*)\n<\/untrusted_content>/.exec(sec.text)![1].replace('numbers below', 'numbers, edited')
      const patched = await B.tool('patch_section', { pageId: pg.id, section: 'board', markdown: body, mode: 'replace', ...(v ? { baseVersion: v } : {}) })
      assert.equal(patched.isError, false, patched.text)
      const after = (await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body
      assert.match(after, /numbers, edited/)
      assert.match(after, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${roadmap}","viewId":"${openView}"\\} -->`))

      // an agent may add a database view by writing the token line
      const add = await B.tool('update_page', {
        pageId: pg.id,
        mode: 'append',
        markdown: `<!-- inkling:pageEmbed {"pageId":"${roadmap}","viewId":"${openView}"} -->`,
      })
      assert.equal(add.isError, false, add.text)
      const final = (await as(bob, 'GET', `/pages/${pg.id}/export?format=md&notation=agent`)).body
      assert.equal(final.match(new RegExp(`"viewId":"${openView}"`, 'g'))?.length, 2)
    } finally {
      await B.close()
    }
  })
})
