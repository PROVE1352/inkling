// Query block: person and relation fields of collection rows are shown as names and linked page titles,
// never as ids, and a linked row the viewer may not see is dropped (docs/adr/1320-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] query block person and relation cells', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const { registerQueryRoutes } = await import('../routes/query')
  const { resolveCellRefs } = await import('./cellRefs')

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(async (api) => registerQueryRoutes(api), { prefix: '/api' })
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('Olivia Owner')
  const member = await h.makeUser('Mina Member')
  const outsider = await h.makeUser('Oscar Outsider')
  const ws = await h.makeWorkspace(owner, [member])
  const tag = randomUUID().slice(0, 6)

  const page = async (values: Partial<typeof schema.pages.$inferInsert>) =>
    (
      await db
        .insert(schema.pages)
        .values({ workspaceId: ws.id, createdBy: owner.id, kind: 'doc', title: 'x', ...values })
        .returning()
    )[0]

  // Mina's private collection: Olivia cannot see it or its rows
  const secretColl = await page({ kind: 'collection', title: `Secret ${tag}`, createdBy: member.id, scope: 'private' })
  await db.insert(schema.collections).values({ pageId: secretColl.id, fields: [] })
  const secretRow = await page({ parentId: secretColl.id, title: 'SECRET hiring plan', createdBy: member.id, scope: 'private' })

  // another shared collection: a link into it through a field whose target is the roadmap is dropped
  const other = await page({ kind: 'collection', title: `Other ${tag}` })
  await db.insert(schema.collections).values({ pageId: other.id, fields: [] })
  const otherRow = await page({ parentId: other.id, title: 'Row of another collection' })

  const roadmap = await page({ kind: 'collection', title: `Roadmap ${tag}` })
  await db.insert(schema.collections).values({
    pageId: roadmap.id,
    fields: [
      { id: 'owner', name: 'Owner', type: 'person' },
      { id: 'blocked', name: 'Blocked by', type: 'relation', relation: { targetPageId: roadmap.id } },
      { id: 'notes', name: 'Notes', type: 'relation', relation: { targetPageId: secretColl.id } },
      { id: 'label', name: 'Label', type: 'text' },
    ],
  })
  const base = await page({ parentId: roadmap.id, title: 'Postgres migration', sortOrder: 1, props: { owner: owner.id } })
  const trashed = await page({ parentId: roadmap.id, title: 'Trashed row', sortOrder: 2, deletedAt: new Date() })
  const untitled = await page({ parentId: roadmap.id, title: '', sortOrder: 3 })
  await page({
    parentId: roadmap.id,
    title: 'Offline sync',
    sortOrder: 4,
    props: {
      owner: member.id,
      blocked: [base.id, trashed.id, otherRow.id, untitled.id, base.id],
      notes: [secretRow.id],
      // a text field that happens to hold an id is left alone
      label: member.id,
    },
  })
  // a person id of someone outside the workspace (the route refuses to store one; old data may hold it)
  await page({ parentId: roadmap.id, title: 'Outsider row', sortOrder: 5, props: { owner: outsider.id } })
  // a plain doc page with a free property of the same name keeps its value
  await page({ title: `Loose ${tag}`, properties: [{ name: 'Owner', value: 'Someone typed this' }] })

  const run = async (who: { cookie: string }, source: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/query`,
      headers: { cookie: who.cookie },
      payload: { source },
    })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as { columns: string[]; rows: { title: string; cells: unknown[] }[] }
  }
  const byTitle = (r: { rows: { title: string; cells: unknown[] }[] }) => new Map(r.rows.map((x) => [x.title, x.cells]))
  const ref = (p: { id: string }, title: string) => ({ ref: 'page', pageId: p.id, title })

  it('shows member names and visible linked rows, drops hidden, trashed and foreign links', async () => {
    const r = byTitle(await run(owner, `TABLE Owner, \`Blocked by\`, Notes, Label FROM "Roadmap ${tag}"`))
    assert.deepEqual(r.get('Postgres migration'), ['Olivia Owner', null, null, null])
    assert.deepEqual(r.get('Offline sync'), [
      'Mina Member',
      // trashed and other-collection links dropped, duplicates once, untitled kept with its empty title
      [ref(base, 'Postgres migration'), ref(untitled, '')],
      // Mina's private row: not its title, not its id
      [],
      member.id,
    ])
    // not a member: no name, and not the id either
    assert.deepEqual(r.get('Outsider row'), [null, null, null, null])
    assert.doesNotMatch(JSON.stringify(r.get('Offline sync')), new RegExp(`${secretRow.id}|SECRET|${trashed.id}|${otherRow.id}`))
  })

  it('the person who can see the linked row gets its title', async () => {
    const r = byTitle(await run(member, `TABLE Notes FROM "Roadmap ${tag}"`))
    assert.deepEqual(r.get('Offline sync'), [[ref(secretRow, 'SECRET hiring plan')]])
  })

  it('LIST <field> is resolved; expressions and file fields are not', async () => {
    const l = byTitle(await run(owner, `LIST Owner FROM "Roadmap ${tag}"`))
    assert.deepEqual(l.get('Offline sync'), ['Mina Member'])
    const t = byTitle(await run(owner, `TABLE file.name, Owner = "${member.id}", contains(\`Blocked by\`, "${base.id}") FROM "Roadmap ${tag}"`))
    // filters keep comparing stored values (ids): only the display changed
    assert.deepEqual(t.get('Offline sync'), ['Offline sync', true, true])
  })

  it('a free page property of the same name is left as typed', async () => {
    const r = byTitle(await run(owner, `TABLE Owner WHERE file.name = "Loose ${tag}"`))
    assert.deepEqual(r.get(`Loose ${tag}`), ['Someone typed this'])
  })

  it('resolves any number of rows with at most three statements', async () => {
    const rows = Array.from({ length: 300 }, () => ({
      parentId: roadmap.id,
      cells: [member.id, [base.id, untitled.id]] as unknown[],
    }))
    const statements = await resolveCellRefs(rows, ['Owner', 'Blocked by'], { workspaceId: ws.id, userId: owner.id })
    assert.equal(statements, 3)
    assert.deepEqual(rows[299].cells, ['Mina Member', [ref(base, 'Postgres migration'), ref(untitled, '')]])
    // nothing to resolve: no statement beyond the field lookup
    const none = [{ parentId: roadmap.id, cells: ['x'] as unknown[] }]
    assert.equal(await resolveCellRefs(none, ['Label'], { workspaceId: ws.id, userId: owner.id }), 1)
    assert.equal(await resolveCellRefs(none, [null], { workspaceId: ws.id, userId: owner.id }), 0)
  })

  it('a member who left is shown without a name', async () => {
    await db
      .delete(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, member.id)))
    try {
      const r = byTitle(await run(owner, `TABLE Owner FROM "Roadmap ${tag}" WHERE file.name = "Offline sync"`))
      assert.deepEqual(r.get('Offline sync'), [null])
    } finally {
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: member.id, role: 'member' })
    }
  })
})
