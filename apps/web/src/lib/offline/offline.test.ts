// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Device copies against a simulated server (docs/adr/2200-*, 2201-*): the Yjs-level cases A–H.
// The server here edits its one Y.Doc the way apps/server does (restore = delete + insert in the same
// document, revert/split = remove sections) and bumps the generation after the content, as docGen.ts.
// The server-side half (routes, generation bumps, real sockets) is apps/server/src/offlineSync.db.test.ts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { createGate } from './gate'
import { createPageCopy, recoveryState } from './pageCopy'
import { createMemoryStore, hasPending, OfflineStoreError } from './store'

const PROVIDER = { provider: true }

function para(text: string) {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  return p
}
const frag = (doc) => doc.getXmlFragment('document')
const texts = (doc) => frag(doc).toArray().map((el) => el.toArray().map((t) => t.toString()).join(''))
const body = (doc) => texts(doc).join('\n')

/** Appends text to paragraph `i` of the client doc (a local edit). */
function typeInto(doc, i, text) {
  const t = frag(doc).get(i).get(0)
  t.insert(t.length, text)
}

class Server {
  doc = new Y.Doc()
  gen = 0
  canEdit = true
  trashed = false
  gone = false
  constructor(lines: string[]) {
    frag(this.doc).insert(0, lines.map(para))
  }
  check() {
    if (this.gone) return { kind: 'gone' }
    return { kind: 'ok', gen: this.gen, canEdit: this.canEdit, trashed: this.trashed, sv: Y.encodeStateVector(this.doc) }
  }
  /** version restore: one transaction, delete everything, insert the snapshot's blocks (routes/snapshots.ts) */
  restore(lines: string[]) {
    this.doc.transact(() => {
      frag(this.doc).delete(0, frag(this.doc).length)
      frag(this.doc).insert(0, lines.map(para))
    })
    this.gen++ // after the content (docGen.ts)
  }
  /** AI-edit revert / split: sections removed from the same document */
  removeAt(i: number) {
    frag(this.doc).delete(i, 1)
    this.gen++
  }
  edit(i: number, text: string) {
    const t = frag(this.doc).get(i).get(0)
    t.insert(t.length, text)
  }
}

/** A browser tab: its Y.Doc, the device copy on `store`, and the provider's two-way sync once the gate lets it. */
async function openTab(store, server: Server, opts: { user?: string; reload?: boolean } = {}) {
  const user = opts.user ?? 'u1'
  const doc = new Y.Doc()
  const copy = createPageCopy({ store, userId: user, pageId: 'p', wsId: 'w', doc, session: `s${Math.random()}`, title: 'Page' })
  const record = await copy.load()
  copy.start((o) => o === PROVIDER)
  const tab = {
    doc,
    copy,
    record,
    blocked: null,
    recovered: [],
    online: false,
    async connect() {
      tab.blocked = null
      const gate = createGate({
        doc,
        copy,
        check: async () => server.check(),
        sleep: async () => {},
        onBlocked: async (d) => {
          tab.blocked = d
          if (d.kind === 'recover') {
            await copy.flush()
            const state = await recoveryState(store, user, 'p', doc)
            tab.recovered.push(await store.addRecovery({ userId: user, pageId: 'p', wsId: 'w', title: 'Page', reason: d.reason, state, createdAt: Date.now() }))
          }
          copy.dispose()
          await store.deleteDoc(user, 'p')
        },
      })
      try {
        await gate()
      } catch {
        return false
      }
      // the provider: server state in, local state out (SyncStep exchange)
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.doc, Y.encodeStateVector(doc)), PROVIDER)
      const out = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(server.doc))
      if (server.canEdit) {
        Y.applyUpdate(server.doc, out, 'client')
        await copy.acked() // SyncStatus(true): unsynced back to 0
      }
      if (typeof server.gen === 'number') copy.setGen(server.gen) // the {t:'gen'} stateless message
      tab.online = true
      await copy.flush()
      return true
    },
    /** a live edit while connected: sent and acknowledged at once */
    async liveType(i, text) {
      typeInto(doc, i, text)
      Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(server.doc)), 'client')
      await copy.acked()
      await copy.flush()
    },
    disconnect() {
      tab.online = false
    },
  }
  return tab
}

/** Reload: the tab is gone, a new one opens the page from the device. */
async function reload(store, server, tab) {
  await tab.copy.flush()
  tab.copy.dispose()
  return openTab(store, server)
}

async function newStore(user = 'u1') {
  const s = createMemoryStore()
  await s.claim(user)
  return s
}

describe('A: offline edit, then reconnect', () => {
  it('both sides\' edits survive, nothing is doubled', async () => {
    const server = new Server(['alpha', 'beta'])
    const store = await newStore()
    const tab = await openTab(store, server)
    assert.equal(await tab.connect(), true)
    tab.disconnect()
    typeInto(tab.doc, 0, ' (offline)')
    server.edit(1, ' (server)')
    const again = await reload(store, server, tab) // reload while offline: from the device
    assert.equal(body(again.doc), 'alpha (offline)\nbeta')
    assert.equal(again.copy.pending(), true)
    assert.equal(await again.connect(), true)
    assert.equal(body(server.doc), 'alpha (offline)\nbeta (server)')
    assert.equal(body(again.doc), body(server.doc))
    assert.equal(hasPending((await store.getDoc('u1', 'p')).record), false, 'acknowledged: no longer pending')
  })

  it('a delete-only offline edit is pending too (a counter, not a Yjs clock)', async () => {
    const server = new Server(['keep', 'drop me'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    frag(tab.doc).delete(1, 1) // no clock advances for a deletion
    await tab.copy.flush()
    assert.equal(hasPending((await store.getDoc('u1', 'p')).record), true)
    const again = await reload(store, server, tab)
    assert.equal(again.copy.pending(), true)
    await again.connect()
    assert.equal(body(server.doc), 'keep')
  })
})

describe('B: version restored on the server while the device holds unsent edits', () => {
  it('baseline (what the gate prevents): a blind merge loses the offline edit without a word', async () => {
    const server = new Server(['v1 intro', 'v1 body'])
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server.doc))
    typeInto(client, 1, ' + typed offline')
    server.restore(['v0 intro'])
    Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server.doc)))
    assert.equal(body(server.doc), 'v0 intro', 'no revival, no doubling — but the offline text is gone')
  })

  it('gated: the body is the restored version, deleted text stays deleted, the offline edit is a recovery item', async () => {
    const server = new Server(['v1 intro', 'v1 body'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 1, ' + typed offline')
    server.restore(['v0 intro', 'v0 body'])
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.deepEqual(again.blocked, { kind: 'recover', reason: 'restored' })
    assert.equal(body(server.doc), 'v0 intro\nv0 body', 'nothing from the device reached the server')
    // the editor reopens from the server: a fresh copy, no doubling
    const fresh = await openTab(store, server)
    assert.equal(fresh.record, null, 'the stale copy was deleted')
    await fresh.connect()
    assert.equal(body(fresh.doc), 'v0 intro\nv0 body')
    // the offline text is kept, visible to the user
    const [item] = await store.listRecovery('u1')
    assert.equal(item.reason, 'restored')
    const kept = new Y.Doc()
    Y.applyUpdate(kept, item.state)
    assert.match(body(kept), /typed offline/)
  })

  it('the same gate guards a tab left open through the outage (live reconnect)', async () => {
    const server = new Server(['v1'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 0, ' offline')
    server.restore(['v0'])
    assert.equal(await tab.connect(), false)
    assert.equal(tab.blocked.reason, 'restored')
    assert.equal(body(server.doc), 'v0')
  })

  it('a restore with nothing unsent merges normally (same history: no revival)', async () => {
    const server = new Server(['v1'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    server.restore(['v0'])
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), true)
    assert.equal(body(again.doc), 'v0')
    assert.equal(body(server.doc), 'v0')
  })
})

describe('C: AI edit reverted (sections removed) while offline', () => {
  it('the edit inside the reverted section is kept for recovery, not merged into deleted blocks', async () => {
    const server = new Server(['mine', 'agent wrote this'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 1, ' — and I fixed it offline')
    server.removeAt(1)
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.equal(again.blocked.reason, 'restored')
    assert.equal(body(server.doc), 'mine')
    const [item] = await store.listRecovery('u1')
    const kept = new Y.Doc()
    Y.applyUpdate(kept, item.state)
    assert.match(body(kept), /fixed it offline/)
  })
})

describe('D: page moved to the trash while offline', () => {
  it('unsent edits become a recovery item; nothing is written to the page', async () => {
    const server = new Server(['note'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 0, ' offline')
    server.trashed = true
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.deepEqual(again.blocked, { kind: 'recover', reason: 'trashed' })
    assert.equal(body(server.doc), 'note')
    assert.equal((await store.listRecovery('u1')).length, 1)
    assert.equal(await store.getDoc('u1', 'p'), null)
  })
  it('without unsent edits the copy is just dropped', async () => {
    const server = new Server(['note'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    server.trashed = true
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.deepEqual(again.blocked, { kind: 'reset', reason: 'trashed' })
    assert.equal((await store.listRecovery('u1')).length, 0)
  })
})

describe('E: edit right lost while offline', () => {
  it('read-only: no write is attempted, the edits are shown as a recovery item, one check per connect', async () => {
    const server = new Server(['locked later'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 0, ' offline')
    server.canEdit = false
    let checks = 0
    const check = server.check.bind(server)
    server.check = () => {
      checks++
      return check()
    }
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.equal(again.blocked.reason, 'readonly')
    assert.equal(checks, 1, 'decided once; nothing retries on its own')
    assert.equal(body(server.doc), 'locked later')
  })
  it('read-only without unsent edits still opens (read-only) and syncs from the server', async () => {
    const server = new Server(['locked'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    server.canEdit = false
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), true)
  })
  it('no access any more (403/404): the copy is deleted, unsent edits included', async () => {
    const server = new Server(['private now'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    tab.disconnect()
    typeInto(tab.doc, 0, ' offline')
    server.gone = true
    const again = await reload(store, server, tab)
    assert.equal(await again.connect(), false)
    assert.deepEqual(again.blocked, { kind: 'forget' })
    assert.equal(await store.getDoc('u1', 'p'), null)
    assert.equal((await store.listRecovery('u1')).length, 0)
  })
})

describe('history lost on the server (database restored from a backup, or a crash before the store)', () => {
  it('a copy holding ops the server no longer has is kept for recovery, not pushed back over the restored state', async () => {
    const server = new Server(['backed up'])
    const store = await newStore()
    const tab = await openTab(store, server)
    await tab.connect()
    const backup = Y.encodeStateAsUpdate(server.doc) // the nightly backup
    await tab.liveType(0, ' + after the backup') // acknowledged, stored on the device
    // the operator restores the backup: an older state of the same document
    server.doc = new Y.Doc()
    Y.applyUpdate(server.doc, backup)
    // baseline: a blind merge would quietly put the newer text back over the restore
    const blind = new Y.Doc()
    Y.applyUpdate(blind, backup)
    Y.applyUpdate(blind, Y.encodeStateAsUpdate(tab.doc))
    assert.equal(body(blind), 'backed up + after the backup')
    tab.disconnect()
    const again = await reload(store, server, tab)
    assert.equal(again.copy.pending(), false, 'nothing unsent: the edit was acknowledged before the restore')
    assert.equal(await again.connect(), false)
    assert.deepEqual(again.blocked, { kind: 'recover', reason: 'replaced' })
    assert.equal(body(server.doc), 'backed up')
    const [item] = await store.listRecovery('u1')
    const kept = new Y.Doc()
    Y.applyUpdate(kept, item.state)
    assert.equal(body(kept), 'backed up + after the backup')
  })
})

describe('G: storage failure', () => {
  it('a write that fails (quota) never stops editing; the copy reports it and is not durable', async () => {
    const server = new Server(['text'])
    const store = await newStore()
    const errors = []
    const doc = new Y.Doc()
    const copy = createPageCopy({ store, userId: 'u1', pageId: 'p', wsId: 'w', doc, session: 's', onError: (e) => errors.push(e.kind) })
    await copy.load()
    copy.start((o) => o === PROVIDER)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.doc), PROVIDER)
    await copy.flush()
    assert.equal(copy.durable(), true)
    store.failWith = new OfflineStoreError('quota', 'full')
    typeInto(doc, 0, ' more')
    await copy.flush()
    assert.equal(body(doc), 'text more', 'the edit is in the document')
    assert.deepEqual(errors, ['quota'])
    assert.equal(copy.state(), 'failed')
    assert.equal(copy.durable(), false, 'the leave guard asks again')
    copy.dispose()
  })
  it('an unavailable store (private mode) means no copy at all, the editor works as before', async () => {
    // runtime.getStore() resolves null when createIdbStore rejects; CollabEditor then opens without a copy
    const err = new OfflineStoreError('unavailable', 'blocked')
    assert.equal(err.kind, 'unavailable')
  })
})

describe('H: two tabs of the same browser', () => {
  it('appends never overwrite each other; both tabs\' offline edits reach the server', async () => {
    const server = new Server(['one', 'two'])
    const store = await newStore()
    const a = await openTab(store, server)
    await a.connect()
    const b = await openTab(store, server)
    await b.connect()
    a.disconnect()
    b.disconnect()
    typeInto(a.doc, 0, ' A')
    typeInto(b.doc, 1, ' B')
    await a.copy.flush()
    await b.copy.flush()
    // compaction by one tab folds the other's updates in
    await store.compact('u1', 'p', (all) => Y.mergeUpdates(all))
    const stored = await store.getDoc('u1', 'p')
    const onDevice = new Y.Doc()
    Y.applyUpdate(onDevice, Y.mergeUpdates(stored.updates))
    assert.equal(body(onDevice), 'one A\ntwo B')
    assert.equal(Object.keys(stored.record.pending).length, 2, 'one counter per tab')
    // tab A reconnects first: it clears only what it sent (its own counter and what it adopted at load)
    assert.equal(await a.connect(), true)
    assert.equal(Object.keys((await store.getDoc('u1', 'p')).record.pending).length, 1, "B's edit is still marked")
    assert.equal(await b.connect(), true)
    assert.equal(body(server.doc), 'one A\ntwo B')
    assert.equal(hasPending((await store.getDoc('u1', 'p')).record), false)
  })
})

describe('H + B: two tabs with unsent edits, then a restore', () => {
  it('the recovery item of the first tab to reconnect also holds the other tab\'s stored edits', async () => {
    const server = new Server(['one', 'two'])
    const store = await newStore()
    const a = await openTab(store, server)
    await a.connect()
    const b = await openTab(store, server)
    await b.connect()
    a.disconnect()
    b.disconnect()
    typeInto(a.doc, 0, ' A-OFFLINE')
    typeInto(b.doc, 1, ' B-OFFLINE')
    await a.copy.flush()
    await b.copy.flush()
    b.copy.dispose() // tab B closed
    server.restore(['restored'])
    assert.equal(await a.connect(), false)
    const [item] = await store.listRecovery('u1')
    const kept = new Y.Doc()
    Y.applyUpdate(kept, item.state)
    assert.match(body(kept), /A-OFFLINE/)
    assert.match(body(kept), /B-OFFLINE/)
    assert.equal(body(server.doc), 'restored')
  })
})

describe('F: another account on the same device', () => {
  it('signing in as someone else deletes the previous account\'s copies before anything is read', async () => {
    const server = new Server(['alice\'s page'])
    const store = await newStore('alice')
    const tab = await openTab(store, server, { user: 'alice' })
    await tab.connect()
    await tab.copy.flush()
    assert.ok(await store.getDoc('alice', 'p'))
    await store.claim('bob')
    assert.equal(await store.getDoc('alice', 'p'), null)
    // alice's tab, still open, cannot write her copy back
    typeInto(tab.doc, 0, ' late')
    await tab.copy.flush()
    assert.equal(await store.getDoc('alice', 'p'), null)
  })
})
