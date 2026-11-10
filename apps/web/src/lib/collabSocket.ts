import type * as Y from 'yjs'
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CollabUser } from '../components/OnlineUsers'
import { setCollabPendingCheck } from './update'
import { createUnsavedTracker, showUnsaved, UNSAVED_SHOW_AFTER_MS } from './unsavedEdits'

// One collab WebSocket per tab (docs/adr/0702-shared-collab-websocket.md).
//
// Hocuspocus multiplexes documents over a single socket (messages carry the document name), so
// the main editor, every page embed, the canvas and the inbox channel can share one connection
// instead of opening one each (the server caps sockets per IP — collab.ts MAX_CONN_PER_IP).
//
// Rules this module enforces:
// - Providers are created by `openCollab()` from inside an effect (never during render), so a
//   render React throws away can never leave a live provider attached to the shared socket.
// - A document name already attached to the shared socket gets a dedicated socket instead:
//   the provider map (client) and the server connection both key documents by name, so two
//   providers for one name on one socket would steal each other's messages.
// - A name that was closed on the shared socket less than REOPEN_GRACE_MS ago also gets a
//   dedicated socket. The server processes a provider's Close asynchronously, so an Auth for the
//   same name sent right after it is routed to the dying connection and dropped ("Received an
//   authentication message on a connection that is already fully authenticated", hocuspocus
//   server ClientConnection/MessageReceiver) — the new provider would then never sync. This is
//   hit by e.g. clicking a page embed: the embed of X is released and the editor for X opens
//   in the same commit.
// - A name the server denied on the shared socket is never retried on it: the server keeps that
//   name marked as established for the socket's lifetime and would queue a new Auth forever.
// - The socket identity is the session cookie sent at upgrade time, so the shared socket is
//   keyed by user id. A different user (logout → login without reload) never reuses it, and it
//   is closed as soon as the last provider is released.

export const collabUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`

const REOPEN_GRACE_MS = 3_000

/**
 * Every live provider (shared or dedicated socket), so the force-update path can tell whether a
 * reload would drop edits (lib/update.ts, docs/adr/0992-*). `unsyncedChanges` counts local
 * updates the server has not acknowledged plus an unfinished initial sync.
 */
const live = new Set<HocuspocusProvider>()
setCollabPendingCheck(() => {
  for (const p of live) if (p.unsyncedChanges > 0) return true
  return false
})

/**
 * Local edits the server has not acknowledged (docs/adr/1926-*): the leave guard below, the
 * deferred release in openCollab and the "not saved yet" indicator (useUnsavedEdits) read it.
 */
export const unsavedEdits = createUnsavedTracker()

// Reload, tab close, navigation away from the app: the browser asks first while an edit is unsent.
// Leaving a page inside the app never drops it either: its provider stays until acknowledged.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    // edits already written to this device's offline copy survive a reload (docs/adr/2204-*)
    if (!unsavedEdits.anyAtRisk()) return
    e.preventDefault()
    // older browsers still need returnValue set to show the prompt
    e.returnValue = ''
  })
}

/** The device copy of a document as the tracker needs it (lib/offline/pageCopy.ts). */
export type DurableCopy = { durable: () => boolean; pending: () => boolean; subscribe: (fn: () => void) => () => void }

/** Wires one provider into the tracker; returns the cleanup. */
function trackUnsaved(provider: HocuspocusProvider, document: Y.Doc, copy?: DurableCopy): () => void {
  unsavedEdits.track(provider)
  // edits stored on the device before this provider existed (loaded from the offline copy) are unsent too
  if (copy?.pending()) unsavedEdits.localEdit(provider)
  const syncDurable = () => unsavedEdits.durable(provider, !!copy?.durable())
  syncDurable()
  const offCopy = copy?.subscribe(syncDurable)
  const onUpdate = (_u: Uint8Array, origin: unknown) => {
    // the provider applies the server's updates with itself as origin; everything else is local
    if (origin !== provider) unsavedEdits.localEdit(provider)
  }
  const onUnsynced = (n: number) => unsavedEdits.unsynced(provider, n)
  const onAuthenticated = () => unsavedEdits.inert(provider, provider.authorizedScope === 'readonly')
  const onDenied = () => unsavedEdits.inert(provider, true)
  document.on('update', onUpdate)
  provider.on('unsyncedChanges', onUnsynced)
  provider.on('authenticated', onAuthenticated)
  provider.on('authenticationFailed', onDenied)
  return () => {
    document.off('update', onUpdate)
    provider.off('unsyncedChanges', onUnsynced)
    provider.off('authenticated', onAuthenticated)
    provider.off('authenticationFailed', onDenied)
    offCopy?.()
    unsavedEdits.untrack(provider)
  }
}

/**
 * Runs `destroy` once the provider holds no unacknowledged local edit (now, or when the server
 * acknowledges them after a reconnect). Until then the provider stays attached and in `live`, so
 * the edits are still sent and the leave guard still sees them (docs/adr/1926-*).
 */
function releaseWhenSaved(provider: HocuspocusProvider, destroy: () => void): void {
  if (!unsavedEdits.isUnsaved(provider)) {
    destroy()
    return
  }
  const off = unsavedEdits.subscribe(() => {
    if (unsavedEdits.isUnsaved(provider)) return
    off()
    destroy()
  })
}

/**
 * True once local edits have waited for the server longer than a normal round trip. Global (any
 * open document, also one the user already left), for the connection indicator.
 */
export function useUnsavedEdits(): boolean {
  const since = useSyncExternalStore(unsavedEdits.subscribe, unsavedEdits.unsavedSince, () => null)
  // re-render once when the wait is over (the store does not change then)
  const [, tick] = useState(0)
  useEffect(() => {
    if (since === null) return
    const wait = since + UNSAVED_SHOW_AFTER_MS - Date.now()
    if (wait <= 0) return
    const t = window.setTimeout(() => tick((n) => n + 1), wait)
    return () => window.clearTimeout(t)
  }, [since])
  return showUnsaved(since, Date.now())
}

/** Whether the unsent edits behind the indicator would survive a reload (all on this device). */
export function useUnsavedAtRisk(): boolean {
  return useSyncExternalStore(unsavedEdits.subscribe, unsavedEdits.anyAtRisk, () => false)
}

/**
 * Watchdog: a document on a connected shared socket that is still not synced after two checks
 * re-sends its Auth + SyncStep1. Before 0702 a stuck document had its own socket, which the 30 s
 * no-message check would recycle; on a shared socket the other documents keep it alive. Covers
 * an Auth the server dropped (e.g. a Close→Auth race beyond the grace window under load).
 * Re-sending is harmless when the first Auth is merely slow (the server queues it).
 */
const SYNC_WATCHDOG_MS = 10_000

type Shared = {
  ws: HocuspocusProviderWebsocket
  userKey: string
  /** document names currently attached */
  names: Set<string>
  /** document name → time it was closed on this socket */
  closedAt: Map<string, number>
  /** document names the server denied on this socket */
  denied: Set<string>
  refs: number
}

let shared: Shared | null = null

function closeShared(s: Shared) {
  if (shared === s) shared = null
  try {
    s.ws.destroy()
  } catch {
    // already torn down
  }
}

function acquireShared(userKey: string): Shared {
  if (shared && shared.userKey !== userKey) {
    // Another identity: retire the old socket for new providers. It closes when its own
    // providers are released (they all unmount on logout because they live under AppLayout).
    const old = shared
    shared = null
    if (old.refs === 0) closeShared(old)
  }
  if (!shared) {
    shared = {
      ws: new HocuspocusProviderWebsocket({ url: collabUrl(), connect: true }),
      userKey,
      names: new Set(),
      closedAt: new Map(),
      denied: new Set(),
      refs: 0,
    }
  }
  return shared
}

export type CollabHandle = {
  provider: HocuspocusProvider
  /** true when this provider rides on the tab-wide socket (false = dedicated fallback). */
  sharedSocket: boolean
  /** Destroys the provider and drops its socket reference. Call exactly once (effect cleanup). */
  release: () => void
}

export type OpenCollabOptions = {
  name: string
  document: Y.Doc
  /** Session owner (user id). Sockets are never shared across identities. */
  userKey: string
  onStateless?: HocuspocusProviderConfiguration['onStateless']
  /** Auth token callback; the offline sync gate (lib/offline/gate.ts) decides there whether to sync. */
  token?: () => Promise<string>
  /** The document's offline copy, if any (durability for the leave guard). */
  copy?: DurableCopy
  /**
   * Runs when the provider is really destroyed — after `release()`, once its edits are acknowledged
   * (it can outlive the editor that opened it): the offline copy clears its unsent marks until then.
   */
  onDestroy?: () => void
}

/**
 * Create a Hocuspocus provider for `name` on the tab-wide socket. Must be called from an effect;
 * pair it with `release()` in that effect's cleanup.
 */
export function openCollab(opts: OpenCollabOptions): CollabHandle {
  const s = acquireShared(opts.userKey)
  const closed = s.closedAt.get(opts.name)
  const recentlyClosed = closed !== undefined && Date.now() - closed < REOPEN_GRACE_MS
  if (closed !== undefined && !recentlyClosed) s.closedAt.delete(opts.name)
  if (s.names.has(opts.name) || recentlyClosed || s.denied.has(opts.name)) {
    // Same document already on the shared socket (e.g. a page embedding itself, or the same
    // embed twice), just closed on it, or denied on it: fall back to a dedicated socket — the
    // pre-0702 behaviour.
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: opts.name,
      document: opts.document,
      token: opts.token ?? 'cookie',
      onStateless: opts.onStateless,
    })
    let released = false
    live.add(provider)
    const untrack = trackUnsaved(provider, opts.document, opts.copy)
    return {
      provider,
      sharedSocket: false,
      release: () => {
        if (released) return
        released = true
        releaseWhenSaved(provider, () => {
          untrack()
          live.delete(provider)
          provider.destroy()
          provider.configuration.websocketProvider?.destroy?.()
          opts.onDestroy?.()
        })
      },
    }
  }

  s.names.add(opts.name)
  s.refs++
  // The constructor attaches to the socket: if it is already open this immediately sends the
  // auth + sync step 1 for this document; otherwise it goes out on the socket's 'open'.
  const provider = new HocuspocusProvider({
    websocketProvider: s.ws,
    name: opts.name,
    document: opts.document,
    token: opts.token ?? 'cookie',
    // Keep the socket when this provider detaches (destroy / permission denied) — other
    // documents still use it. The last release closes it below.
    preserveConnection: true,
    onStateless: opts.onStateless,
    onAuthenticationFailed: () => {
      s.denied.add(opts.name)
    },
  })
  let released = false
  let destroyed = false
  live.add(provider)
  const untrack = trackUnsaved(provider, opts.document, opts.copy)
  let strikes = 0
  const watchdog = window.setInterval(() => {
    if (destroyed || provider.isSynced || s.denied.has(opts.name) || s.ws.status !== 'connected') {
      strikes = 0
      return
    }
    const openEvent = s.ws.receivedOnOpenPayload
    if (++strikes >= 2 && openEvent) {
      strikes = 0
      void provider.onOpen(openEvent as Parameters<HocuspocusProvider['onOpen']>[0])
    }
  }, SYNC_WATCHDOG_MS)
  return {
    provider,
    sharedSocket: true,
    release: () => {
      if (released) return
      released = true
      // Unacknowledged local edits keep the provider (and its socket reference) until the server
      // has them: leaving the page in the app must not drop them (docs/adr/1926-*). The watchdog
      // keeps running meanwhile, so a stuck sync is still retried.
      releaseWhenSaved(provider, () => {
        destroyed = true
        window.clearInterval(watchdog)
        untrack()
        live.delete(provider)
        // destroy(): sends a Close for this document only, detaches it and removes listeners.
        provider.destroy()
        s.names.delete(opts.name)
        s.closedAt.set(opts.name, Date.now())
        s.refs--
        if (s.refs <= 0) closeShared(s)
        opts.onDestroy?.()
      })
    },
  }
}

/** Socket-level status (a provider attached to an already-open socket gets no 'status' event). */
export function readStatus(provider: HocuspocusProvider): 'connected' | 'connecting' | 'disconnected' {
  const st = (provider.configuration.websocketProvider?.status ?? provider.status) as string
  return st === 'connected' || st === 'connecting' ? st : 'disconnected'
}

// ---------------------------------------------------------------------------
// Awareness → online users (docs/adr/0700-awareness-users-equality.md)
// ---------------------------------------------------------------------------

type AwarenessLike = {
  clientID: number
  getStates: () => Map<number, { user?: { name?: string; color?: string; id?: unknown } }>
}

export function readUsers(provider: HocuspocusProvider): CollabUser[] {
  const awareness = provider.awareness as AwarenessLike | null
  if (!awareness) return []
  const selfId = awareness.clientID
  const out: CollabUser[] = []
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === selfId) return
    const user = state?.user
    if (user?.name) {
      // the account id (docs/adr/1846-*); awareness is client-written, so it only picks a status to show
      const userId = typeof user.id === 'string' ? user.id : undefined
      out.push({ clientId, name: user.name, color: user.color ?? '#888888', ...(userId ? { userId } : {}) })
    }
  })
  return out
}

/**
 * Awareness 'change' fires for every remote cursor move / selection change, but the user list
 * (who is here, name, colour) almost never changes. Comparing keeps React from re-rendering the
 * page on each cursor move.
 */
export function sameUsers(a: readonly CollabUser[], b: readonly CollabUser[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.clientId !== y.clientId || x.name !== y.name || x.color !== y.color || x.userId !== y.userId) return false
  }
  return true
}
