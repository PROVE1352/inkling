// Query block: WHERE and SORT on a person field use the member's name, on a relation field the titles
// of the linked rows the viewer may see; stored ids still match for queries written before
// (docs/adr/1352-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] query block compares people by name and relations by title', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const Fastify = (await import('fastify')).default
  const { AppError } = await import('../errors')
  const { registerQueryRoutes } = await import('../routes/query')

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

  // Two members whose id order is the opposite of their name order: "Adam" has the larger id.
  const a = await h.makeUser('m1')
  const b = await h.makeUser('m2')
  const [lo, hi] = a.id < b.id ? [a, b] : [b, a]
  await db.update(schema.users).set({ name: 'Zoe Zed' }).where(eq(schema.users.id, lo.id))
  await db.update(schema.users).set({ name: 'Adam Ant' }).where(eq(schema.users.id, hi.id))
  const outsider = await h.makeUser('Oscar Outsider')
  const ws = await h.makeWorkspace(lo, [hi])
  const tag = randomUUID().slice(0, 6)

  const page = async (values: Partial<typeof schema.pages.$inferInsert>) =>
    (
      await db
        .insert(schema.pages)
        .values({ workspaceId: ws.id, createdBy: lo.id, kind: 'doc', title: 'x', ...values })
        .returning()
    )[0]

  // Adam's private collection: Zoe cannot see it or its rows
  const secretColl = await page({ kind: 'collection', title: `Secret ${tag}`, createdBy: hi.id, scope: 'private' })
  await db.insert(schema.collections).values({ pageId: secretColl.id, fields: [] })
  const secretRow = await page({ parentId: secretColl.id, title: 'AAA secret plan', createdBy: hi.id, scope: 'private' })

  const coll = await page({ kind: 'collection', title: `Board ${tag}` })
  await db.insert(schema.collections).values({
    pageId: coll.id,
    fields: [
      { id: 'owner', name: 'Owner', type: 'person' },
      { id: 'blocked', name: 'Blocked by', type: 'relation', relation: { targetPageId: coll.id } },
      { id: 'notes', name: 'Notes', type: 'relation', relation: { targetPageId: secretColl.id } },
    ],
  })
  const alpha = await page({ parentId: coll.id, title: 'Alpha', sortOrder: 1, props: { owner: lo.id } })
  const bravo = await page({ parentId: coll.id, title: 'Bravo', sortOrder: 2, props: { owner: hi.id } })
  const charlie = await page({ parentId: coll.id, title: 'Charlie', sortOrder: 3, props: { blocked: [bravo.id] } })
  await page({ parentId: coll.id, title: 'Delta', sortOrder: 4, props: { owner: outsider.id, blocked: [alpha.id] } })
  // Yankee links only to the hidden row, Zulu to nothing: for Zoe both are empty, so they sort by title
  await page({ parentId: coll.id, title: 'Zulu', sortOrder: 5, props: { notes: [secretRow.id] } })
  await page({ parentId: coll.id, title: 'Yankee', sortOrder: 6, props: { notes: [] } })
  void charlie

  const titles = async (who: { cookie: string }, rest: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/query`,
      headers: { cookie: who.cookie },
      payload: { source: `LIST FROM "Board ${tag}" ${rest}` },
    })
    assert.equal(res.statusCode, 200, res.body)
    return (res.json() as { rows: { title: string }[] }).rows.map((r) => r.title)
  }

  it('SORT on a person orders by the member name, empty and non-members last', async () => {
    assert.deepEqual(await titles(lo, 'SORT Owner'), ['Bravo', 'Alpha', 'Charlie', 'Delta', 'Yankee', 'Zulu'])
    assert.deepEqual(await titles(lo, 'SORT Owner DESC'), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Yankee', 'Zulu'])
  })

  it('WHERE on a person matches the name, and still the stored id of a member', async () => {
    assert.deepEqual(await titles(lo, 'WHERE Owner = "Adam Ant"'), ['Bravo'])
    assert.deepEqual(await titles(lo, `WHERE Owner = "${hi.id}"`), ['Bravo'])
    assert.deepEqual(await titles(lo, 'WHERE Owner != "Adam Ant" AND Owner'), ['Alpha'])
    assert.deepEqual(await titles(lo, 'WHERE Owner >= "B"'), ['Alpha'])
    assert.deepEqual(await titles(lo, 'WHERE contains(Owner, "Ant")'), ['Bravo'])
    // case-sensitive like select labels
    assert.deepEqual(await titles(lo, 'WHERE Owner = "adam ant"'), [])
  })

  it('a non-member is neither a name nor a match', async () => {
    assert.deepEqual(await titles(lo, 'WHERE Owner = "Oscar Outsider"'), [])
    assert.deepEqual(await titles(lo, `WHERE Owner = "${outsider.id}"`), [])
  })

  it('relations compare and sort by the titles of linked rows', async () => {
    assert.deepEqual(await titles(lo, 'WHERE `Blocked by` = "Bravo"'), ['Charlie'])
    assert.deepEqual(await titles(lo, `WHERE contains(\`Blocked by\`, "${bravo.id}")`), ['Charlie'])
    assert.deepEqual(await titles(lo, 'WHERE contains(`Blocked by`, "Alpha")'), ['Delta'])
    assert.deepEqual(await titles(lo, 'WHERE `Blocked by` SORT `Blocked by`'), ['Delta', 'Charlie'])
    assert.deepEqual(await titles(lo, 'WHERE `Blocked by` SORT `Blocked by` DESC'), ['Charlie', 'Delta'])
  })

  it('a linked row the viewer cannot see neither matches nor moves the order', async () => {
    assert.deepEqual(await titles(lo, 'WHERE Notes = "AAA secret plan"'), [])
    assert.deepEqual(await titles(lo, `WHERE contains(Notes, "${secretRow.id}")`), [])
    assert.deepEqual(await titles(lo, 'WHERE Notes'), [])
    // empty for Zoe on both rows → title order (Yankee before Zulu); with the hidden title Zulu would lead
    assert.deepEqual((await titles(lo, 'SORT Notes')).slice(-2), ['Yankee', 'Zulu'])
    // the author sees it
    assert.deepEqual(await titles(hi, 'WHERE Notes = "AAA secret plan"'), ['Zulu'])
    assert.deepEqual((await titles(hi, 'SORT Notes'))[0], 'Zulu')
  })
})
