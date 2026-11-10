// Markdown download of public pages (docs/adr/2362-*): off by default and 404 then; turned on per
// link by the people who manage links (audited like the other link settings); the same gate as the
// page (expired, scheduled, password, folder refs, trash); and nothing in the file that the page's
// own HTML does not show — the same fixture is rendered both ways and compared, word by word.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-publicexport-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR = DATA
process.env.WEB_DIST = path.join(DATA, 'web')
mkdirSync(path.join(DATA, 'web'), { recursive: true })
mkdirSync(path.join(DATA, 'uploads'), { recursive: true })
writeFileSync(path.join(DATA, 'web', 'index.html'), '<!doctype html><html><head><title>Inkling</title></head><body></body></html>')

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const ORIGIN = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')

describe('[db] public pages: Markdown download', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and } = await import('drizzle-orm')
  const { AppError } = await import('./errors')
  const { guardHook } = await import('./guard')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  const routeConfig = new Map<string, unknown>()
  app.addHook('onRoute', (r) => {
    if (String(r.url).endsWith('/export.md')) routeConfig.set(String(r.url), r.config)
  })
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  app.addHook('onRequest', guardHook)
  await app.register(
    async (api) => {
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/collections')).registerCollectionRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Res = Awaited<ReturnType<typeof app.inject>>
  let ipSeq = 1
  const newIp = () => `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
  const member = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 300)}`)
    return res.body ? res.json() : {}
  }
  const visit = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {}, remoteAddress: newIp() })

  const W = randomBytes(3).toString('hex')
  const txt = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text, styles })
  const para = (...content: unknown[]) => ({ type: 'paragraph', content, children: [] as unknown[] })

  const alice = await h.makeUser(`Alice${W}`)
  const bob = await h.makeUser(`Bob${W}`)
  const ws = await h.makeWorkspace(alice, [bob])

  // ── data that must never reach a visitor ─────────────────────────────────
  const outside = await h.makeDocPage(ws.id, alice.id, `OUTSIDETITLE${W}`, [para(txt(`OUTSIDEBODY${W}`))] as never)
  const webhookId = randomUUID()

  /** A collection with two rows (a chart and a database view read it). */
  const newCollection = async (title: string, parentId?: string) => {
    const id = (await ok(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title, ...(parentId ? { parentId } : {}) })).page.id as string
    await ok(alice, 'PUT', `/pages/${id}/collection/fields`, {
      fields: [
        { id: 'st', name: 'Status', type: 'select', options: [{ id: 'todo', name: 'Todo', color: 'gray' }, { id: 'done', name: 'Done', color: 'green' }] },
        { id: 'pts', name: 'Points', type: 'number' },
        { id: 'own', name: 'Owner', type: 'person' },
      ],
    })
    for (const [t, st, pts] of [[`RowOne${W}`, 'todo', 3], [`RowTwo${W}`, 'done', 5]] as const) {
      await ok(alice, 'POST', `/pages/${id}/collection/rows`, { title: t, props: { st, pts, own: bob.id }, template: null })
    }
    return id
  }

  /** Every kind of block whose data comes from elsewhere, plus the ordinary ones. */
  const richBlocks = (o: { inside?: { id: string; title: string }; collection: string; collTitle: string; imageId: string; fileId: string }) => [
    { type: 'heading', props: { level: 2 }, content: [txt(`Plan heading ${W}`)], children: [] },
    para(
      txt('Body with '),
      txt('bold', { bold: true }),
      txt(' and '),
      { type: 'link', href: 'https://example.org/ext', content: [txt('an outside site')] },
      txt(', a link to '),
      { type: 'link', href: `/w/${ws.id}/p/${outside.id}`, content: [txt('OutsideLinkShown')] },
      ...(o.inside ? [txt(' and to '), { type: 'link', href: `/w/${ws.id}/p/${o.inside.id}`, content: [txt(o.inside.title)] }] : []),
      txt(' and '),
      { type: 'mention', props: { kind: 'user', id: bob.id, label: 'Bob Visible' } },
    ),
    { type: 'toggleListItem', content: [txt('Toggle head')], children: [para(txt(`Toggle child ${W}`))] },
    { type: 'checkListItem', props: { checked: true }, content: [txt('Done item')], children: [] },
    { type: 'callout', props: { type: 'warning' }, content: [txt('Mind the gap')], children: [] },
    { type: 'codeBlock', props: { language: 'javascript' }, content: [txt('const answer = 42')], children: [] },
    { type: 'codeBlock', props: { language: 'mermaid' }, content: [txt('graph TD\n  A[Start] --> B[Ship]')], children: [] },
    { type: 'codeBlock', props: { language: 'dataview' }, content: [txt(`TABLE Points FROM "${o.collTitle}"`)], children: [] },
    { type: 'image', props: { url: `/files/${o.imageId}`, name: `IMGNAME${W}.png`, caption: 'Caption shown' }, children: [] },
    { type: 'file', props: { url: `/files/${o.fileId}`, name: 'brief.pdf' }, children: [] },
    {
      type: 'button',
      props: { label: 'Press me', color: 'blue', actions: JSON.stringify([{ type: 'webhook', webhookId, message: `BTNACTION${W}` }]) },
      children: [],
    },
    { type: 'pageEmbed', props: { pageId: outside.id, viewId: '' }, children: [] },
    { type: 'pageEmbed', props: { pageId: o.collection, viewId: '' }, children: [] },
    {
      type: 'chart',
      props: { config: JSON.stringify({ source: { type: 'collection', collectionId: o.collection }, kind: 'bar', groupBy: { field: 'st' }, title: `CHARTTITLE${W}` }) },
      children: [],
    },
    { type: 'linkEmbed', props: { url: 'https://example.org/card', display: 'card' }, children: [] },
    {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: [[txt('Cell A1')], [txt('Cell B1')], [txt('Cell C1')]] },
          { cells: [[txt('Cell A2')], [txt('Cell B2')], [txt('Cell C2')]] },
        ],
      },
      children: [],
    },
  ]

  const uploadFile = async (pageId: string, name: string, mime: string) => {
    const id = randomUUID()
    writeFileSync(path.join(DATA, 'uploads', id), Buffer.from('89504e470d0a1a0a', 'hex'))
    await db.insert(schema.files).values({ id, workspaceId: ws.id, pageId, name, mime, size: 8 })
    return id
  }
  /** Comment and suggestion bodies stored with the page (never part of the page itself). */
  const decorate = async (pageId: string) => {
    const cid = randomUUID()
    await db.insert(schema.comments).values({ id: cid, pageId, blockId: 'b1', threadId: cid, authorId: bob.id, body: `COMMENTBODY${W}` })
    await db.insert(schema.sectionSuggestions).values({ workspaceId: ws.id, pageId, anchor: 'x', markdown: `SUGGESTBODY${W}`, mode: 'replace', origin: 'asked', authorId: bob.id })
  }

  // single-page link: a doc with every block
  const rootColl = await newCollection(`RootColl${W}`)
  const [single] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Single ${W}`, kind: 'doc', createdBy: alice.id, properties: [{ id: 'fullWidth', value: true }] }).returning()
  const singleImage = await uploadFile(single.id, `IMGNAME${W}.png`, 'image/png')
  const singleFile = await uploadFile(single.id, 'brief.pdf', 'application/pdf')
  await db.insert(schema.pageDocs).values({
    pageId: single.id,
    state: (await import('./md/convert')).blocksToStateBuffer(richBlocks({ collection: rootColl, collTitle: `RootColl${W}`, imageId: singleImage, fileId: singleFile }) as never),
  })
  await decorate(single.id)

  // folder link: a doc next to a page and a collection inside the folder
  const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Folder ${W}`, kind: 'folder', createdBy: alice.id }).returning()
  const inside = await h.makeDocPage(ws.id, alice.id, `Inside guide ${W}`, [para(txt('inside body'))] as never, { parentId: folder.id, sortOrder: 2 })
  const folderColl = await newCollection(`FolderColl${W}`, folder.id)
  const [child] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Child ${W}`, kind: 'doc', createdBy: alice.id, parentId: folder.id, sortOrder: 0 }).returning()
  const childImage = await uploadFile(child.id, `IMGNAME${W}.png`, 'image/png')
  const childFile = await uploadFile(child.id, 'brief.pdf', 'application/pdf')
  await db.insert(schema.pageDocs).values({
    pageId: child.id,
    state: (await import('./md/convert')).blocksToStateBuffer(
      richBlocks({ inside: { id: inside.id, title: inside.title }, collection: folderColl, collTitle: `FolderColl${W}`, imageId: childImage, fileId: childFile }) as never,
    ),
  })
  await decorate(child.id)

  const publish = async (pageId: string, body?: unknown) => (await ok(alice, 'POST', `/pages/${pageId}/share`, body)).token as string
  const allow = (pageId: string, on: boolean) => ok(alice, 'PATCH', `/pages/${pageId}/share`, { allowDownload: on })
  const singleToken = await publish(single.id)
  const folderToken = await publish(folder.id)
  const refOf = async (title: string) => {
    const tree = (await visit(`/api/public/${folderToken}`)).json().tree as { ref: string; title: string }[]
    const hit = tree.find((n) => n.title === title)
    assert.ok(hit, `${title} in the folder tree`)
    return hit.ref
  }
  const childRef = await refOf(child.title)
  const collRef = await refOf(`FolderColl${W}`)

  /** Things that are never shown on the public page, so never in its Markdown either. */
  const NEVER = [
    outside.id, `OUTSIDETITLE${W}`, `OUTSIDEBODY${W}`,
    alice.id, bob.id, alice.email, bob.email,
    ws.id, single.id, child.id, folder.id, inside.id, rootColl, folderColl,
    webhookId, `BTNACTION${W}`, `COMMENTBODY${W}`, `SUGGESTBODY${W}`,
    'inkling:', '/w/', '<!--', 'inkling-id',
  ].filter((s): s is string => typeof s === 'string' && s.length > 0)

  /** Words of the Markdown that are not anywhere in the page's HTML (or its title). */
  const wordsNotInHtml = (md: string, html: string, title: string) => {
    const corpus = `${html}\n${title}`.toLowerCase()
    const words = md.replaceAll(ORIGIN, ' ').match(/[\p{L}\p{N}]{3,}/gu) ?? []
    return [...new Set(words.filter((w) => !corpus.includes(w.toLowerCase())))]
  }

  it('a new link does not allow the download: 404 on both routes and no flag in the page', async () => {
    const page = await visit(`/api/public/${singleToken}`)
    assert.equal(page.statusCode, 200)
    assert.equal(page.json().download, undefined)
    assert.equal(page.json().fullWidth, true)
    assert.equal((await visit(`/api/public/${singleToken}/export.md`)).statusCode, 404)
    assert.equal((await visit(`/api/public/${folderToken}/p/${childRef}/export.md`)).statusCode, 404)
    const status = await ok(alice, 'GET', `/pages/${single.id}/share`)
    assert.equal(status.allowDownload, false)
    // creating a link cannot turn it on (the body is strict); only the link settings can
    const other = await h.makeDocPage(ws.id, alice.id, `Other ${W}`, [para(txt('x'))] as never)
    assert.equal((await member(alice, 'POST', `/pages/${other.id}/share`, { allowDownload: true })).statusCode, 400)
    // both routes are rate-limited like the other public routes
    for (const url of ['/api/public/:token/export.md', '/api/public/:token/p/:ref/export.md']) {
      assert.deepEqual((routeConfig.get(url) as { rateLimit?: unknown } | undefined)?.rateLimit, { max: 60, timeWindow: '1 minute' }, url)
    }
  })

  it('only owners and admins turn it on or off; each change is audited', async () => {
    const denied = await member(bob, 'PATCH', `/pages/${single.id}/share`, { allowDownload: true })
    assert.equal(denied.statusCode, 403)
    const stranger = await h.makeUser(`Stranger${W}`)
    assert.equal((await member(stranger, 'PATCH', `/pages/${single.id}/share`, { allowDownload: true })).statusCode, 404)
    assert.equal((await visit(`/api/public/${singleToken}/export.md`)).statusCode, 404)

    const on = await allow(single.id, true)
    assert.equal(on.allowDownload, true)
    // the same value again changes nothing and is not audited twice
    await allow(single.id, true)
    const rows = await db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.targetId, single.id), eq(schema.workspaceAuditEvents.action, 'share.download_changed')))
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].before, { allowDownload: false })
    assert.deepEqual(rows[0].after, { allowDownload: true })
    assert.equal(rows[0].actorId, alice.id)
    assert.equal((await visit(`/api/public/${singleToken}`)).json().download, true)
  })

  it('an allowed link answers a file: name, type, no caching, no indexing, never inline', async () => {
    const res = await visit(`/api/public/${singleToken}/export.md`)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8')
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent(`Single ${W}.md`)}`)
    assert.match(String(res.headers['x-robots-tag']), /noindex/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    const md = res.body
    assert.ok(md.startsWith(`# Single ${W}\n\n`), md.slice(0, 80))
    for (const want of [`Plan heading ${W}`, '**bold**', '[an outside site](https://example.org/ext)', 'OutsideLinkShown', '@Bob Visible', `Toggle child ${W}`, '[x] Done item', '> [!warning] Mind the gap', '```javascript', 'const answer = 42', 'Cell B2']) {
      assert.ok(md.includes(want), `${want} in\n${md}`)
    }
    // attachments: public file URLs with the site's address
    assert.ok(md.includes(`${ORIGIN}/api/public/${singleToken}/f/${singleImage}`), md)
    assert.ok(md.includes(`${ORIGIN}/api/public/${singleToken}/f/${singleFile}`), md)
    // the database view of a collection outside a single-page link: the page's note, not its rows
    assert.doesNotMatch(md, new RegExp(`RowOne${W}|RowTwo${W}`))
    assert.match(md, /not part of this link|이 링크에 포함되지 않은/)
    assert.match(md, /No results inside this link|이 링크 안에는 결과가 없습니다/)
    // the button is left out, label and actions alike
    assert.doesNotMatch(md, /Press me/)
  })

  it('the file holds nothing the page HTML does not (single-page link)', async () => {
    const page = (await visit(`/api/public/${singleToken}`)).json() as { html: string; title: string }
    const md = (await visit(`/api/public/${singleToken}/export.md`)).body
    for (const s of NEVER) {
      assert.ok(!md.includes(s), `Markdown holds ${s}`)
      assert.ok(!page.html.includes(s) || s === '<!--', `HTML holds ${s}`)
    }
    assert.deepEqual(wordsNotInHtml(md, page.html, page.title), [])
  })

  it('folder links: the folder setting opens its pages; inside links and views work, the rest stays out', async () => {
    assert.equal((await visit(`/api/public/${folderToken}/p/${childRef}/export.md`)).statusCode, 404)
    await allow(folder.id, true)
    const page = (await visit(`/api/public/${folderToken}/p/${childRef}`)).json() as { html: string; title: string; download?: boolean; fullWidth?: boolean }
    assert.equal(page.download, true)
    assert.equal(page.fullWidth, undefined)
    const res = await visit(`/api/public/${folderToken}/p/${childRef}/export.md`)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent(`Child ${W}.md`)}`)
    const md = res.body
    // a link to a page inside the folder: its public address; outside: its text only
    const insideRef = await refOf(inside.title)
    assert.ok(md.includes(`](${ORIGIN}/s/${folderToken}/p/${insideRef})`), md)
    assert.ok(md.includes('OutsideLinkShown'))
    // the database view, the chart and the query of the collection inside the folder: as on the page
    assert.ok(md.includes(`RowOne${W}`) && md.includes(`RowTwo${W}`), md)
    assert.equal(md.split(`RowOne${W}`).length - 1, page.html.split(`RowOne${W}`).length - 1, 'rows as often as on the page')
    // a query block is its results table on a public page, never its query text
    assert.doesNotMatch(md, /TABLE Points FROM|dataview/)
    assert.doesNotMatch(md, /not available on a shared page/)
    assert.ok(md.includes(`${ORIGIN}/api/public/${folderToken}/p/${childRef}/f/${childImage}`), md)
    for (const s of NEVER) {
      assert.ok(!md.includes(s), `Markdown holds ${s}`)
      assert.ok(!page.html.includes(s) || s === '<!--', `HTML holds ${s}`)
    }
    assert.deepEqual(wordsNotInHtml(md, page.html, page.title), [])

    // a collection page of the folder: its table
    const coll = await visit(`/api/public/${folderToken}/p/${collRef}/export.md`)
    assert.equal(coll.statusCode, 200, coll.body)
    assert.match(coll.body, new RegExp(`RowOne${W}`))
    const collPage = (await visit(`/api/public/${folderToken}/p/${collRef}`)).json() as { html: string; title: string }
    assert.deepEqual(wordsNotInHtml(coll.body, collPage.html, collPage.title), [])
    // the folder itself has no body to download, and a single-page token has no /p/ pages
    assert.equal((await visit(`/api/public/${folderToken}/export.md`)).statusCode, 404)
    assert.equal((await visit(`/api/public/${singleToken}/p/${childRef}/export.md`)).statusCode, 404)
  })

  it('folder refs: outside the subtree, private, trashed or made up is 404', async () => {
    await allow(folder.id, true)
    const fake = randomBytes(16).toString('base64url').slice(0, 22)
    assert.equal((await visit(`/api/public/${folderToken}/p/${fake}/export.md`)).statusCode, 404)
    assert.equal((await visit(`/api/public/${folderToken}/p/not-a-ref/export.md`)).statusCode, 400)
    const gone = await h.makeDocPage(ws.id, alice.id, `Gone ${W}`, [para(txt('gone body'))] as never, { parentId: folder.id, sortOrder: 9 })
    const goneRef = await refOf(gone.title)
    assert.equal((await visit(`/api/public/${folderToken}/p/${goneRef}/export.md`)).statusCode, 200)
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, gone.id))
    assert.equal((await visit(`/api/public/${folderToken}/p/${goneRef}/export.md`)).statusCode, 404)
    const priv = await h.makeDocPage(ws.id, alice.id, `Private ${W}`, [para(txt('private body'))] as never, { parentId: folder.id, sortOrder: 10 })
    const privRef = await refOf(priv.title)
    await db.update(schema.pages).set({ scope: 'private' }).where(eq(schema.pages.id, priv.id))
    assert.equal((await visit(`/api/public/${folderToken}/p/${privRef}/export.md`)).statusCode, 404)
  })

  it('the link gate comes first: expired 410, scheduled 404, password 401 until unlocked, trashed 404', async () => {
    const [p] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Gated ${W}`, kind: 'doc', createdBy: alice.id }).returning()
    await db.insert(schema.pageDocs).values({ pageId: p.id, state: (await import('./md/convert')).blocksToStateBuffer([para(txt('gated body'))] as never) })
    const token = await publish(p.id)
    await allow(p.id, true)
    const url = `/api/public/${token}/export.md`
    assert.equal((await visit(url)).statusCode, 200)

    await db.update(schema.pages).set({ shareExpiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.pages.id, p.id))
    const expired = await visit(url)
    assert.equal(expired.statusCode, 410)
    assert.doesNotMatch(expired.body, /gated body/)
    await db.update(schema.pages).set({ shareExpiresAt: null, shareStartsAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.pages.id, p.id))
    assert.equal((await visit(url)).statusCode, 404)
    await db.update(schema.pages).set({ shareStartsAt: null }).where(eq(schema.pages.id, p.id))

    await ok(alice, 'PATCH', `/pages/${p.id}/share`, { password: 'open sesame' })
    const locked = await visit(url)
    assert.equal(locked.statusCode, 401)
    assert.equal(locked.json().error.code, 'SHARE_PASSWORD_REQUIRED')
    const unlock = await app.inject({ method: 'POST', url: `/api/public/${token}/unlock`, payload: { password: 'open sesame' }, remoteAddress: newIp() })
    assert.equal(unlock.statusCode, 204)
    const c = unlock.cookies.find((x) => x.name === 'inkling_share')!
    const opened = await visit(url, `${c.name}=${c.value}`)
    assert.equal(opened.statusCode, 200)
    assert.match(opened.body, /gated body/)
    // a locked link whose download is off answers the gate too (the setting is not revealed)
    await allow(p.id, false)
    assert.equal((await visit(url)).statusCode, 401)
    assert.equal((await visit(url, `${c.name}=${c.value}`)).statusCode, 404)
    await allow(p.id, true)

    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, p.id))
    assert.equal((await visit(url, `${c.name}=${c.value}`)).statusCode, 404)
  })

  it('unpublishing clears the setting: the next link starts with the download off', async () => {
    const p = await h.makeDocPage(ws.id, alice.id, `Again ${W}`, [para(txt('again body'))] as never)
    const first = await publish(p.id)
    await allow(p.id, true)
    assert.equal((await visit(`/api/public/${first}/export.md`)).statusCode, 200)
    await ok(alice, 'DELETE', `/pages/${p.id}/share`)
    const [row] = await db.select({ allow: schema.pages.shareAllowDownload }).from(schema.pages).where(eq(schema.pages.id, p.id))
    assert.equal(row.allow, false)
    const second = await publish(p.id)
    assert.equal((await visit(`/api/public/${first}/export.md`)).statusCode, 404)
    assert.equal((await visit(`/api/public/${second}/export.md`)).statusCode, 404)
    assert.equal((await ok(alice, 'GET', `/pages/${p.id}/share`)).allowDownload, false)
  })
})
