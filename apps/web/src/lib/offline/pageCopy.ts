// A page's device copy bound to its Y.Doc (docs/adr/2200-*).
//
// - load(): applies the stored updates to the (empty) doc before the provider exists, so nothing of
//   it counts as a local edit and the editor shows it at once, also offline.
// - Every doc update after that is appended (batched); a local one (origin not the provider) bumps
//   this session's counter, which marks the copy as holding unsent edits.
// - acked(): the provider is back at 0 unsynced changes: this session's edits and the ones it
//   adopted from the device at load are on the server; their counters are cleared compare-and-delete,
//   so a newer edit stored meanwhile (or another tab's) stays marked.
// - Write failures (quota, blocked IndexedDB) never stop editing: `state` turns 'failed' and the
//   leave guard is armed again (the edits then live only in this tab, as before 0.18).
import * as Y from 'yjs'
import { DOC_SCHEMA_VERSION } from '@inkling/shared'
import { applyClear, hasPending, OfflineStoreError, type DocRecord, type OfflineStore, type PendingClients } from './store'

/** Origin of the updates load() applies (not an edit). */
export const LOAD_ORIGIN = Symbol('offline-load')

/** Fold stored updates into one after this many appends. */
export const COMPACT_AFTER = 64
/** Batch window for appends (ms). Typing produces one update per keystroke. */
export const APPEND_BATCH_MS = 120

export type CopyState = 'idle' | 'stored' | 'failed'

export type PageCopy = {
  /** applies the stored copy; returns what it found */
  load: () => Promise<DocRecord | null>
  /** starts writing doc updates (call after load, before the provider is created) */
  start: (isRemote: (origin: unknown) => boolean) => void
  /** start() was called: the provider that uses it disposes it */
  started: () => boolean
  /** unsent local edits: this session's or adopted from the device */
  pending: () => boolean
  /** the provider has no unacknowledged change: clear what was sent */
  acked: () => Promise<void>
  /** generation of the content now in the doc */
  setGen: (gen: number) => void
  gen: () => number | null
  localClients: () => Set<number>
  /** document schema of the oldest app whose unsent edits the copy holds (this build's when none) (docs/adr/2425-*) */
  schema: () => number
  setTitle: (title: string) => void
  /** writes everything queued; resolves when stored (or failed) */
  flush: () => Promise<void>
  /** 'stored' once a write succeeded and none failed since */
  state: () => CopyState
  /** pending edits are all written to the device (the leave guard need not ask) */
  durable: () => boolean
  subscribe: (fn: () => void) => () => void
  dispose: () => void
}

export function createPageCopy(opts: {
  store: OfflineStore
  userId: string
  pageId: string
  wsId: string
  doc: Y.Doc
  /** this tab's editing session (random) */
  session: string
  title?: string
  /** returns false while the device setting is off: nothing is written */
  enabled?: () => boolean
  onError?: (err: OfflineStoreError) => void
}): PageCopy {
  const { store, userId, pageId, wsId, doc, session } = opts
  let title = opts.title ?? ''
  let gen: number | null = null
  let count = 0 // local edits of this session (monotonic: the stored counter is compared against it)
  let writtenCount = 0 // local edits of this session already stored
  let ackedCount = 0 // local edits of this session the server acknowledged
  let adopted: PendingClients = {}
  let localClients = new Set<number>()
  // schema of the unsent edits adopted from the device (this session's are this build's)
  let adoptedSchema = DOC_SCHEMA_VERSION
  let queue: Uint8Array[] = []
  let queueLocal = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let state: CopyState = 'idle'
  let failed = false
  let appends = 0
  let disposed = false
  let startedFlag = false
  let isRemote: (origin: unknown) => boolean = () => false
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const l of listeners) l()
  }
  const enabled = () => !disposed && (opts.enabled ? opts.enabled() : true)

  const fail = (err: unknown) => {
    const e = err instanceof OfflineStoreError ? err : new OfflineStoreError('failed', String(err))
    failed = true
    state = 'failed'
    opts.onError?.(e)
    emit()
  }

  const write = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(fail)
    return chain
  }

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!queue.length) return chain
    const updates = queue
    const local = queueLocal
    const n = count
    queue = []
    queueLocal = false
    if (!enabled()) return chain
    return write(async () => {
      const update = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)
      await store.append(userId, pageId, update, {
        wsId,
        title,
        ...(local ? { local: { session, count: n, client: doc.clientID, schema: DOC_SCHEMA_VERSION } } : {}),
      })
      if (local) writtenCount = Math.max(writtenCount, n)
      if (!failed) state = 'stored'
      appends++
      if (appends >= COMPACT_AFTER) {
        appends = 0
        await store.compact(userId, pageId, (all) => Y.mergeUpdates(all))
      }
      emit()
    })
  }

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOAD_ORIGIN || disposed) return
    queue.push(update)
    if (!isRemote(origin)) {
      count++
      queueLocal = true
      localClients.add(doc.clientID)
      emit()
    }
    if (!timer) timer = setTimeout(() => void flushNow(), APPEND_BATCH_MS)
  }

  return {
    async load() {
      let stored: Awaited<ReturnType<OfflineStore['getDoc']>> = null
      try {
        stored = await store.getDoc(userId, pageId)
      } catch (err) {
        fail(err)
        return null
      }
      if (!stored) return null
      if (stored.updates.length) {
        Y.applyUpdate(doc, stored.updates.length === 1 ? stored.updates[0] : Y.mergeUpdates(stored.updates), LOAD_ORIGIN)
      }
      gen = stored.record.gen
      if (stored.record.title) title = title || stored.record.title
      adopted = { ...stored.record.pending }
      localClients = new Set(stored.record.localClients)
      adoptedSchema = hasPending(stored.record) ? (stored.record.schema ?? 1) : DOC_SCHEMA_VERSION
      appends = stored.record.updates
      state = 'stored'
      void store.touch(userId, pageId, Date.now()).catch(() => {})
      emit()
      return stored.record
    },
    start(remote) {
      isRemote = remote
      startedFlag = true
      doc.on('update', onUpdate)
    },
    started: () => startedFlag,
    pending: () => count > ackedCount || hasPending({ pending: adopted }),
    async acked() {
      // what is acknowledged now: every local edit so far and everything adopted at load
      const ack: PendingClients = { ...adopted }
      if (count > ackedCount) ack[session] = count
      if (!Object.keys(ack).length) return
      await flushNow()
      if (!enabled()) return
      await write(async () => {
        await store.clearPending(userId, pageId, ack)
      })
      // only what this call covered: edits typed while it ran stay counted
      const r = { pending: { ...adopted }, localClients: [] as number[] }
      applyClear(r as DocRecord, ack)
      adopted = r.pending
      if (!Object.keys(adopted).length) adoptedSchema = DOC_SCHEMA_VERSION
      if (ack[session] !== undefined) ackedCount = Math.max(ackedCount, ack[session])
      if (!Object.keys(adopted).length) localClients = new Set(count > ackedCount ? [doc.clientID] : [])
      emit()
    },
    setGen(g) {
      gen = g
      if (!enabled()) return
      void write(() => store.patch(userId, pageId, { wsId, title, gen: g }))
    },
    gen: () => gen,
    localClients: () => new Set(localClients),
    schema: () => (hasPending({ pending: adopted }) ? Math.min(adoptedSchema, DOC_SCHEMA_VERSION) : DOC_SCHEMA_VERSION),
    setTitle(t) {
      title = t
    },
    flush: () => flushNow(),
    state: () => state,
    durable: () => !failed && state === 'stored' && writtenCount >= count && queue.length === 0,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      void flushNow()
      disposed = true
      doc.off('update', onUpdate)
      listeners.clear()
    },
  }
}

/**
 * What a recovery item keeps (docs/adr/2201-*): this tab's document merged with everything stored for
 * the page, so another tab's unsent edits on the same page go into the item too before the copy is
 * deleted.
 */
export async function recoveryState(store: OfflineStore, userId: string, pageId: string, doc: Y.Doc): Promise<Uint8Array> {
  const own = Y.encodeStateAsUpdate(doc)
  try {
    const stored = await store.getDoc(userId, pageId)
    return stored && stored.updates.length ? Y.mergeUpdates([...stored.updates, own]) : own
  } catch {
    return own
  }
}
