// Offline copies: the one place that knows the store, the signed-in user and the device setting
// (docs/adr/2200-*, 2202-*, 2203-*). Components read `useOfflineStatus()`; api.ts calls the
// snapshot and wipe helpers; CollabEditor opens page copies through `openPageCopy()`.
import { useSyncExternalStore } from 'react'
import { createIdbStore, deleteIdbDatabase } from './idbStore'
import { fetchSyncCheck } from './gate'
import { pickEvictions } from './limits'
import { createPageCopy, recoveryState, type PageCopy } from './pageCopy'
import { defaultEnabled, isInstalledApp, readChoice, writeChoice } from './settings'
import { hasPending, OfflineStoreError, type DocRecord, type OfflineStore, type RecoveryItem } from './store'
import type * as Y from 'yjs'

export type StorageState = 'off' | 'ok' | 'failed' | 'unavailable'

export type OfflineStatus = {
  enabled: boolean
  storage: StorageState
  /** the browser says it has no network */
  offline: boolean
  /** the app was started from stored data (the server did not answer) */
  fromDevice: boolean
  /** pages with edits stored on this device and not on the server yet */
  pendingPages: number
  recovery: number
  docs: number
  bytes: number
}

let state: OfflineStatus = {
  enabled: false,
  storage: 'off',
  offline: typeof navigator !== 'undefined' ? navigator.onLine === false : false,
  fromDevice: false,
  pendingPages: 0,
  recovery: 0,
  docs: 0,
  bytes: 0,
}
const listeners = new Set<() => void>()
function set(patch: Partial<OfflineStatus>) {
  const next = { ...state, ...patch }
  if ((Object.keys(patch) as (keyof OfflineStatus)[]).every((k) => next[k] === state[k])) return
  state = next
  for (const l of listeners) l()
}
export const offlineStatus = () => state
export function subscribeOffline(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(subscribeOffline, offlineStatus, offlineStatus)
}

let storeFactory: () => Promise<OfflineStore> = createIdbStore
let storePromise: Promise<OfflineStore | null> | null = null
let userId: string | null = null
const openPages = new Set<string>()

/** tests: use another store (memory) */
export function _setStoreFactoryForTests(f: () => Promise<OfflineStore>, enabled = true) {
  storeFactory = f
  storePromise = null
  userId = null
  set({ enabled, storage: enabled ? 'ok' : 'off' })
}

function enabledNow(): boolean {
  return defaultEnabled(readChoice(), isInstalledApp())
}

export function initOffline(): void {
  set({ enabled: enabledNow(), storage: enabledNow() ? 'ok' : 'off' })
  if (typeof window === 'undefined') return
  const onNet = () => set({ offline: navigator.onLine === false })
  window.addEventListener('online', onNet)
  window.addEventListener('offline', onNet)
}

export function isOfflineEnabled(): boolean {
  return state.enabled
}

function storageFailed(err: unknown) {
  const e = err instanceof OfflineStoreError ? err : new OfflineStoreError('failed', String(err))
  set({ storage: e.kind === 'unavailable' ? 'unavailable' : 'failed' })
}

/** The store, or null while the setting is off or IndexedDB cannot be used. */
export function getStore(): Promise<OfflineStore | null> {
  if (!state.enabled) return Promise.resolve(null)
  if (!storePromise) {
    storePromise = storeFactory().then(
      (s) => s,
      (err) => {
        storageFailed(err)
        return null
      },
    )
  }
  return storePromise
}

/** The user whose copies may be read and written (null before /auth/me answered or from the device). */
export const offlineUser = () => userId

/**
 * The server confirmed who is signed in: the store becomes theirs (another user's copies are deleted
 * first, ADR 2203) and their `me` is kept for an offline start.
 */
export async function adoptUser(me: { id: string }): Promise<void> {
  userId = me.id
  const store = await getStore()
  if (!store) return
  try {
    await store.claim(me.id)
    await store.putSnapshot(me.id, 'me', me)
    void refreshCounts()
  } catch (err) {
    storageFailed(err)
  }
}

/** The `me` kept by the last online start, for starting without the server. */
export async function deviceMe<T>(): Promise<T | null> {
  const store = await getStore()
  if (!store) return null
  try {
    const owner = await store.owner()
    if (!owner) return null
    const me = await store.getSnapshot<T>(owner, 'me')
    if (me) {
      userId = owner
      set({ fromDevice: true })
      void refreshCounts()
    }
    return me
  } catch {
    return null
  }
}

export async function saveSnapshot(key: string, value: unknown): Promise<void> {
  if (!userId) return
  const store = await getStore()
  if (!store) return
  try {
    await store.putSnapshot(userId, key, value)
  } catch (err) {
    storageFailed(err)
  }
}

export async function deviceSnapshot<T>(key: string): Promise<T | null> {
  if (!userId) return null
  const store = await getStore()
  if (!store) return null
  try {
    const v = await store.getSnapshot<T>(userId, key)
    if (v !== null) set({ fromDevice: true })
    return v
  } catch {
    return null
  }
}

/** The server answered again: stop saying the app runs from stored data. */
export function noteServerAnswered(): void {
  set({ fromDevice: false })
}

/** A fetch that failed without an HTTP answer (offline, server unreachable). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

/**
 * Deletes every copy on this device: logout, a session the server no longer knows (expired,
 * "log out everywhere", password change), the setting turned off (ADR 2203).
 */
export async function wipeOffline(): Promise<void> {
  const prev = storePromise
  userId = null
  try {
    const store = prev ? await prev : null
    if (store) await store.wipe()
  } catch {
    // fall through to deleting the database
  }
  if (storeFactory === createIdbStore && typeof indexedDB !== 'undefined') await deleteIdbDatabase()
  storePromise = null
  set({ pendingPages: 0, recovery: 0, docs: 0, bytes: 0, fromDevice: false })
}

export async function setOfflineEnabled(on: boolean): Promise<void> {
  writeChoice(on ? 'on' : 'off')
  if (!on) {
    await wipeOffline()
    set({ enabled: false, storage: 'off' })
    return
  }
  set({ enabled: true, storage: 'ok' })
}

/** Recounts pending pages, recovery items and size; evicts what is over the limits. */
export async function refreshCounts(): Promise<{ docs: DocRecord[]; recovery: RecoveryItem[] } | null> {
  const store = await getStore()
  if (!store || !userId) return null
  try {
    let docs = await store.listDocs(userId)
    const evict = pickEvictions(
      docs.map((d) => ({ pageId: d.pageId, bytes: d.bytes, openedAt: d.openedAt, pending: hasPending(d) })),
      openPages,
    )
    for (const id of evict) await store.deleteDoc(userId, id)
    if (evict.length) docs = docs.filter((d) => !evict.includes(d.pageId))
    const recovery = await store.listRecovery(userId)
    set({
      pendingPages: docs.filter(hasPending).length,
      recovery: recovery.length,
      docs: docs.length,
      bytes: docs.reduce((n, d) => n + d.bytes, 0),
    })
    return { docs, recovery }
  } catch (err) {
    storageFailed(err)
    return null
  }
}

/** Opens the device copy of a page for an editor (null: setting off, no user yet, or storage unusable). */
export async function openPageCopy(opts: { pageId: string; wsId: string; doc: Y.Doc; session: string; title?: string }): Promise<PageCopy | null> {
  const store = await getStore()
  if (!store || !userId) return null
  const uid = userId
  openPages.add(opts.pageId)
  const copy = createPageCopy({
    store,
    userId: uid,
    pageId: opts.pageId,
    wsId: opts.wsId,
    doc: opts.doc,
    session: opts.session,
    title: opts.title,
    enabled: () => state.enabled && userId === uid,
    onError: storageFailed,
  })
  const dispose = copy.dispose
  copy.dispose = () => {
    openPages.delete(opts.pageId)
    dispose()
    void refreshCounts()
  }
  return copy
}

export async function keepRecovery(item: Omit<RecoveryItem, 'id' | 'userId' | 'createdAt'>): Promise<void> {
  const store = await getStore()
  if (!store || !userId) return
  try {
    await store.addRecovery({ ...item, userId, createdAt: Date.now() })
  } catch (err) {
    storageFailed(err)
  }
  void refreshCounts()
}

/** The device state of a page for a recovery item: this tab's document plus every stored update of it. */
export async function deviceStateWith(pageId: string, doc: Y.Doc): Promise<Uint8Array> {
  const store = await getStore()
  if (!store || !userId) {
    const { encodeStateAsUpdate } = await import('yjs')
    return encodeStateAsUpdate(doc)
  }
  return recoveryState(store, userId, pageId, doc)
}

export async function forgetCopy(pageId: string): Promise<void> {
  const store = await getStore()
  if (!store || !userId) return
  await store.deleteDoc(userId, pageId).catch(() => {})
  void refreshCounts()
}

export async function listRecovery(): Promise<RecoveryItem[]> {
  const store = await getStore()
  if (!store || !userId) return []
  return store.listRecovery(userId).catch(() => [])
}

export async function deleteRecovery(id: string): Promise<void> {
  const store = await getStore()
  if (!store || !userId) return
  await store.deleteRecovery(userId, id).catch(() => {})
  void refreshCounts()
}

export async function listCopies(): Promise<DocRecord[]> {
  const r = await refreshCounts()
  return r?.docs ?? []
}

/**
 * The pages of a workspace the server just listed: copies of pages that are no longer there are
 * checked one by one (trashed → kept for recovery if they hold unsent edits; no access → deleted).
 * The check itself is the caller's (`check`), so this stays testable.
 */
export async function sweepWorkspace(
  wsId: string,
  listed: ReadonlySet<string>,
  check: (pageId: string) => Promise<'live' | 'trashed' | 'gone' | 'unknown'>,
): Promise<void> {
  const store = await getStore()
  if (!store || !userId) return
  const uid = userId
  let docs: DocRecord[]
  try {
    docs = (await store.listDocs(uid)).filter((d) => d.wsId === wsId && !listed.has(d.pageId) && !openPages.has(d.pageId))
  } catch {
    return
  }
  for (const d of docs) {
    const r = await check(d.pageId).catch(() => 'unknown' as const)
    if (r === 'gone') await store.deleteDoc(uid, d.pageId).catch(() => {})
    else if (r === 'trashed') {
      if (hasPending(d)) {
        const stored = await store.getDoc(uid, d.pageId).catch(() => null)
        if (stored && stored.updates.length) {
          const { mergeUpdates } = await import('yjs')
          await store
            .addRecovery({ userId: uid, pageId: d.pageId, wsId, title: d.title, reason: 'trashed', state: mergeUpdates(stored.updates), createdAt: Date.now() })
            .catch(() => {})
        }
      }
      await store.deleteDoc(uid, d.pageId).catch(() => {})
    }
  }
  void refreshCounts()
}

/** Workspaces the server listed: copies of any other workspace (left, removed, deleted) are deleted. */
export async function sweepWorkspaces(listed: ReadonlySet<string>): Promise<void> {
  const store = await getStore()
  if (!store || !userId) return
  const uid = userId
  try {
    for (const d of await store.listDocs(uid)) {
      if (!listed.has(d.wsId) && !openPages.has(d.pageId)) await store.deleteDoc(uid, d.pageId)
    }
  } catch {
    // next time
  }
  void refreshCounts()
}

/** For sweepWorkspace: what the server says about a page missing from its tree. */
export async function pageStillThere(pageId: string): Promise<'live' | 'trashed' | 'gone' | 'unknown'> {
  try {
    const r = await fetchSyncCheck(pageId)
    if (r.kind === 'gone') return 'gone'
    return r.trashed ? 'trashed' : 'live'
  } catch {
    return 'unknown'
  }
}
