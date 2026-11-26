// A connection limited to a subtree (docs/adr/1200-*) and files without a page in the zip export
// (0.25.4, follow-up of sec26 D-3): GET /files/:id and its meta refuse such a file to a subtree range,
// so the zip of a page in that range must not carry it either when the page body names /files/<id>.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-export-range-'))
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] zip export, files without a page and a subtree range', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const collab = await import('../collab')
  const JSZip = (await import('jszip')).default
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: { message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/apiTokens')).registerApiTokenRoutes(api)
      await (await import('../routes/exportImport')).registerExportImportRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('xr-owner')
  const ws = await h.makeWorkspace(owner)
  async function file(pageId: string | null, body: string) {
    const [row] = await db
      .insert(schema.files)
      .values({ workspaceId: ws.id, pageId, name: `${body}.png`, mime: 'image/png', size: body.length, createdBy: owner.id })
      .returning({ id: schema.files.id })
    writeFileSync(path.join(process.env.DATA_DIR!, 'uploads', row.id), body)
    return row.id
  }
  const root = await h.makeDocPage(ws.id, owner.id, 'Root', [] as never)
  const legacy = await file(null, 'legacy-secret')
  const own = await file(root.id, 'in-range')
  const img = (id: string) => ({ type: 'image', props: { url: `/files/${id}` } })
  await db.delete(schema.pageDocs).where((await import('drizzle-orm')).eq(schema.pageDocs.pageId, root.id))
  const { blocksToStateBuffer } = await import('./convert')
  await db.insert(schema.pageDocs).values({ pageId: root.id, state: blocksToStateBuffer([img(legacy), img(own)] as never) })

  async function token(range: 'subtree' | null) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: owner.cookie },
      payload: { name: 'export', expiresInDays: 30, access: 'read', range: range ? { kind: 'subtree', pageId: root.id } : { kind: 'all' } },
    })
    assert.equal(res.statusCode, 201, res.body)
    return (res.json() as { secret: string }).secret
  }
  const assetsOf = async (t: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/pages/${root.id}/export?format=zip`, headers: { authorization: `Bearer ${t}` } })
    assert.equal(r.statusCode, 200, r.body.slice(0, 300))
    const zip = await JSZip.loadAsync(r.rawPayload)
    return Object.keys(zip.files).filter((n) => n.startsWith('assets/'))
  }

  it('a subtree token exports the page without the file that has no page; other tokens keep it', async () => {
    const sub = await assetsOf(await token('subtree'))
    assert.ok(sub.some((n) => n.includes(own)), `the page's own file stays: ${sub}`)
    assert.ok(!sub.some((n) => n.includes(legacy)), `no file without a page: ${sub}`)
    const all = await assetsOf(await token(null))
    assert.ok(all.some((n) => n.includes(legacy)) && all.some((n) => n.includes(own)), String(all))
  })
})
