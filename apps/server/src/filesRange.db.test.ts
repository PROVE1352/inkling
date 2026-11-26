// A connection limited to a subtree (docs/adr/1200-*) and files without a page (0.25.4, sec26 D-3). Legacy
// files belong to the whole workspace, so /files/:id/meta already refused them to a subtree range; the
// download itself did not, and a range-limited token read them with GET /files/:id.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-files-range-'))
mkdirSync(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true })

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] files without a page and a subtree range (sec26 D-3)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const collab = await import('./collab')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('./errors')
  // personal API tokens are not in the shared harness: a small app with them and the file routes
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: { message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./routes/apiTokens')).registerApiTokenRoutes(api)
      await (await import('./routes/files')).registerFileRoutes(api)
    },
    { prefix: '/api' },
  )
  await (await import('./routes/files')).registerFileDownloadRoute(app)
  await app.ready()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('fr-owner')
  const ws = await h.makeWorkspace(owner)
  const root = await h.makeDocPage(ws.id, owner.id, 'Root', [] as never)
  const outside = await h.makeDocPage(ws.id, owner.id, 'Outside', [] as never)
  async function file(pageId: string | null, body: string) {
    const [row] = await db
      .insert(schema.files)
      .values({ workspaceId: ws.id, pageId, name: `${body}.txt`, mime: 'text/plain', size: body.length, createdBy: owner.id })
      .returning({ id: schema.files.id })
    writeFileSync(path.join(process.env.DATA_DIR!, 'uploads', row.id), body)
    return row.id
  }
  const legacy = await file(null, 'legacy-secret')
  const inRange = await file(root.id, 'in-range')
  const outOfRange = await file(outside.id, 'out-of-range')

  /** A personal API token (REST), limited to the Root subtree or not. */
  async function token(range: 'subtree' | null) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: owner.cookie },
      payload: { name: 'files', expiresInDays: 30, access: 'read', range: range ? { kind: 'subtree', pageId: root.id } : { kind: 'all' } },
    })
    assert.equal(res.statusCode, 201, res.body)
    return (res.json() as { secret: string }).secret
  }
  const get = (t: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } })

  it('a subtree token gets neither the meta nor the bytes of a file without a page', async () => {
    const t = await token('subtree')
    const meta = await get(t, `/api/files/${legacy}/meta`)
    const dl = await get(t, `/files/${legacy}`)
    console.log(`[D-3] subtree token, legacy file: meta ${meta.statusCode}, download ${dl.statusCode} ${dl.statusCode === 200 ? JSON.stringify(dl.body) : ''}`)
    assert.equal(meta.statusCode, 403)
    assert.equal(dl.statusCode, 403, 'the download is refused like the meta')
    assert.ok(!dl.body.includes('legacy-secret'))
  })

  it('the same token still reads a file of a page in its subtree, and not one outside', async () => {
    const t = await token('subtree')
    const ok = await get(t, `/files/${inRange}`)
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.body, 'in-range')
    assert.equal((await get(t, `/files/${outOfRange}`)).statusCode, 404)
  })

  it('a token without a range and the session still read the legacy file', async () => {
    const t = await token(null)
    const dl = await get(t, `/files/${legacy}`)
    assert.equal(dl.statusCode, 200)
    assert.equal(dl.body, 'legacy-secret')
    const viaCookie = await app.inject({ method: 'GET', url: `/files/${legacy}`, headers: { cookie: owner.cookie } })
    assert.equal(viaCookie.statusCode, 200)
  })
})
