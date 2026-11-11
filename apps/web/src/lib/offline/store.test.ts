// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// The offline store contract (docs/adr/2200-*), on the memory store the browser's IndexedDB store mirrors.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { pickEvictions } from './limits'
import { createMemoryStore, OfflineStoreError, subtractPending } from './store'

const upd = (text: string) => {
  const d = new Y.Doc()
  d.getText('t').insert(0, text)
  return Y.encodeStateAsUpdate(d)
}

describe('offline store', () => {
  it('appends, marks local edits per session and clears them compare-and-delete', async () => {
    const s = createMemoryStore()
    await s.claim('u1')
    await s.append('u1', 'p', upd('a'), { wsId: 'w', local: { session: 's1', count: 1, client: 11 } })
    await s.append('u1', 'p', upd('b'), { wsId: 'w', local: { session: 's1', count: 2, client: 11 } })
    let r = (await s.getDoc('u1', 'p')).record
    assert.deepEqual(r.pending, { s1: 2 })
    assert.deepEqual(r.localClients, [11])
    // an ack that covers only the first edit leaves the session marked
    await s.clearPending('u1', 'p', { s1: 1 })
    r = (await s.getDoc('u1', 'p')).record
    assert.deepEqual(r.pending, { s1: 2 })
    await s.clearPending('u1', 'p', { s1: 2 })
    r = (await s.getDoc('u1', 'p')).record
    assert.deepEqual(r.pending, {})
    assert.deepEqual(r.localClients, [], 'once nothing is pending the local clients are on the server')
  })

  it('pending edits remember the oldest document schema that made one (absent = 0.19) (2425)', async () => {
    const s = createMemoryStore()
    await s.claim('u1')
    // a copy written by 0.19: no schema
    await s.append('u1', 'p', upd('a'), { wsId: 'w', local: { session: 'old', count: 1, client: 1 } })
    assert.equal((await s.getDoc('u1', 'p')).record.schema, 1)
    // a newer app adds an edit: still as old as the oldest
    await s.append('u1', 'p', upd('b'), { wsId: 'w', local: { session: 'new', count: 1, client: 2, schema: 2 } })
    assert.equal((await s.getDoc('u1', 'p')).record.schema, 1)
    // everything acknowledged: no schema; the next edit starts from its own app
    await s.clearPending('u1', 'p', { old: 1, new: 1 })
    assert.equal((await s.getDoc('u1', 'p')).record.schema, undefined)
    await s.append('u1', 'p', upd('c'), { wsId: 'w', local: { session: 'new', count: 2, client: 2, schema: 2 } })
    assert.equal((await s.getDoc('u1', 'p')).record.schema, 2)
  })

  it('a remote update does not mark the copy as pending', async () => {
    const s = createMemoryStore()
    await s.claim('u1')
    await s.append('u1', 'p', upd('server'), { wsId: 'w' })
    assert.deepEqual((await s.getDoc('u1', 'p')).record.pending, {})
  })

  it('compaction folds the stored updates, including another tab\'s, into one', async () => {
    const s = createMemoryStore()
    await s.claim('u1')
    await s.append('u1', 'p', upd('tab A'), { wsId: 'w' })
    await s.append('u1', 'p', upd('tab B'), { wsId: 'w' })
    await s.compact('u1', 'p', (all) => Y.mergeUpdates(all))
    const got = await s.getDoc('u1', 'p')
    assert.equal(got.updates.length, 1)
    const d = new Y.Doc()
    Y.applyUpdate(d, got.updates[0])
    assert.match(d.getText('t').toString(), /tab A/)
    assert.match(d.getText('t').toString(), /tab B/)
  })

  it('claim by another user wipes everything first; writes for a non-owner are refused (F)', async () => {
    const s = createMemoryStore()
    await s.claim('alice')
    await s.append('alice', 'p', upd('secret'), { wsId: 'w', local: { session: 's', count: 1, client: 1 } })
    await s.putSnapshot('alice', 'me', { id: 'alice' })
    await s.addRecovery({ userId: 'alice', pageId: 'p', wsId: 'w', title: 't', reason: 'restored', state: upd('x'), createdAt: 1 })
    await s.claim('bob')
    assert.equal(await s.getDoc('alice', 'p'), null)
    assert.equal(await s.getSnapshot('alice', 'me'), null)
    assert.deepEqual(await s.listRecovery('alice'), [])
    // a tab of alice still open after bob signed in cannot recreate her copy
    await assert.rejects(s.append('alice', 'p', upd('late'), { wsId: 'w' }), OfflineStoreError)
    // after a wipe (logout) nobody owns the store: late writes are refused too
    await s.wipe()
    await assert.rejects(s.append('bob', 'p', upd('late'), { wsId: 'w' }), OfflineStoreError)
    assert.equal(await s.owner(), null)
  })

  it('subtractPending keeps entries the ack does not cover', () => {
    assert.deepEqual(subtractPending({ a: 3, b: 1 }, { a: 2, b: 5 }), { a: 3 })
  })
})

describe('eviction (G)', () => {
  const doc = (pageId, bytes, openedAt, pending = false) => ({ pageId, bytes, openedAt, pending })
  it('evicts least recently opened first until under both limits', () => {
    const out = pickEvictions([doc('a', 10, 1), doc('b', 10, 2), doc('c', 10, 3)], new Set(), { maxDocs: 2, maxBytes: 1000 })
    assert.deepEqual(out, ['a'])
    const bytes = pickEvictions([doc('a', 50, 1), doc('b', 50, 2), doc('c', 50, 3)], new Set(), { maxDocs: 10, maxBytes: 60 })
    assert.deepEqual(bytes, ['a', 'b'])
  })
  it('never evicts a copy with unsent edits or one open now', () => {
    const out = pickEvictions([doc('a', 10, 1, true), doc('b', 10, 2), doc('c', 10, 3)], new Set(['b']), { maxDocs: 1, maxBytes: 1000 })
    assert.deepEqual(out, ['c'], 'a has unsent edits, b is open: only c can go (the limit is exceeded by what must stay)')
  })
  it('under the limits nothing goes', () => {
    assert.deepEqual(pickEvictions([doc('a', 10, 1)], new Set()), [])
  })
})

describe('decide: edits of an older app (2425)', () => {
  const sv = new Map([[1, 5]])
  const server = { kind: 'ok', gen: 3, canEdit: true, trashed: false, sv: new Uint8Array() }
  const decodeSv = () => sv
  const local = { pending: true, gen: 3, sv, localClients: new Set() }
  it('unsent edits of a 0.19 copy on a page that needs schema 2 are kept for recovery', async () => {
    const { decide } = await import('./decide')
    assert.deepEqual(decide({ ...local }, { ...server, needs: 2 }, decodeSv), { kind: 'recover', reason: 'outdated' })
    assert.deepEqual(decide({ ...local, schema: 1 }, { ...server, needs: 2 }, decodeSv), { kind: 'recover', reason: 'outdated' })
  })
  it('the same edits merge when the page needs nothing newer, or the server does not say', async () => {
    const { decide } = await import('./decide')
    assert.deepEqual(decide({ ...local, schema: 1 }, { ...server, needs: 1 }, decodeSv), { kind: 'merge' })
    assert.deepEqual(decide({ ...local, schema: 1 }, { ...server }, decodeSv), { kind: 'merge' })
    assert.deepEqual(decide({ ...local, schema: 2 }, { ...server, needs: 2 }, decodeSv), { kind: 'merge' })
    assert.deepEqual(decide({ ...local, pending: false, schema: 1 }, { ...server, needs: 2 }, decodeSv), { kind: 'merge' })
  })
})
