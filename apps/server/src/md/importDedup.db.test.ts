// [db] Import de-duplication (docs/adr/1122-*): identical attachments stored once (zip and Notion),
// the same Notion page reached through two export folders imported once, and the counts in the
// import report.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-dedup-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] import de-duplication', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { createSession, SESSION_COOKIE } = await import('../auth')
  const { AppError } = await import('../errors')
  const { eq, inArray } = await import('drizzle-orm')
  const { stateToBlocks } = await import('./convert')
  const { env } = await import('../env')
  const JSZip = (await import('jszip')).default
  const Fastify = (await import('fastify')).default

  const uploads = path.join(env.dataDir, 'uploads')
  await mkdir(uploads, { recursive: true })
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => (await import('../routes/exportImport')).registerExportImportRoutes(api), { prefix: '/api' })
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
    await rm(env.dataDir, { recursive: true, force: true }).catch(() => {})
  })

  const tag = () => randomUUID().slice(0, 8)
  async function setup() {
    const [u] = await db.insert(schema.users).values({ email: `d-${tag()}@t.t`, name: 'd', passwordHash: 'x' }).returning()
    const { token } = await createSession(u.id)
    const [ws] = await db.insert(schema.workspaces).values({ name: 'W', inviteCode: `D${tag()}` }).returning()
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: 'owner' as const })
    return { ws, cookie: `${SESSION_COOKIE}=${token}` }
  }
  async function post(cookie: string, url: string, file: Buffer) {
    const boundary = `----d${randomBytes(8).toString('hex')}`
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Export.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return app.inject({ method: 'POST', url, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  }
  async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
    const z = new JSZip()
    for (const [name, data] of Object.entries(files)) z.file(name, data)
    return z.generateAsync({ type: 'nodebuffer' })
  }
  const fileUrls = async (pageId: string) => {
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return [...JSON.stringify(stateToBlocks(d.state)).matchAll(/"url":"(\/files\/[^"]+)"/g)].map((m) => m[1])
  }
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const OTHER = Buffer.concat([PNG, Buffer.from('different')])

  it('zip: the same bytes under two names are one file; the response says how many were merged', async () => {
    const { ws, cookie } = await setup()
    const before = new Set(await readdir(uploads))
    const res = await post(
      cookie,
      `/api/workspaces/${ws.id}/import`,
      await zipOf({
        'One.md': '# One\n\n![](assets/a.png)\n',
        'Two.md': '# Two\n\n![](assets/b.png)\n\n![](assets/c.png)\n',
        'assets/a.png': PNG,
        'assets/b.png': PNG,
        'assets/c.png': OTHER,
      }),
    )
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as { pages: { id: string; title: string }[]; duplicateAttachments: number; report?: unknown }
    assert.equal(body.duplicateAttachments, 1)
    assert.equal(body.report, undefined, '`report` stays the Notion importer\'s')
    const stored = await db.select().from(schema.files).where(eq(schema.files.workspaceId, ws.id))
    assert.equal(stored.length, 2, 'a.png and b.png share one row, c.png has its own')
    const newOnDisk = (await readdir(uploads)).filter((f) => !before.has(f))
    assert.equal(newOnDisk.length, 2)
    const byTitle = new Map(body.pages.map((p) => [p.title, p.id]))
    const one = await fileUrls(byTitle.get('One')!)
    const two = await fileUrls(byTitle.get('Two')!)
    assert.equal(one.length, 1)
    assert.equal(two.length, 2)
    assert.equal(two[0], one[0], 'b.png points at the representative stored for a.png')
    assert.notEqual(two[1], one[0])
  })

  it('Notion: one page from two export folders, its subpage under it, identical attachments once', async () => {
    const { ws, cookie } = await setup()
    const hp = 'aa11aa11aa11aa11aa11aa11aa11aa11'
    const hc = 'bb22bb22bb22bb22bb22bb22bb22bb22'
    const res = await post(
      cookie,
      `/api/workspaces/${ws.id}/import?source=notion`,
      await zipOf({
        [`Export-aaa/Plan ${hp}.md`]: `# Plan\n\nFirst copy. [Child](Plan%20${hp}/Child%20${hc}.md)\n\n![](Plan%20${hp}/pic.png)\n`,
        [`Export-aaa/Plan ${hp}/pic.png`]: PNG,
        [`Export-bbb/Plan ${hp}.md`]: '# Plan\n\nSecond copy of the same page.\n',
        [`Export-bbb/Plan ${hp}/Child ${hc}.md`]: '# Child\n\n![](pic2.png)\n',
        [`Export-bbb/Plan ${hp}/pic2.png`]: PNG,
      }),
    )
    assert.equal(res.statusCode, 200, res.body)
    const { pages: created, report } = res.json() as {
      pages: { id: string; title: string; kind: string; parentId: string | null }[]
      report: import('./notionImport').NotionImportReport
    }
    assert.deepEqual(report.merged, { pages: 1, attachments: 1 })
    assert.equal(report.attachments, 1)
    const rows = await db.select().from(schema.pages).where(inArray(schema.pages.id, created.map((p) => p.id)))
    const plans = rows.filter((r) => r.title === 'Plan')
    assert.equal(plans.length, 1, 'the same Notion page is imported once')
    const child = rows.find((r) => r.title === 'Child')!
    assert.equal(child.parentId, plans[0].id, 'the subpage found in the second folder sits under the kept page')
    const stored = await db.select().from(schema.files).where(eq(schema.files.workspaceId, ws.id))
    assert.equal(stored.length, 1)
    const planFiles = await fileUrls(plans[0].id)
    const childFiles = await fileUrls(child.id)
    assert.deepEqual(childFiles, planFiles)
    // The kept copy is the first by path (Export-aaa); its link to the child resolves.
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, plans[0].id))
    const text = JSON.stringify(stateToBlocks(d.state))
    assert.ok(text.includes('First copy'))
    assert.ok(text.includes(`/p/${child.id}`))
  })
})
