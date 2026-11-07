// [db] Notion export import through POST /workspaces/:id/import (docs/adr/0960-*, 0961-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-notion-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] Notion import', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { createSession, SESSION_COOKIE } = await import('../auth')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { eq, inArray } = await import('drizzle-orm')
  const { stateToBlocks } = await import('./convert')
  const { buildNotionFixture, FIXTURE_EXPECT } = await import('./notionFixture')
  const { env } = await import('../env')
  const Fastify = (await import('fastify')).default

  const uploads = path.join(env.dataDir, 'uploads')
  await mkdir(uploads, { recursive: true })

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
      await (await import('../routes/exportImport')).registerExportImportRoutes(api)
      await (await import('../routes/collections')).registerCollectionRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
    await rm(env.dataDir, { recursive: true, force: true }).catch(() => {})
  })

  const tag = () => randomUUID().slice(0, 8)
  async function setup() {
    const [u] = await db.insert(schema.users).values({ email: `n-${tag()}@t.t`, name: 'n', passwordHash: 'x' }).returning()
    const { token } = await createSession(u.id)
    const [ws] = await db.insert(schema.workspaces).values({ name: 'W', inviteCode: `N${tag()}` }).returning()
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: 'owner' as const })
    return { user: u, ws, cookie: `${SESSION_COOKIE}=${token}` }
  }
  function multipart(filename: string, body: Buffer) {
    const boundary = `----t${randomBytes(8).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${filename.endsWith('.md') ? 'text/markdown' : 'application/zip'}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
  }
  async function post(cookie: string, url: string, file: Buffer, name = 'Export.zip') {
    const mp = multipart(name, file)
    return app.inject({ method: 'POST', url, headers: { cookie, ...mp.headers }, payload: mp.payload })
  }
  function hrefs(blocks: unknown): string[] {
    return [...JSON.stringify(blocks).matchAll(/"href":"([^"]+)"/g)].map((m) => m[1])
  }
  async function blocksOf(pageId: string) {
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return d ? stateToBlocks(d.state) : null
  }

  it('imports a nested Notion export: tree, collections, rows, links, attachments, report', async () => {
    const { ws, cookie } = await setup()
    const res = await post(cookie, `/api/workspaces/${ws.id}/import?source=notion`, await buildNotionFixture())
    assert.equal(res.statusCode, 200, res.body)
    const { pages: created, report } = res.json() as {
      pages: { id: string; title: string; kind: string; parentId: string | null }[]
      report: import('./notionImport').NotionImportReport
    }

    // report numbers
    assert.equal(report.detected, 'explicit')
    assert.equal(report.documents, FIXTURE_EXPECT.documents)
    assert.equal(report.collections, FIXTURE_EXPECT.collections)
    assert.equal(report.rows, FIXTURE_EXPECT.rows)
    assert.equal(report.attachments, FIXTURE_EXPECT.attachments)
    assert.deepEqual(report.links, FIXTURE_EXPECT.links)
    assert.equal(report.brokenLinkCount, FIXTURE_EXPECT.broken)
    assert.match(report.brokenLinks[0].href, /Missing%20Page/)
    assert.equal(report.callouts, 1)
    assert.equal(report.pages, created.length)

    // stored pages
    const rows = await db.select().from(schema.pages).where(inArray(schema.pages.id, created.map((p) => p.id)))
    const byTitle = new Map(rows.map((r) => [r.title, r]))
    assert.equal(byTitle.get('로드맵 계획')?.parentId, null)
    assert.equal(byTitle.get('Getting Started')?.parentId, byTitle.get('Team Wiki')?.id)
    assert.ok(byTitle.get('Notes (2)'))

    // collections: fields + rows + relation targets inside the import
    const projects = byTitle.get('Projects')!
    assert.equal(projects.kind, 'collection')
    const [coll] = await db.select().from(schema.collections).where(eq(schema.collections.pageId, projects.id))
    const fields = coll.fields as { id: string; name: string; type: string; relation?: { targetPageId: string } }[]
    const members = fields.find((f) => f.name === 'Members')!
    assert.equal(members.type, 'relation')
    assert.equal(members.relation?.targetPageId, byTitle.get('People')!.id)
    const views = await db.select().from(schema.collectionViews).where(eq(schema.collectionViews.pageId, projects.id))
    assert.equal(views.length, 1)
    const projectRows = rows.filter((r) => r.parentId === projects.id)
    assert.equal(projectRows.length, 4)
    const alpha = projectRows.find((r) => r.title === 'Alpha')!
    const alphaMembers = (alpha.props as Record<string, string[]>)[members.id]
    assert.deepEqual(
      alphaMembers.map((id) => rows.find((r) => r.id === id)?.title).sort(),
      ['Ada', 'Linus'],
    )

    // the collection API reads the rows back
    const api = await app.inject({ method: 'GET', url: `/api/pages/${projects.id}/collection`, headers: { cookie } })
    assert.equal(api.statusCode, 200, api.body)

    // row page body: title heading and property lines removed, task kept
    const alphaBlocks = (await blocksOf(alpha.id))!
    const alphaText = JSON.stringify(alphaBlocks)
    assert.doesNotMatch(alphaText, /Status: Active/)
    assert.match(alphaText, /Alpha is the first project/)
    assert.equal(alphaBlocks[0].type, 'paragraph')

    // Getting Started: block types and resolved links
    const gs = (await blocksOf(byTitle.get('Getting Started')!.id))!
    const types = gs.map((b) => b.type)
    // 12 blocks: callout→quote, toggle, table, 2 checklist items, equation (math block),
    // inline-math paragraph, image, file (promoted from a lone attachment link), link paragraphs
    // and the fenced code
    assert.deepEqual(types, [
      'quote', 'toggleListItem', 'table', 'checkListItem', 'checkListItem', 'math',
      'paragraph', 'image', 'file', 'paragraph', 'paragraph', 'codeBlock',
    ])
    for (const t of ['quote', 'toggleListItem', 'table', 'checkListItem', 'math', 'codeBlock', 'image', 'file']) {
      assert.ok(types.includes(t), `missing ${t} in ${types.join(',')}`)
    }
    assert.notEqual(types[0], 'heading', 'the title heading is stripped')
    const quote = gs.find((b) => b.type === 'quote')!
    assert.match(JSON.stringify(quote.content), /💡 Read this first/)
    const toggle = gs.find((b) => b.type === 'toggleListItem')!
    assert.equal(toggle.children?.length, 1)
    const equation = gs.find((b) => b.type === 'math')
    assert.equal(equation?.props?.latex, 'E = mc^2', 'block equation imported as a math block')
    const inline = JSON.stringify(gs[6].content)
    assert.match(inline, /"type":"inlineMath","props":\{"latex":"a_1 \+ b"\}/, 'inline equation imported as inline math')
    assert.match(inline, /prices \$5 and \$10 stay/, 'prices are not math')

    const links = hrefs(gs)
    const pageLink = (title: string) => `/w/${ws.id}/p/${byTitle.get(title)!.id}`
    for (const t of ['Notes', 'Team Wiki', 'Projects', '로드맵 계획', 'Alpha']) {
      assert.ok(links.includes(pageLink(t)), `link to ${t}`)
    }
    assert.ok(links.some((h) => h.includes('Missing%20Page')), 'broken link kept as written')
    const img = gs.find((b) => b.type === 'image')!
    assert.match(String(img.props?.url), /^\/files\/[0-9a-f-]{36}$/)
    const file = gs.find((b) => b.type === 'file')!
    assert.match(String(file.props?.url), /^\/files\/[0-9a-f-]{36}$/)

    // link resolution ratio over the whole import
    const docIds = rows.filter((r) => r.kind === 'doc').map((r) => r.id)
    let internal = 0
    let relative = 0
    for (const id of docIds) {
      const b = await blocksOf(id)
      for (const h of hrefs(b ?? [])) {
        if (h.startsWith(`/w/${ws.id}/p/`)) internal++
        else if (!/^https?:|^mailto:/.test(h) && !h.startsWith('/files/')) relative++
      }
    }
    assert.equal(internal, 8) // 5 in Getting Started, 2 in Team Wiki, 1 in the roadmap
    assert.equal(relative, 1) // the missing page

    // attachments belong to the page that references them; bytes are on disk
    const fileRows = await db.select().from(schema.files).where(eq(schema.files.workspaceId, ws.id))
    assert.equal(fileRows.length, 2)
    assert.ok(fileRows.every((f) => f.pageId === byTitle.get('Getting Started')!.id))
    const onDisk = new Set(await readdir(uploads))
    assert.ok(fileRows.every((f) => onDisk.has(f.id)))

    // backlinks index sees the converted links
    const backlinks = await db.select().from(schema.pageLinks).where(eq(schema.pageLinks.targetPageId, byTitle.get('Notes')!.id))
    assert.equal(backlinks.length, 1)
  })

  it('auto-detects a flat Notion export on the plain import route', async () => {
    const { ws, cookie } = await setup()
    const res = await post(cookie, `/api/workspaces/${ws.id}/import`, await buildNotionFixture({ nested: false }))
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { report?: { detected: string; rows: number } }
    assert.equal(body.report?.detected, 'auto')
    assert.equal(body.report?.rows, FIXTURE_EXPECT.rows)
  })

  it('keeps plain Markdown zips on the regular importer and rejects non-zip Notion uploads', async () => {
    const { ws, cookie } = await setup()
    const JSZip = (await import('jszip')).default
    const z = new JSZip()
    z.file('notes/a.md', '# A\n')
    const res = await post(cookie, `/api/workspaces/${ws.id}/import`, await z.generateAsync({ type: 'nodebuffer' }), 'n.zip')
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((res.json() as { report?: unknown }).report, undefined)
    const bad = await post(cookie, `/api/workspaces/${ws.id}/import?source=notion`, Buffer.from('# hi'), 'x.md')
    assert.equal(bad.statusCode, 415)
  })

  it('leaves nothing behind when a document fails mid-import', async () => {
    const { ws, user } = await setup()
    const { importNotionZip } = await import('./notionImport')
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(await buildNotionFixture({ nested: false }))
    // corrupt one Markdown entry so reading it fails after pages and some uploads exist
    const victim = Object.keys(zip.files).find((n) => n.endsWith(`Notes ${'4d'.repeat(16)}.md`))!
    ;(zip.files[victim] as unknown as { nodeStream: () => never }).nodeStream = () => {
      throw new Error('boom')
    }
    await assert.rejects(
      importNotionZip({ buffer: Buffer.alloc(0), zip, workspaceId: ws.id, parentId: null, userId: user.id, scope: 'shared', role: 'owner', detected: 'explicit' }),
      /boom/,
    )
    const left = await db.select().from(schema.pages).where(eq(schema.pages.workspaceId, ws.id))
    assert.equal(left.length, 0)
    const leftFiles = await db.select().from(schema.files).where(eq(schema.files.workspaceId, ws.id))
    assert.equal(leftFiles.length, 0)
    // the two attachments uploaded before the failure were removed from disk as well
    const known = new Set((await db.select({ id: schema.files.id }).from(schema.files)).map((f) => f.id))
    assert.ok((await readdir(uploads)).every((f) => known.has(f)))
  })

  it('refuses an import under a parent the user cannot see', async () => {
    const { ws, cookie } = await setup()
    const res = await post(cookie, `/api/workspaces/${ws.id}/import?source=notion&parentId=${randomUUID()}`, await buildNotionFixture())
    assert.equal(res.statusCode, 400)
  })
})
