// PUT /pages/:id/collection/fields when the list holds a relation to a collection the editor cannot
// see (another member's private collection): fields left as they were pass, only a new or changed
// relation needs a target the editor can see, and a hidden target answers like a missing one
// (docs/adr/1353-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import type { CollectionField } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] collection fields: relations to a collection the editor cannot see', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const owner = await h.makeUser('owner')
  const sam = await h.makeUser('sam')
  const ws = await h.makeWorkspace(owner, [sam])

  const req = (who: { cookie: string }, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: who.cookie }, payload: payload as object })
  const makeColl = async (who: { id: string; cookie: string }, title: string, scope: 'shared' | 'private' = 'shared') => {
    const res = await req(who, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title, scope })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().page.id as string
  }
  const fieldsOf = async (who: { cookie: string }, id: string) => {
    const res = await req(who, 'GET', `/pages/${id}/collection`)
    assert.equal(res.statusCode, 200, res.body)
    return res.json().collection.fields as CollectionField[]
  }
  const put = (who: { cookie: string }, id: string, fields: CollectionField[]) =>
    req(who, 'PUT', `/pages/${id}/collection/fields`, { fields })

  const roadmap = await makeColl(owner, 'Roadmap')
  const priv = await makeColl(sam, 'Sam private notes', 'private')
  assert.equal((await put(sam, priv, [{ id: 'mood', name: 'Mood', type: 'text' }])).statusCode, 200)
  assert.equal((await put(owner, roadmap, [{ id: 'status', name: 'Status', type: 'text' }])).statusCode, 200)

  // Sam (who can see both) adds a relation into the private collection and two rollups over it
  {
    const cur = await fieldsOf(sam, roadmap)
    const res = await put(sam, roadmap, [
      ...cur,
      { id: 'notes', name: 'Notes', type: 'relation', relation: { targetPageId: priv } },
      { id: 'nnotes', name: 'Note count', type: 'rollup', rollup: { relationFieldId: 'notes', targetFieldId: 'title', fn: 'count' } },
      { id: 'moods', name: 'Moods', type: 'rollup', rollup: { relationFieldId: 'notes', targetFieldId: 'mood', fn: 'showUnique' } },
    ] as CollectionField[])
    assert.equal(res.statusCode, 200, res.body)
  }

  it('the owner can still edit the schema: unchanged fields with a hidden target pass', async () => {
    const cur = await fieldsOf(owner, roadmap)
    assert.ok(cur.some((f) => f.id === 'notes'))
    const res = await put(owner, roadmap, [...cur, { id: 'due', name: 'Due', type: 'date' }])
    assert.equal(res.statusCode, 200, res.body)
    const after = await fieldsOf(owner, roadmap)
    assert.deepEqual(
      after.map((f) => f.id),
      ['status', 'notes', 'nnotes', 'moods', 'due'],
    )
    assert.deepEqual(after.find((f) => f.id === 'notes')?.relation, { targetPageId: priv })
    // renaming a field with a hidden target is not a change of target
    const renamed = after.map((f) => (f.id === 'notes' ? { ...f, name: 'Sam notes' } : f))
    assert.equal((await put(owner, roadmap, renamed)).statusCode, 200)
  })

  it('a new relation to a hidden collection answers exactly like one to a missing collection', async () => {
    const cur = await fieldsOf(owner, roadmap)
    const hidden = await put(owner, roadmap, [...cur, { id: 'x1', name: 'X', type: 'relation', relation: { targetPageId: priv } }])
    const missing = await put(owner, roadmap, [...cur, { id: 'x1', name: 'X', type: 'relation', relation: { targetPageId: randomUUID() } }])
    assert.equal(hidden.statusCode, 400, hidden.body)
    assert.equal(missing.statusCode, 400, missing.body)
    assert.deepEqual(hidden.json(), missing.json())
  })

  it('re-targeting, switching to two-way or re-using the id for another target is checked', async () => {
    const cur = await fieldsOf(owner, roadmap)
    const other = await makeColl(owner, 'Other')
    const missing = (await put(owner, roadmap, [...cur, { id: 'x2', name: 'X', type: 'relation', relation: { targetPageId: randomUUID() } }])).json()
    // a field that pointed at a visible collection now points at the hidden one
    const withOther = [...cur, { id: 'o', name: 'O', type: 'relation', relation: { targetPageId: other } }] as CollectionField[]
    assert.equal((await put(owner, roadmap, withOther)).statusCode, 200)
    const retarget = await put(owner, roadmap, withOther.map((f) => (f.id === 'o' ? { ...f, relation: { targetPageId: priv } } : f)))
    assert.equal(retarget.statusCode, 400)
    assert.deepEqual(retarget.json(), missing)
    // two-way would add a field to the hidden collection
    const twoWay = await put(owner, roadmap, cur.map((f) => (f.id === 'notes' ? { ...f, relation: { targetPageId: priv, twoWay: true } } : f)))
    assert.equal(twoWay.statusCode, 400)
    assert.deepEqual(twoWay.json(), missing)
    // nothing was written to Sam's collection
    assert.deepEqual((await fieldsOf(sam, priv)).map((f) => f.id), ['mood'])
  })

  it('a changed rollup over the hidden relation is still checked', async () => {
    const cur = await fieldsOf(owner, roadmap)
    const res = await put(owner, roadmap, cur.map((f) => (f.id === 'moods' ? { ...f, rollup: { ...f.rollup!, targetFieldId: 'nope' } } : f)))
    assert.equal(res.statusCode, 400, res.body)
    // and a new one too
    const res2 = await put(owner, roadmap, [
      ...cur,
      { id: 'r9', name: 'R', type: 'rollup', rollup: { relationFieldId: 'notes', targetFieldId: 'mood', fn: 'showUnique' } },
    ] as CollectionField[])
    assert.equal(res2.statusCode, 400, res2.body)
  })

  it('a two-way relation into the hidden collection: kept as is, and removable', async () => {
    const cur = await fieldsOf(sam, roadmap)
    const res = await put(sam, roadmap, [...cur, { id: 'tw', name: 'Linked', type: 'relation', relation: { targetPageId: priv, twoWay: true } }])
    assert.equal(res.statusCode, 200, res.body)
    const tw = (await fieldsOf(owner, roadmap)).find((f) => f.id === 'tw')!
    const pair = tw.relation!.pairFieldId!
    assert.ok(pair)
    // unchanged (pair id included): passes
    const mine = await fieldsOf(owner, roadmap)
    assert.equal((await put(owner, roadmap, mine)).statusCode, 200)
    // the pair id dropped would mean a new partner field in the hidden collection: refused
    const repair = await put(owner, roadmap, mine.map((f) => (f.id === 'tw' ? { ...f, relation: { targetPageId: priv, twoWay: true } } : f)))
    assert.equal(repair.statusCode, 400)
    // removing it turns the partner in Sam's collection into a one-way relation (non-destructive), as
    // for a visible target: the edit lock is the only check on the partner (docs/adr/1353-*)
    assert.equal((await put(owner, roadmap, mine.filter((f) => f.id !== 'tw'))).statusCode, 200)
    const partner = (await fieldsOf(sam, priv)).find((f) => f.id === pair)
    assert.deepEqual(partner?.relation, { targetPageId: roadmap, twoWay: false })
  })

  it('the owner can remove the field', async () => {
    const cur = await fieldsOf(owner, roadmap)
    const res = await put(owner, roadmap, cur.filter((f) => f.id !== 'notes' && f.id !== 'nnotes' && f.id !== 'moods'))
    assert.equal(res.statusCode, 200, res.body)
    const [row] = await db.select({ fields: schema.collections.fields }).from(schema.collections).where(eq(schema.collections.pageId, priv))
    assert.deepEqual((row.fields as CollectionField[]).map((f) => f.id).slice(0, 1), ['mood'])
  })
})
