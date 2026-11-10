// Offline copies on this device (docs/adr/2200-*, 2201-*).
//
// The storage layer behind an interface: the browser uses IndexedDB (idbStore.ts), node tests use the
// memory store below. Everything is keyed by the signed-in user, and the store has one owner at a
// time (meta 'owner'): a different user signing in wipes it before anything is read (ADR 2203).
//
// A page's copy is a list of Yjs updates (append-only, so two tabs never overwrite each other's
// writes) plus one record with what the reconcile step needs: the server's document generation the
// copy was made from, and which local clients still hold edits the server has not acknowledged.

/**
 * Editing session (one tab's Y.Doc) → number of local edits it has stored. A counter, not a Yjs clock:
 * a delete-only edit does not advance the clock (ADR 1920), but it is an edit the server must get.
 */
export type PendingClients = Record<string, number>

export type DocRecord = {
  userId: string
  pageId: string
  wsId: string
  /** title when last seen, for the recovery and storage lists */
  title: string
  /** server document generation the stored state descends from (null = never synced) */
  gen: number | null
  /** local edits stored on this device and not acknowledged by the server */
  pending: PendingClients
  /** Yjs clientIDs that made those edits (their ops may be missing on the server; lineage check skips them) */
  localClients: number[]
  /** sum of the stored updates' byte lengths */
  bytes: number
  /** number of stored updates (compaction folds them into one) */
  updates: number
  /** last time the page was opened (eviction order) */
  openedAt: number
  /** last write */
  savedAt: number
}

/** A copy that was not merged (generation changed, page trashed, edit right lost): kept for the user. */
export type RecoveryItem = {
  id: string
  userId: string
  pageId: string
  wsId: string
  title: string
  reason: RecoveryReason
  /** full Yjs state of the device copy at the time */
  state: Uint8Array
  createdAt: number
}

export type RecoveryReason = 'restored' | 'replaced' | 'trashed' | 'readonly'

export type StoredDoc = { record: DocRecord; updates: Uint8Array[] }

/** Thrown by a store whose writes failed (quota, blocked IndexedDB). Callers keep editing. */
export class OfflineStoreError extends Error {
  kind: 'quota' | 'unavailable' | 'failed'
  constructor(kind: 'quota' | 'unavailable' | 'failed', message: string) {
    super(message)
    this.kind = kind
    this.name = 'OfflineStoreError'
  }
}

export interface OfflineStore {
  /** The user whose copies the store holds (null = empty). */
  owner(): Promise<string | null>
  /** Wipes everything when the store belongs to someone else, then records `userId` as the owner. */
  claim(userId: string): Promise<void>
  /** Deletes every copy, snapshot and recovery item of every user. */
  wipe(): Promise<void>

  getDoc(userId: string, pageId: string): Promise<StoredDoc | null>
  listDocs(userId: string): Promise<DocRecord[]>
  /**
   * Appends one update and updates the record in the same transaction. `pending` entries are merged
   * (max clock per client); `meta` fields overwrite.
   */
  append(
    userId: string,
    pageId: string,
    update: Uint8Array,
    meta: AppendMeta,
  ): Promise<DocRecord>
  /**
   * Replaces the updates with one merged update. `fold` receives the updates stored right now (inside
   * the same transaction, so an append from another tab is either folded in or lands after) and
   * returns the merged state; `meta` overwrites record fields.
   */
  compact(userId: string, pageId: string, fold: (updates: Uint8Array[]) => Uint8Array): Promise<DocRecord | null>
  /** Overwrites record fields (creates the record when missing). */
  patch(userId: string, pageId: string, meta: { wsId: string; title?: string; gen?: number | null }): Promise<void>
  /** Drops pending entries whose stored clock is ≤ the acknowledged clock (compare-and-delete). */
  clearPending(userId: string, pageId: string, acked: PendingClients): Promise<DocRecord | null>
  touch(userId: string, pageId: string, at: number): Promise<void>
  deleteDoc(userId: string, pageId: string): Promise<void>

  putSnapshot(userId: string, key: string, value: unknown): Promise<void>
  getSnapshot<T>(userId: string, key: string): Promise<T | null>

  addRecovery(item: Omit<RecoveryItem, 'id'>): Promise<RecoveryItem>
  listRecovery(userId: string): Promise<RecoveryItem[]>
  deleteRecovery(userId: string, id: string): Promise<void>
}

export type AppendMeta = {
  wsId: string
  title?: string
  gen?: number | null
  /** a local edit: the session's counter after it, and the Yjs clientID that made it */
  local?: { session: string; count: number; client: number }
}

export function mergePending(a: PendingClients, b: PendingClients | undefined): PendingClients {
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v)
  return out
}

/** `pending` minus the entries `acked` covers (acked clock ≥ stored clock). */
export function subtractPending(pending: PendingClients, acked: PendingClients): PendingClients {
  const out: PendingClients = {}
  for (const [k, v] of Object.entries(pending)) {
    const a = acked[k]
    if (a === undefined || a < v) out[k] = v
  }
  return out
}

export const hasPending = (r: Pick<DocRecord, 'pending'> | null | undefined) =>
  !!r && Object.keys(r.pending).length > 0

function newRecord(userId: string, pageId: string, wsId: string, now: number): DocRecord {
  return {
    userId,
    pageId,
    wsId,
    title: '',
    gen: null,
    pending: {},
    localClients: [],
    bytes: 0,
    updates: 0,
    openedAt: now,
    savedAt: now,
  }
}

export const copyRecord = (r: DocRecord): DocRecord => ({ ...r, pending: { ...r.pending }, localClients: [...r.localClients] })

/** Record changes of one append (shared by both stores, so they behave the same). */
export function applyAppend(r: DocRecord, update: Uint8Array, meta: AppendMeta, at: number): void {
  applyPatch(r, meta)
  if (meta.local) {
    r.pending = mergePending(r.pending, { [meta.local.session]: meta.local.count })
    if (!r.localClients.includes(meta.local.client)) r.localClients = [...r.localClients, meta.local.client]
  }
  r.bytes += update.byteLength
  r.savedAt = at
}

export function applyPatch(r: DocRecord, meta: { wsId: string; title?: string; gen?: number | null }): void {
  r.wsId = meta.wsId
  if (meta.title !== undefined && meta.title !== '') r.title = meta.title
  if (meta.gen !== undefined) r.gen = meta.gen
}

/** Compare-and-delete of acknowledged sessions; once nothing is pending the local clients are on the server too. */
export function applyClear(r: DocRecord, acked: PendingClients): void {
  r.pending = subtractPending(r.pending, acked)
  if (Object.keys(r.pending).length === 0) r.localClients = []
}

let seq = 0
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * In-memory store for tests (and the fallback when IndexedDB is unavailable is *no* store, not this
 * one: a memory copy would make "stored on this device" a lie). `failWith` makes every write throw.
 */
export function createMemoryStore(opts: { now?: () => number } = {}): OfflineStore & {
  failWith: OfflineStoreError | null
  /** bytes per user (tests) */
  dump: () => { docs: Map<string, StoredDoc>; snapshots: Map<string, unknown>; recovery: Map<string, RecoveryItem> }
} {
  const now = opts.now ?? (() => Date.now())
  let owner: string | null = null
  const docs = new Map<string, StoredDoc>()
  const snapshots = new Map<string, unknown>()
  const recovery = new Map<string, RecoveryItem>()
  const key = (u: string, p: string) => `${u}\u0000${p}`
  const store = {
    failWith: null as OfflineStoreError | null,
    dump: () => ({ docs, snapshots, recovery }),
    check() {
      if (store.failWith) throw store.failWith
    },
    /** tests: who owns the store (the IndexedDB store keeps it in its meta store) */
    async owner() {
      return owner
    },
    async claim(userId: string) {
      store.check()
      if (owner !== null && owner !== userId) await store.wipe()
      owner = userId
    },
    async wipe() {
      docs.clear()
      snapshots.clear()
      recovery.clear()
      owner = null
    },
    async getDoc(userId: string, pageId: string) {
      const d = docs.get(key(userId, pageId))
      return d ? { record: copyRecord(d.record), updates: [...d.updates] } : null
    },
    async listDocs(userId: string) {
      return [...docs.values()].filter((d) => d.record.userId === userId).map((d) => copyRecord(d.record))
    },
    async append(userId: string, pageId: string, update: Uint8Array, meta: AppendMeta) {
      store.check()
      // like the IndexedDB store: a write for someone who no longer owns the store is dropped
      if (owner !== userId) throw new OfflineStoreError('failed', 'store owned by another user')
      const k = key(userId, pageId)
      const d = docs.get(k) ?? { record: newRecord(userId, pageId, meta.wsId, now()), updates: [] }
      d.updates.push(update)
      applyAppend(d.record, update, meta, now())
      d.record.updates = d.updates.length
      docs.set(k, d)
      return copyRecord(d.record)
    },
    async compact(userId: string, pageId: string, fold: (u: Uint8Array[]) => Uint8Array) {
      store.check()
      const d = docs.get(key(userId, pageId))
      if (!d) return null
      const merged = fold(d.updates)
      d.updates = [merged]
      d.record.bytes = merged.byteLength
      d.record.updates = 1
      return copyRecord(d.record)
    },
    async patch(userId: string, pageId: string, meta: { wsId: string; title?: string; gen?: number | null }) {
      store.check()
      if (owner !== userId) throw new OfflineStoreError('failed', 'store owned by another user')
      const k = key(userId, pageId)
      const d = docs.get(k) ?? { record: newRecord(userId, pageId, meta.wsId, now()), updates: [] }
      applyPatch(d.record, meta)
      docs.set(k, d)
    },
    async clearPending(userId: string, pageId: string, acked: PendingClients) {
      store.check()
      const d = docs.get(key(userId, pageId))
      if (!d) return null
      applyClear(d.record, acked)
      return copyRecord(d.record)
    },
    async touch(userId: string, pageId: string, at: number) {
      const d = docs.get(key(userId, pageId))
      if (d) d.record.openedAt = at
    },
    async deleteDoc(userId: string, pageId: string) {
      docs.delete(key(userId, pageId))
    },
    async putSnapshot(userId: string, k: string, value: unknown) {
      store.check()
      snapshots.set(key(userId, k), structuredClone(value))
    },
    async getSnapshot<T>(userId: string, k: string) {
      const v = snapshots.get(key(userId, k))
      return v === undefined ? null : (structuredClone(v) as T)
    },
    async addRecovery(item: Omit<RecoveryItem, 'id'>) {
      store.check()
      const full = { ...item, id: newId() }
      recovery.set(full.id, full)
      return full
    },
    async listRecovery(userId: string) {
      return [...recovery.values()].filter((r) => r.userId === userId).sort((a, b) => b.createdAt - a.createdAt)
    },
    async deleteRecovery(userId: string, id: string) {
      const r = recovery.get(id)
      if (r && r.userId === userId) recovery.delete(id)
    },
  }
  return store
}

export const _newIdForTests = newId
