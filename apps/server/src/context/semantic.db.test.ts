// Optional semantic search with a database (docs/adr/1740-*–1745-*): indexing through a local fake
// /embeddings server, permissions (private pages, trash, other and deleted workspaces) on the cache
// and the SQL path, re-embedding only changed chunks, model change, failures that never block search
// or saves, the admin status, and find_context unchanged while the feature is off.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-semantic-${process.pid}`
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
for (const k of Object.keys(process.env)) if (k.startsWith('EMBEDDING_')) delete process.env[k]

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const KEY = 'sk-semantic-test-key-0123456789'

describe('[db] optional semantic search', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql, and } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('./chunkIndex')
  const { blocksToStateBuffer } = await import('../md/convert')
  type AnyBlock = import('../md/convert').AnyBlock
  const { resetSemanticConfigForTests } = await import('./semanticConfig')
  const { embeddingHealth, resetEmbeddingHealthForTests } = await import('./embeddings')
  const sem = await import('./semantic')
  const idx = await import('./semanticIndexer')
  const { startFakeEmbeddings } = await import('./semanticTestServer')

  const fake = await startFakeEmbeddings(64)
  const app = await h.buildTestApp()
  const statusApp = Fastify()

  const setEnv = (vars: Record<string, string>) => {
    for (const k of Object.keys(process.env)) if (k.startsWith('EMBEDDING_')) delete process.env[k]
    Object.assign(process.env, vars)
    resetSemanticConfigForTests()
    sem.resetSemanticCachesForTests()
    resetEmbeddingHealthForTests()
    idx.resetIndexerForTests()
  }
  const on = (extra: Record<string, string> = {}) =>
    setEnv({
      EMBEDDING_URL: fake.url,
      EMBEDDING_MODEL: 'fake-1',
      EMBEDDING_API_KEY: KEY,
      EMBEDDING_REQUESTS_PER_MINUTE: '6000',
      EMBEDDING_BATCH_SIZE: '4',
      EMBEDDING_QUERY_TIMEOUT_MS: '400',
      ...extra,
    })
  const off = () => setEnv({})

  after(async () => {
    off()
    await fake.close()
    await statusApp.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const P = (text: string): AnyBlock => ({ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }) as AnyBlock
  const H = (text: string): AnyBlock => ({ id: randomUUID(), type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }], children: [] }) as AnyBlock

  async function page(ws: string, by: string, title: string, blocks: AnyBlock[], extra: Partial<typeof schema.pages.$inferInsert> = {}) {
    const p = await h.makeDocPage(ws, by, title, blocks, extra)
    assert.equal(await reindexPageChunks(p.id, blocks, { log: false }), true)
    return p.id
  }
  async function setBody(pageId: string, blocks: AnyBlock[]) {
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks) }).where(eq(schema.pageDocs.pageId, pageId))
    assert.equal(await reindexPageChunks(pageId, blocks, { log: false }), true)
  }
  async function indexAll(ws: string[]) {
    let embedded = 0
    for (let i = 0; i < 100; i++) {
      const r = await idx.runSemanticIndexPass(undefined, ws)
      embedded += r.embedded
      if (!r.more) return embedded
      if (r.embedded === 0 && embeddingHealth.backoffUntil > Date.now()) return embedded
    }
    throw new Error('indexer did not settle')
  }
  async function vectorCount(ws: string, model?: string) {
    const [r] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM page_chunk_vectors WHERE workspace_id = ${ws} ${model ? sql`AND model = ${model}` : sql``}
    `)) as unknown as { n: number }[]
    return r.n
  }
  async function liveChunkCount(ws: string) {
    const [r] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM page_chunks c JOIN pages p ON p.id = c.page_id WHERE c.workspace_id = ${ws} AND p.deleted_at IS NULL
    `)) as unknown as { n: number }[]
    return r.n
  }

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let member: Awaited<ReturnType<typeof h.makeUser>>
  let outsider: Awaited<ReturnType<typeof h.makeUser>>
  let admin: Awaited<ReturnType<typeof h.makeUser>>
  let A: string, B: string, C: string
  let pubA: string, privA: string, trashA: string, pubB: string, delC: string
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  const runbook = () => [
    P('How we ship the service.'),
    H('Rollback'),
    P('If a deploy fails, roll back to the previous image. rollback zebra'),
    H('Team checklist'),
    P('Who brings the laptop, who submits the signup form, who presents.'),
  ]
  let baseline = ''
  const findContextText = async () => (await mcp.tool('find_context', { query: 'rollback zebra checklist', workspaceId: A })).text

  before(async () => {
    off()
    owner = await h.makeUser('sem-owner')
    member = await h.makeUser('sem-member')
    outsider = await h.makeUser('sem-outsider')
    admin = await h.makeUser('sem-admin')
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin.id))
    A = (await h.makeWorkspace(owner, [member])).id
    B = (await h.makeWorkspace(outsider)).id
    C = (await h.makeWorkspace(owner, [member])).id
    pubA = await page(A, owner.id, 'Deploy runbook', runbook())
    privA = await page(A, owner.id, 'Owner notes', [P('rollback zebra private plan of the owner')], { scope: 'private' })
    trashA = await page(A, owner.id, 'Old runbook', [P('rollback zebra trashed copy')])
    pubB = await page(B, outsider.id, 'Other team', [P('rollback zebra in a workspace the member is not in')])
    delC = await page(C, owner.id, 'Deleted workspace page', [P('rollback zebra in a deleted workspace')])
    await db.update(schema.workspaces).set({ deletedAt: new Date() }).where(eq(schema.workspaces.id, C))
    mcp = await h.connectMcp(app, member, await h.mintToken(member))

    statusApp.register(import('@fastify/cookie'))
    statusApp.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
    })
    statusApp.register(async (api) => (await import('../routes/admin')).registerAdminRoutes(api), { prefix: '/api' })
    await statusApp.ready()
  })

  it('off: semanticCandidates is null without a request or a query; find_context baseline', async () => {
    off()
    const before = { req: fake.requests.length, q: sem.semanticStats.dbQueries }
    const r = await sem.semanticCandidates({ workspaceIds: [A], query: 'rollback', limit: 5, userId: member.id })
    assert.equal(r, null)
    assert.equal(fake.requests.length, before.req)
    assert.equal(sem.semanticStats.dbQueries, before.q)
    assert.equal(await vectorCount(A), 0)
    baseline = await findContextText()
    assert.match(baseline, /Deploy runbook/)
  })

  it('on: embeds every live chunk once (with the key), skips deleted workspaces; JS and SQL hashes agree', async () => {
    on()
    const n0 = fake.requests.length
    const embedded = await indexAll([A, B, C])
    const chunksA = await liveChunkCount(A)
    assert.equal(await vectorCount(A), chunksA)
    assert.equal(await vectorCount(B), 1)
    assert.equal(await vectorCount(C), 0, 'a deleted workspace is not embedded')
    assert.equal(embedded, chunksA + 1)
    const sent = fake.requests.slice(n0)
    assert.ok(sent.length >= Math.ceil(embedded / 4))
    assert.ok(sent.every((r) => r.auth === `Bearer ${KEY}` && r.model === 'fake-1' && r.inputs.length <= 4))
    assert.ok(sent.some((r) => r.inputs.some((i) => i.startsWith('Deploy runbook\nRollback\n'))), 'title + heading path + text')
    // nothing left: the hash written from Node equals the SQL hash the pending scan computes
    const n1 = fake.requests.length
    assert.equal(await indexAll([A, B, C]), 0)
    assert.equal(fake.requests.length, n1)
    // stored vectors are unit length real[] with model and dims
    const [row] = (await db.execute(sql`
      SELECT model, dims, array_length(embedding, 1) AS len, (SELECT sum(x * x) FROM unnest(embedding) x) AS norm
        FROM page_chunk_vectors WHERE page_id = ${pubA} LIMIT 1
    `)) as unknown as { model: string; dims: number; len: number; norm: number }[]
    assert.equal(row.model, 'fake-1')
    assert.equal(row.dims, 64)
    assert.equal(row.len, 64)
    assert.ok(Math.abs(Number(row.norm) - 1) < 1e-4)
  })

  async function assertPermissions() {
    const ids = (r: { pageId: string }[] | null) => new Set((r ?? []).map((x) => x.pageId))
    // the member asks every workspace id it can name, including ones it may not see
    const m = await sem.semanticCandidates({ workspaceIds: [A, B, C], query: 'rollback zebra', limit: 20, userId: member.id })
    assert.ok(m, 'on: an answer, not null')
    const mi = ids(m)
    assert.ok(mi.has(pubA), 'shared page found')
    assert.ok(!mi.has(privA), "another person's private page never appears")
    assert.ok(!mi.has(trashA), 'a page in the trash never appears')
    assert.ok(!mi.has(pubB), 'a workspace the member is not in never appears')
    assert.ok(!mi.has(delC), 'a deleted workspace never appears')
    const o = ids(await sem.semanticCandidates({ workspaceIds: [A, C], query: 'rollback zebra', limit: 20, userId: owner.id }))
    assert.ok(o.has(privA), 'the author sees the private page')
    assert.ok(!o.has(trashA) && !o.has(delC))
    assert.deepEqual(await sem.semanticCandidates({ workspaceIds: [A], query: 'rollback zebra', limit: 20, userId: outsider.id }), [])
    assert.deepEqual([...ids(await sem.semanticCandidates({ workspaceIds: [B], query: 'rollback zebra', limit: 20, userId: outsider.id }))], [pubB])
    // garbage ids are ignored, not an error
    assert.deepEqual(await sem.semanticCandidates({ workspaceIds: ['nope'], query: 'rollback', limit: 5, userId: member.id }), [])
  }

  it('permissions: private pages, trash, other and deleted workspaces never leak (vector cache)', async () => {
    on()
    await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, trashA))
    const scans = sem.semanticStats.sqlScans
    await assertPermissions()
    assert.equal(sem.semanticStats.sqlScans, scans, 'answered from the cache')
    assert.ok(sem.semanticStats.cacheLoads > 0)
  })

  it('permissions: the same on the SQL path (workspace larger than the cache)', async () => {
    on({ EMBEDDING_CACHE_MB: '0' })
    const scans = sem.semanticStats.sqlScans
    await assertPermissions()
    assert.ok(sem.semanticStats.sqlScans > scans, 'scored in SQL')
  })

  it('one row per section with its best score, highest first; a Korean query finds the English checklist', async () => {
    on()
    const r = (await sem.semanticCandidates({ workspaceIds: [A], query: '팀 체크리스트', limit: 3, userId: member.id }))!
    assert.equal(r[0].pageId, pubA)
    assert.equal(r[0].anchor, 'team-checklist')
    const keys = r.map((x) => `${x.pageId}#${x.anchor}`)
    assert.equal(new Set(keys).size, keys.length)
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score)
    assert.equal((await sem.semanticCandidates({ workspaceIds: [A], query: 'rollback', limit: 1, userId: member.id }))!.length, 1)
  })

  it('only changed chunks are embedded again; a new section does not re-embed the ones after it', async () => {
    on()
    const blocks = runbook()
    ;(blocks[2].content as { text: string }[])[0].text = 'If a deploy fails, restore the previous image from the registry. walrus'
    await setBody(pubA, blocks)
    let n0 = fake.requests.length
    assert.equal(await indexAll([A]), 1)
    let inputs = fake.requests.slice(n0).flatMap((r) => r.inputs)
    assert.deepEqual(inputs.length, 1)
    assert.match(inputs[0], /walrus/)
    // a section inserted at the top shifts every position; only its own chunk is new
    await setBody(pubA, [H('Contacts'), P('On call: the platform team.'), ...blocks])
    n0 = fake.requests.length
    assert.equal(await indexAll([A]), 1)
    inputs = fake.requests.slice(n0).flatMap((r) => r.inputs)
    assert.equal(inputs.length, 1)
    assert.match(inputs[0], /On call/)
    // the edited section's new text is what search sees
    const r = (await sem.semanticCandidates({ workspaceIds: [A], query: 'walrus registry', limit: 1, userId: member.id }))!
    assert.deepEqual(r.map((x) => [x.pageId, x.anchor]), [[pubA, 'rollback']])
    // the old vectors (edited rollback text, and the intro that became part of "Contacts") are
    // collected, also when more stale rows than one clean-up batch exist (here: 4,500 elsewhere)
    const { chunkTextHash } = sem
    const oldRollback = chunkTextHash('Deploy runbook', 'Rollback', 'If a deploy fails, roll back to the previous image. rollback zebra')
    const oldIntro = chunkTextHash('Deploy runbook', '', 'How we ship the service.')
    const has = async (hash: string) =>
      ((await db.execute(sql`SELECT 1 FROM page_chunk_vectors WHERE page_id = ${pubA} AND text_hash = ${hash}`)) as unknown as unknown[]).length === 1
    assert.ok((await has(oldRollback)) && (await has(oldIntro)), 'stale vectors exist before the clean-up')
    await db.execute(sql`
      INSERT INTO page_chunk_vectors (page_id, text_hash, workspace_id, model, dims, embedding)
      SELECT ${pubB}::uuid, md5('bogus' || g), ${B}::uuid, 'fake-1', 2, '{0.6,0.8}'::real[] FROM generate_series(1, 4500) g
    `)
    const before = await vectorCount(A)
    const deleted = await idx.collectStaleVectors()
    assert.ok(deleted >= 4_502, `deleted ${deleted}`)
    assert.ok(!(await has(oldRollback)) && !(await has(oldIntro)), 'stale vectors of A are gone')
    assert.equal(await vectorCount(A), before - 2)
    assert.equal(await vectorCount(B), 1, 'the current vector of the other workspace stays')
    assert.equal(await indexAll([A]), 0)
  })

  it('a model change embeds everything again and old vectors are not served', async () => {
    on({ EMBEDDING_MODEL: 'fake-2' })
    const st = (await sem.semanticStatus())!
    assert.ok(st.sections.pending > 0)
    assert.equal(st.model, 'fake-2')
    const live = await liveChunkCount(A)
    assert.equal(await indexAll([A]), live)
    assert.equal(await vectorCount(A, 'fake-2'), live)
    // two sections with the same heading and text share one vector; in small clean-up batches every
    // old-model row still goes (the batch must not count that vector twice and stop early)
    const twin = await page(A, owner.id, 'Twins', [H('Same'), P('identical text'), H('Same'), P('identical text')])
    await db.execute(sql`
      INSERT INTO page_chunk_vectors (page_id, text_hash, workspace_id, model, dims, embedding)
      VALUES (${twin}::uuid, ${sem.chunkTextHash('Twins', 'Same', 'identical text')}, ${A}::uuid, 'fake-1', 2, '{0.6,0.8}'::real[])
    `)
    // re-embedding replaced A's live rows in place (one row per chunk text); left with the old model:
    // the twin row and the trashed page's vector (pages in the trash are not embedded)
    assert.equal(await vectorCount(A, 'fake-1'), 2)
    await db.execute(sql`
      INSERT INTO page_chunk_vectors (page_id, text_hash, workspace_id, model, dims, embedding)
      SELECT ${pubA}::uuid, md5('old model ' || g), ${A}::uuid, 'fake-1', 2, '{0.6,0.8}'::real[] FROM generate_series(1, 5) g
    `)
    assert.ok((await idx.collectStaleVectors(2)) >= 6)
    const [left] = (await db.execute(sql`SELECT count(*)::int AS n FROM page_chunk_vectors WHERE model <> 'fake-2'`)) as unknown as { n: number }[]
    assert.equal(left.n, 0, 'no vector of another model is left anywhere')
    await db.delete(schema.pages).where(eq(schema.pages.id, twin))
    assert.equal(fake.requests.at(-1)!.model, 'fake-2')
  })

  it('failures never block search or saves: timeout → null, backoff, no repeated requests, key never shown', async () => {
    on({ EMBEDDING_MODEL: 'fake-2' })
    fake.mode = 'hang'
    let t0 = Date.now()
    assert.equal(await sem.semanticCandidates({ workspaceIds: [A], query: 'a brand new question', limit: 5, userId: member.id }), null)
    assert.ok(Date.now() - t0 < 2_000, 'bounded by EMBEDDING_QUERY_TIMEOUT_MS')
    assert.ok(embeddingHealth.backoffUntil > Date.now())
    assert.match(embeddingHealth.lastError!.message, /timeout/)
    // while backing off: no request at all, immediate null, the indexer waits
    const n0 = fake.requests.length
    t0 = Date.now()
    assert.equal(await sem.semanticCandidates({ workspaceIds: [A], query: 'another question', limit: 5, userId: member.id }), null)
    assert.ok(Date.now() - t0 < 300)
    assert.deepEqual(await idx.runSemanticIndexPass(undefined, [A]), { embedded: 0, more: true })
    assert.equal(fake.requests.length, n0)
    // saving and reindexing do not wait for the endpoint
    t0 = Date.now()
    await setBody(pubA, [...runbook(), H('New'), P('written while the endpoint hangs')])
    assert.ok(Date.now() - t0 < 2_000)
    // a provider that echoes the key: the status never shows it
    fake.mode = 'echoKey401'
    embeddingHealth.backoffUntil = 0
    assert.equal((await idx.runSemanticIndexPass(undefined, [A])).embedded, 0)
    assert.match(embeddingHealth.lastError!.message, /HTTP 401/)
    assert.doesNotMatch(JSON.stringify(await sem.semanticStatus()), new RegExp(KEY))
    // back to normal once the backoff is over
    fake.mode = 'ok'
    embeddingHealth.backoffUntil = 0
    assert.ok((await indexAll([A])) >= 1)
    assert.ok(await sem.semanticCandidates({ workspaceIds: [A], query: 'endpoint hangs', limit: 5, userId: member.id }))
  })

  it('a chunk the endpoint refuses is retried alone, then skipped; its neighbours are embedded', async () => {
    on({ EMBEDDING_MODEL: 'fake-2' })
    fake.rejectIf = (i) => i.includes('POISON')
    try {
      const id = await page(A, owner.id, 'Mixed page', [H('One'), P('fine text one'), H('Two'), P('POISON chunk'), H('Three'), P('fine text three')])
      await indexAll([A])
      await indexAll([A])
      const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM page_chunk_vectors WHERE page_id = ${id}`)) as unknown as { n: number }[]
      assert.equal(r.n, 2)
      assert.equal(embeddingHealth.backoffUntil, 0, 'a refused input does not back the endpoint off')
      assert.equal((await sem.semanticStatus())!.chunks.rejected, 1)
    } finally {
      fake.rejectIf = null
    }
  })

  it('admin status: a `semantic` block only while on, counts and errors, never the key', async () => {
    const get = () => statusApp.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie: admin.cookie } })
    off()
    let res = await get()
    assert.equal(res.statusCode, 200, res.body)
    assert.equal('semantic' in res.json(), false)
    on({ EMBEDDING_MODEL: 'fake-2' })
    embeddingHealth.lastError = { at: new Date().toISOString(), message: 'example failure' }
    res = await get()
    assert.equal(res.statusCode, 200, res.body)
    const s = res.json().semantic
    assert.equal(s.enabled, true)
    assert.equal(s.model, 'fake-2')
    assert.equal(s.endpoint, `${fake.url}/embeddings`)
    assert.equal(typeof s.sections.indexed, 'number')
    assert.equal(typeof s.sections.pending, 'number')
    assert.equal(s.lastError.message, 'example failure')
    assert.ok(!res.body.includes(KEY), 'the API key is never in the response')
    // members are refused like before
    const m = await statusApp.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie: member.cookie } })
    assert.equal(m.statusCode, 403)
  })

  it('off again: find_context output is byte-identical with the vectors table full; nothing runs', async () => {
    off()
    assert.ok((await vectorCount(A)) > 0)
    // undo this suite's edits to the runbook so the documents equal the baseline's
    await setBody(pubA, runbook())
    await db.update(schema.pages).set({ deletedAt: null }).where(eq(schema.pages.id, trashA))
    await db.delete(schema.pages).where(and(eq(schema.pages.workspaceId, A), eq(schema.pages.title, 'Mixed page')))
    const n0 = fake.requests.length
    const q0 = sem.semanticStats.dbQueries
    assert.equal(await findContextText(), baseline)
    assert.equal(await sem.semanticCandidates({ workspaceIds: [A], query: 'rollback', limit: 5, userId: member.id }), null)
    assert.equal(fake.requests.length, n0)
    assert.equal(sem.semanticStats.dbQueries, q0)
  })
})
