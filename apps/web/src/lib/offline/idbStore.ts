// IndexedDB implementation of the offline store (docs/adr/2200-*).
//
// Written against the platform API instead of y-indexeddb: the records need a per-user key, the
// owner check inside every write transaction, pending counters, generations, recovery items and
// eviction, none of which y-indexeddb has, and its own part (append + fold the updates) is small.
//
// Every write runs in one readwrite transaction that also reads meta 'owner': a tab still open after
// a logout (or after the setting was turned off) cannot recreate copies, because the wipe removed
// the owner and its late writes then abort.
import {
  applyAppend,
  applyClear,
  applyPatch,
  copyRecord,
  OfflineStoreError,
  type AppendMeta,
  type DocRecord,
  type OfflineStore,
  type PendingClients,
  type RecoveryItem,
  type StoredDoc,
} from './store'

export const IDB_NAME = 'inkling-offline'
const IDB_VERSION = 1

type UpdateRow = { userId: string; pageId: string; update: Uint8Array }

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'))
    tx.onerror = () => reject(tx.error)
  })
}

function storeError(err: unknown): OfflineStoreError {
  if (err instanceof OfflineStoreError) return err
  const name = (err as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError') return new OfflineStoreError('quota', 'storage quota exceeded')
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError')
    return new OfflineStoreError('unavailable', `IndexedDB unavailable (${name})`)
  return new OfflineStoreError('failed', err instanceof Error ? err.message : String(err))
}

/**
 * How long an open may take before the store counts as unavailable. Some browsers leave
 * `indexedDB.open` unanswered (neither success nor error, `onblocked` never fires); a page waiting
 * for its device copy then stayed on "Connecting…". After this the page opens from the server only.
 */
export const OPEN_TIMEOUT_MS = 5000
let openTimeoutMs = OPEN_TIMEOUT_MS
/** tests: a shorter time limit */
export function _setOpenTimeoutForTests(ms: number | null) {
  openTimeoutMs = ms ?? OPEN_TIMEOUT_MS
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest
    try {
      r = indexedDB.open(IDB_NAME, IDB_VERSION)
    } catch (err) {
      reject(storeError(err))
      return
    }
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new OfflineStoreError('unavailable', `IndexedDB open did not answer in ${openTimeoutMs} ms`))),
      openTimeoutMs,
    )
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore('meta')
      const docs = db.createObjectStore('docs', { keyPath: ['userId', 'pageId'] })
      docs.createIndex('user', 'userId')
      const updates = db.createObjectStore('updates', { autoIncrement: true })
      updates.createIndex('doc', ['userId', 'pageId'])
      db.createObjectStore('snapshots')
      const recovery = db.createObjectStore('recovery', { keyPath: 'id' })
      recovery.createIndex('user', 'userId')
    }
    r.onsuccess = () => {
      // an answer after the time limit: nobody uses this handle, and an open one would hold off
      // deleteDatabase (logout, setting off) and version changes in other tabs
      if (settled) {
        try {
          r.result.close()
        } catch {
          // already closed
        }
        return
      }
      finish(() => resolve(r.result))
    }
    r.onerror = () => finish(() => reject(storeError(r.error)))
    r.onblocked = () => finish(() => reject(new OfflineStoreError('unavailable', 'IndexedDB open blocked')))
  })
}

let seq = 0
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function blankRecord(userId: string, pageId: string, wsId: string, now: number): DocRecord {
  return { userId, pageId, wsId, title: '', gen: null, pending: {}, localClients: [], bytes: 0, updates: 0, openedAt: now, savedAt: now }
}

/** Opens the store; rejects with OfflineStoreError('unavailable') where IndexedDB is blocked (e.g. some private modes). */
export async function createIdbStore(): Promise<OfflineStore> {
  if (typeof indexedDB === 'undefined') throw new OfflineStoreError('unavailable', 'no IndexedDB')
  let dbPromise: Promise<IDBDatabase> | null = null
  // Another tab deleting the database (logout, setting off) or a browser close: drop the handle;
  // the next write reopens an empty database whose missing owner refuses it.
  const adopt = (d: IDBDatabase) => {
    const forget = () => {
      if (dbPromise && current === d) dbPromise = null
    }
    d.onversionchange = () => {
      d.close()
      forget()
    }
    d.onclose = forget
    current = d
    return d
  }
  let current: IDBDatabase | null = null
  dbPromise = openDb().then(adopt)
  await dbPromise
  const getDb = () => {
    if (!dbPromise) {
      const p: Promise<IDBDatabase> = openDb().then(adopt)
      dbPromise = p
      // a reopen that failed (timed out, blocked) is not kept: the next write tries again
      p.catch(() => {
        if (dbPromise === p) dbPromise = null
      })
    }
    return dbPromise
  }

  /** Runs `body` in one transaction; resolves after commit with body's result. */
  async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
    try {
      const d = await getDb()
      const tx = d.transaction(stores, mode)
      const finished = done(tx)
      let out: T
      try {
        out = await body(tx)
      } catch (err) {
        try {
          tx.abort()
        } catch {
          // already finished
        }
        await finished.catch(() => {})
        throw err
      }
      await finished
      return out
    } catch (err) {
      throw storeError(err)
    }
  }

  /** In a write transaction: the store must still belong to `userId`. */
  async function assertOwner(tx: IDBTransaction, userId: string): Promise<void> {
    const owner = await req(tx.objectStore('meta').get('owner'))
    if (owner !== userId) throw new OfflineStoreError('failed', 'store owned by another user')
  }

  async function updatesOf(tx: IDBTransaction, userId: string, pageId: string): Promise<{ keys: IDBValidKey[]; values: UpdateRow[] }> {
    const idx = tx.objectStore('updates').index('doc')
    const range = IDBKeyRange.only([userId, pageId])
    const [keys, values] = await Promise.all([req(idx.getAllKeys(range)), req(idx.getAll(range) as IDBRequest<UpdateRow[]>)])
    return { keys, values }
  }

  const store: OfflineStore = {
    owner: () => run(['meta'], 'readonly', async (tx) => ((await req(tx.objectStore('meta').get('owner'))) as string | undefined) ?? null),

    claim: (userId) =>
      run(['meta', 'docs', 'updates', 'snapshots', 'recovery'], 'readwrite', async (tx) => {
        const meta = tx.objectStore('meta')
        const owner = (await req(meta.get('owner'))) as string | undefined
        if (owner !== undefined && owner !== userId) {
          for (const name of ['docs', 'updates', 'snapshots', 'recovery']) await req(tx.objectStore(name).clear())
        }
        await req(meta.put(userId, 'owner'))
      }),

    wipe: () =>
      run(['meta', 'docs', 'updates', 'snapshots', 'recovery'], 'readwrite', async (tx) => {
        for (const name of ['meta', 'docs', 'updates', 'snapshots', 'recovery']) await req(tx.objectStore(name).clear())
      }),

    getDoc: (userId, pageId) =>
      run(['docs', 'updates'], 'readonly', async (tx) => {
        const record = (await req(tx.objectStore('docs').get([userId, pageId]))) as DocRecord | undefined
        if (!record) return null
        const { values } = await updatesOf(tx, userId, pageId)
        return { record: copyRecord(record), updates: values.map((v) => v.update) } satisfies StoredDoc
      }),

    listDocs: (userId) =>
      run(['docs'], 'readonly', async (tx) => ((await req(tx.objectStore('docs').index('user').getAll(userId))) as DocRecord[]).map(copyRecord)),

    append: (userId, pageId, update, meta: AppendMeta) =>
      run(['meta', 'docs', 'updates'], 'readwrite', async (tx) => {
        await assertOwner(tx, userId)
        const docs = tx.objectStore('docs')
        const now = Date.now()
        const record = ((await req(docs.get([userId, pageId]))) as DocRecord | undefined) ?? blankRecord(userId, pageId, meta.wsId, now)
        await req(tx.objectStore('updates').add({ userId, pageId, update } satisfies UpdateRow))
        applyAppend(record, update, meta, now)
        record.updates += 1
        await req(docs.put(record))
        return copyRecord(record)
      }),

    compact: (userId, pageId, fold) =>
      run(['meta', 'docs', 'updates'], 'readwrite', async (tx) => {
        await assertOwner(tx, userId)
        const docs = tx.objectStore('docs')
        const record = (await req(docs.get([userId, pageId]))) as DocRecord | undefined
        if (!record) return null
        const { keys, values } = await updatesOf(tx, userId, pageId)
        // folded inside this transaction: an append from another tab is either in `values` or after
        const merged = fold(values.map((v) => v.update))
        const updates = tx.objectStore('updates')
        for (const k of keys) await req(updates.delete(k))
        await req(updates.add({ userId, pageId, update: merged } satisfies UpdateRow))
        record.bytes = merged.byteLength
        record.updates = 1
        await req(docs.put(record))
        return copyRecord(record)
      }),

    patch: (userId, pageId, meta) =>
      run(['meta', 'docs'], 'readwrite', async (tx) => {
        await assertOwner(tx, userId)
        const docs = tx.objectStore('docs')
        const record = ((await req(docs.get([userId, pageId]))) as DocRecord | undefined) ?? blankRecord(userId, pageId, meta.wsId, Date.now())
        applyPatch(record, meta)
        await req(docs.put(record))
      }),

    clearPending: (userId, pageId, acked: PendingClients) =>
      run(['docs'], 'readwrite', async (tx) => {
        const docs = tx.objectStore('docs')
        const record = (await req(docs.get([userId, pageId]))) as DocRecord | undefined
        if (!record) return null
        applyClear(record, acked)
        await req(docs.put(record))
        return copyRecord(record)
      }),

    touch: (userId, pageId, at) =>
      run(['docs'], 'readwrite', async (tx) => {
        const docs = tx.objectStore('docs')
        const record = (await req(docs.get([userId, pageId]))) as DocRecord | undefined
        if (!record) return
        record.openedAt = at
        await req(docs.put(record))
      }),

    deleteDoc: (userId, pageId) =>
      run(['docs', 'updates'], 'readwrite', async (tx) => {
        await req(tx.objectStore('docs').delete([userId, pageId]))
        const { keys } = await updatesOf(tx, userId, pageId)
        const updates = tx.objectStore('updates')
        for (const k of keys) await req(updates.delete(k))
      }),

    putSnapshot: (userId, key, value) =>
      run(['meta', 'snapshots'], 'readwrite', async (tx) => {
        await assertOwner(tx, userId)
        await req(tx.objectStore('snapshots').put({ value, savedAt: Date.now() }, [userId, key]))
      }),

    getSnapshot: <T,>(userId: string, key: string) =>
      run(['snapshots'], 'readonly', async (tx) => {
        const row = (await req(tx.objectStore('snapshots').get([userId, key]))) as { value: T } | undefined
        return row ? row.value : null
      }),

    addRecovery: (item) =>
      run(['meta', 'recovery'], 'readwrite', async (tx) => {
        await assertOwner(tx, item.userId)
        const full: RecoveryItem = { ...item, id: newId() }
        await req(tx.objectStore('recovery').put(full))
        return full
      }),

    listRecovery: (userId) =>
      run(['recovery'], 'readonly', async (tx) =>
        ((await req(tx.objectStore('recovery').index('user').getAll(userId))) as RecoveryItem[]).sort((a, b) => b.createdAt - a.createdAt),
      ),

    deleteRecovery: (userId, id) =>
      run(['recovery'], 'readwrite', async (tx) => {
        const r = (await req(tx.objectStore('recovery').get(id))) as RecoveryItem | undefined
        if (r && r.userId === userId) await req(tx.objectStore('recovery').delete(id))
      }),
  }
  return store
}

/** Deletes the whole database (logout, setting off) even when it cannot be opened normally. */
export function deleteIdbDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.deleteDatabase(IDB_NAME)
      r.onsuccess = () => resolve()
      r.onerror = () => resolve()
      // another tab holds it open: it closes on versionchange; the wipe above already emptied it
      r.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
