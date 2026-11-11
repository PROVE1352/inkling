import { Hocuspocus } from '@hocuspocus/server'
import type { Extension } from '@hocuspocus/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { getSessionUser, SESSION_COOKIE } from './auth'
import { hasRequestGates, runRequestGates } from './requestGates'
import { upgradeOriginAllowed } from './csrf'
import { db } from './db/index'
import { pages, workspaceMembers } from './db/schema'
export { flushDocIndexes } from './docIndexer'
import { visibleTo } from './pageDto'
import { peopleScopeFor, runAsGuest } from './pageGrants'
import { CAP_EDIT, capsFor } from './editLock'
import { liveWorkspace } from './workspaceLive'
import { isTwoFactorBlocked } from './twoFactorPolicy'
import { flushDocIndex, flushDocIndexes, scheduleDocIndex } from './docIndexer'
import { noteLiveEdit, registerTypingFlush } from './context/attribution'
import { maybeAutoSnapshotStored } from './snapshotStore'
import { collabStorageReadOnly, noteBodyStore } from './quota/storage'
import {
  admitCollabUpdate,
  admitSocketFrame,
  collabGuardsOn,
  collabPendingBytes,
  newByteBucket,
  newSocketQueueGuard,
  SOCKET_BURST_BYTES,
  takeBytes,
  noteCollabRefused,
  noteCollabStored,
  noteCollabUnloaded,
  noteSocketConnected,
  noteSocketDisconnected,
  syncGrowthBytes,
  type ByteBucket,
  type SocketQueueGuard,
} from './quota/collabGrowth'
import { onInstanceFullChange } from './quota/instance'
import { liveDocChangedSinceStore, liveDocSeq, noteLiveStored, registerHocuspocus, trackLiveDoc } from './liveConnections'
import { createHash } from 'node:crypto'
import { parseCookies } from './util'
import { trustedClientIp } from './guard'
import { lifecycle, withRetry } from './lifecycle'
import { applyStoredState, encodeStoredState, STATE_V1, STATE_V2, wholeStateFormat } from './yState'
import { DOC_SCHEMA_VERSION, parseSchemaVersion, SCHEMA_PARAM } from '@inkling/shared'
import { docSchemaNeeds, refreshDocSchema, schemaOfStoredState, watchDocSchema } from './docSchema'

const uuidSchema = z.uuid()

// inbox channel document-name convention: `inbox:<userId>`. An empty document used only for stateless notifications;
// it is never part of Yjs persistence (page_docs), snapshots, or backlink/text/tag indexing.
const INBOX_PREFIX = 'inbox:'

// Only page documents are persisted/indexed: those whose documentName is a plain UUID.
// Non-UUID names such as inbox:<uuid> can't even be parsed by the DB (pageDocs.pageId is a uuid column),
// so fetch/store and every store hook (snapshots, reindex*) must filter them out here as no-ops.
function isPageDocument(documentName: string): boolean {
  return uuidSchema.safeParse(documentName).success
}

/**
 * What page_docs holds for each loaded document (docs/adr/1042-*): the digest of the stored state
 * and its stamp (page_docs.updated_at as text). A store whose state has the same digest changes
 * nothing, so it skips the write and the re-index (a DirectConnection stores once on transact and
 * again on disconnect). Keyed by the document object, so an unload and reload of the same page
 * never mix their records.
 */
const persisted = new WeakMap<Y.Doc, { digest: string; stamp: string | null; legacy: boolean }>()
/** What the load saw, handed to afterLoadDocument of the same load. */
const loadedStamps = new Map<
  string,
  { stamp: string | null; indexed: boolean; digest: string | null; legacy: boolean; state: Uint8Array | null }
>()

function stateDigest(state: Uint8Array): string {
  return createHash('sha1').update(state).digest('base64')
}

/**
 * Yjs state persistence in page_docs.state (docs/adr/1101-*, 1102-*). An extension of our own
 * instead of @hocuspocus/extension-database: that one encodes the whole document (V1) before calling
 * `store`, which then had to encode it again from the live doc inside the serialised chain, so every
 * store paid two full encodes. Loads accept V1 and V2 rows; stores write V2.
 */
const persistence: Extension = {
  async onLoadDocument({ documentName, document }) {
    // Non-UUID documents such as inbox have no persisted state: load as an empty document.
    if (!isPageDocument(documentName)) return
    const [row] = (await db.execute(sql`
      SELECT d.state, d.updated_at::text AS stamp,
             EXISTS (SELECT 1 FROM page_chunk_index m WHERE m.page_id = ${documentName}) AS indexed
        FROM (SELECT 1) one LEFT JOIN page_docs d ON d.page_id = ${documentName}
    `)) as unknown as { state: Buffer | null; stamp: string | null; indexed: boolean }[]
    const state = row?.state && row.state.length > 0 ? row.state : null
    if (state) applyStoredState(document, state)
    // A V1 row is converted by the next store even when nothing changed (gradual conversion,
    // docs/adr/1101-*): remember the digest of its V2 encoding so that store recognises "unchanged".
    const legacy = !!state && wholeStateFormat(state) === STATE_V1
    loadedStamps.set(documentName, {
      stamp: row?.stamp ?? null,
      indexed: !!row?.indexed,
      digest: state ? stateDigest(legacy ? encodeStoredState(document) : state) : null,
      legacy,
      state,
    })
  },
  async onStoreDocument({ documentName, document, socketId }) {
    // Non-UUID documents such as inbox are never stored/snapshotted/indexed: skip every store hook.
    if (!isPageDocument(documentName)) return
    try {
      await storeLive(documentName, document, socketId)
    } catch (err) {
      // The write failed after its retries (docs/adr/1921-*). Hocuspocus would only store again on
      // the next change, and once the last client leaves nothing comes: a retry timer stores it,
      // and the unload guard below keeps the document in memory until one store succeeds.
      console.error(`[inkling] collab store of ${documentName} failed; retrying in the background`, err)
      scheduleStoreRetry(documentName, document)
      // A DirectConnection write (REST/MCP) awaits this store: it must still see the failure.
      if (socketId === 'server') throw err
    }
  },
  /**
   * Unload guard (docs/adr/1921-*): a document that changed since its last successful store is
   * stored before it leaves memory. If that fails too it stays (a pin counts as a connection, so
   * Hocuspocus's own re-check after this hook keeps it) until the retry timer stores it.
   */
  async beforeUnloadDocument({ documentName }) {
    if (!isPageDocument(documentName)) return
    const document = hocuspocus.documents.get(documentName)
    if (!document || !loadedDocs.has(document)) return // never loaded: nothing of ours to lose
    if (!liveDocChangedSinceStore(document)) return
    const prev = persisted.get(document)
    if (prev && prev.digest === stateDigest(encodeStoredState(document))) return
    try {
      await storeLive(documentName, document, 'server')
    } catch (err) {
      if (collabDestroying) {
        console.error(`[inkling] ${documentName}: unsaved changes lost at shutdown, the store failed`, err)
        return
      }
      console.error(`[inkling] ${documentName} has unsaved changes and the store failed; keeping it in memory`, err)
      pinUnsaved(documentName, document)
    }
  },
}

/** Set while destroyCollab runs: the unload guard stores but no longer keeps documents. */
let collabDestroying = false

/** Documents whose load finished (a failed load must never be stored: it would write an empty doc). */
const loadedDocs = new WeakSet<Y.Doc>()

/**
 * Stores of one document are serialised: Hocuspocus only debounces *timers*, so a
 * DirectConnection store (debounce 0) can run while a client store is mid-flight, and the
 * one holding the older state could finish last and overwrite page_docs. Inside the chain
 * we encode from the live Y.Doc, so whichever store runs last writes the newest state.
 */
function storeLive(documentName: string, document: Y.Doc & { getConnectionsCount?: () => number }, socketId: string | undefined): Promise<void> {
  return serialStore(documentName, async () => {
    // Update counter at encode time: the live doc equals what this store writes (docs/adr/1041-*).
    const seq = liveDocSeq(document)
    // the growth counted for the storage limit that this encode covers (quota/collabGrowth.ts)
    const pending = collabPendingBytes(documentName)
    const state = Buffer.from(encodeStoredState(document))
    const used = await storeDocument(documentName, state, Buffer.from(Y.encodeStateVector(document)), document, socketId, document, seq)
    noteCollabStored(documentName, state.length, pending, used)
    clearStoreRetry(documentName, document)
  })
}

interface StoreRetry {
  doc: Y.Doc
  attempt: number
  timer: NodeJS.Timeout | null
  /** The unload guard pinned the document (one direct-connection count) until a store succeeds. */
  pinned: boolean
}
/** Pending store retries by document name (docs/adr/1921-*). */
const storeRetries = new Map<string, StoreRetry>()

function scheduleStoreRetry(documentName: string, document: Y.Doc): void {
  let r = storeRetries.get(documentName)
  if (r && r.doc !== document) {
    clearStoreRetry(documentName, r.doc)
    r = undefined
  }
  if (!r) {
    r = { doc: document, attempt: 0, timer: null, pinned: false }
    storeRetries.set(documentName, r)
  }
  if (r.timer) return
  const wait = Math.min(collabStoreRetry.baseMs * 2 ** r.attempt, collabStoreRetry.maxMs)
  const entry = r
  entry.timer = setTimeout(() => {
    entry.timer = null
    void runStoreRetry(documentName, entry)
  }, wait)
  entry.timer.unref?.()
}

async function runStoreRetry(documentName: string, r: StoreRetry): Promise<void> {
  if (storeRetries.get(documentName) !== r) return
  const doc = r.doc as Y.Doc & { getConnectionsCount?: () => number; removeDirectConnection?: () => void }
  if (hocuspocus.documents.get(documentName) !== doc) {
    // unloaded (after a successful store) or replaced by a reload: nothing left to retry
    storeRetries.delete(documentName)
    return
  }
  try {
    await storeLive(documentName, doc, r.pinned ? 'server' : undefined)
  } catch (err) {
    r.attempt++
    console.error(`[inkling] collab store retry ${r.attempt} of ${documentName} failed`, err)
    scheduleStoreRetry(documentName, doc)
  }
}

/**
 * A store succeeded: drop the retry. A pinned document is released, and a document nobody is on any
 * more (pinned, or left behind when a failed DirectConnection store skipped Hocuspocus's own
 * unload) is unloaded now that it is saved.
 */
function clearStoreRetry(documentName: string, document: Y.Doc): void {
  const r = storeRetries.get(documentName)
  if (!r || r.doc !== document) return
  storeRetries.delete(documentName)
  if (r.timer) clearTimeout(r.timer)
  const doc = document as Y.Doc & { getConnectionsCount: () => number; removeDirectConnection: () => void }
  if (r.pinned) doc.removeDirectConnection()
  if (doc.getConnectionsCount() === 0 && hocuspocus.documents.get(documentName) === document) {
    // after the store chain step that called us, so the guard's own store does not wait on itself
    setImmediate(() => {
      if (doc.getConnectionsCount() !== 0 || hocuspocus.documents.get(documentName) !== document) return
      void hocuspocus.unloadDocument(document as Parameters<typeof hocuspocus.unloadDocument>[0]).catch((err: unknown) =>
        console.error('[inkling] unload after a retried store failed', documentName, err),
      )
    })
  }
}

function pinUnsaved(documentName: string, document: Y.Doc): void {
  scheduleStoreRetry(documentName, document)
  const r = storeRetries.get(documentName)!
  if (!r.pinned) {
    r.pinned = true
    ;(document as Y.Doc & { addDirectConnection: () => void }).addDirectConnection()
  }
}

/**
 * Stores and indexes the open documents among `pageIds` now (docs/adr/1923-*), for copies made in
 * Postgres (duplicate copies page_docs, page_texts and page_chunks row by row): without it the copy
 * misses what was typed within the store debounce (2–10 s). Unchanged documents only finish their
 * pending index pass. A store failure propagates: the caller must not copy a stale state silently.
 */
export async function flushLiveDocuments(pageIds: string[]): Promise<void> {
  for (const id of pageIds) {
    const doc = hocuspocus.documents.get(id)
    if (!doc || !loadedDocs.has(doc)) continue
    if (liveDocChangedSinceStore(doc)) await storeLive(id, doc, 'server')
    else await flushDocIndex(id)
  }
}

/** Documents kept in memory because their changes are not stored yet (shutdown log, tests). */
export function unsavedPinnedDocuments(): string[] {
  return [...storeRetries.entries()].filter(([, r]) => r.pinned).map(([name]) => name)
}

const storeChains = new Map<string, Promise<void>>()

function serialStore(name: string, run: () => Promise<void>): Promise<void> {
  const prev = storeChains.get(name) ?? Promise.resolve()
  const job = prev.catch(() => {}).then(run)
  storeChains.set(name, job)
  void job
    .catch(() => {})
    .finally(() => {
      if (storeChains.get(name) === job) storeChains.delete(name)
    })
  return job
}

async function storeDocument(
  documentName: string,
  state: Buffer,
  stateVector: Buffer,
  document: { getConnectionsCount?: () => number } | undefined,
  socketId: string | undefined,
  live: Y.Doc | null = null,
  seq: number | null = null,
): Promise<number | null> {
  const lastClientGone = document?.getConnectionsCount?.() === 0
  const immediate = socketId === 'server' || lastClientGone
  const digest = stateDigest(state)
  const prev = live ? persisted.get(live) : undefined
  if (prev && prev.digest === digest) {
    // Same bytes as page_docs already holds: no write, no snapshot, no re-index (docs/adr/1042-*).
    // A pass the previous store left debounced still runs now when this store would have run one.
    // A V1 row is rewritten as V2 here, keeping its stamp: same document, no snapshot, no
    // updated_at bump, no re-index (docs/adr/1101-*).
    if (prev.legacy) {
      prev.legacy = false
      await convertStoredState(documentName, state, stateVector, prev.stamp)
    }
    if (live) noteLiveStored(live, seq, prev.stamp)
    storeStats.skipped++
    if (immediate) await flushDocIndex(documentName)
    return null
  }
  storeStats.written++
  {
    // Auto snapshot of the state we are about to overwrite — decided and copied inside Postgres
    // (no full-state SELECT into Node), skipped from memory while the 10-min throttle is open.
    // Never throws (docs/adr/0750-*).
    const snapshotBytes = await maybeAutoSnapshotStored(documentName)
    // Storage limit (docs/adr/2506-*): the cached use follows the body and the version copy; never
    // throws, never refuses (what does not fit is refused on arrival, beforeHandleMessage).
    const used = await noteBodyStore(documentName, state.length + stateVector.length, snapshotBytes)

    // Persist the state and bump pages.updated_at in one round trip. A short database outage
    // must not drop edits: retry with backoff (3 retries, ~1.75 s total), then rethrow. The store
    // hook then arms a retry timer and the unload guard keeps the document in memory until a store
    // succeeds (B-H1, docs/adr/1921-*).
    const rows = (await withRetry(
      () =>
        db.execute(sql`
          WITH d AS (
            INSERT INTO page_docs (page_id, state, state_format, state_vector, updated_at)
            VALUES (${documentName}, ${state}, ${STATE_V2}, ${stateVector}, now())
            ON CONFLICT (page_id) DO UPDATE
              SET state = EXCLUDED.state, state_format = EXCLUDED.state_format,
                  state_vector = EXCLUDED.state_vector, updated_at = now()
            RETURNING page_id, updated_at
          ), u AS (
            UPDATE pages SET updated_at = now() WHERE id IN (SELECT page_id FROM d)
          )
          SELECT updated_at::text AS stamp FROM d
        `),
      {
        attempts: 4,
        onRetry: (err, n) =>
          console.error(`[inkling] collab store of ${documentName} failed (retry ${n}/3)`, err),
      },
    )) as unknown as { stamp: string }[]
    const stamp = rows[0]?.stamp ?? null
    if (live) {
      persisted.set(live, { digest, stamp, legacy: false })
      noteLiveStored(live, seq, stamp)
    }

    // Derived indexes (backlinks, search text, tags, dated tasks). Server-side DirectConnection
    // edits (REST/MCP/sync) and the final store after the last client leaves index right away;
    // live typing is debounced and diffed in docIndexer. Failures never fail the store.
    await scheduleDocIndex(documentName, state, immediate, stamp)
    return used
  }
}

/**
 * Rewrites an unchanged V1 row as V2 (docs/adr/1101-*). Only when page_docs still holds the state
 * this document was loaded from (same stamp): any other writer in between wins. Never throws.
 */
async function convertStoredState(documentName: string, state: Buffer, stateVector: Buffer, stamp: string | null): Promise<void> {
  if (stamp === null) return
  try {
    const rows = (await db.execute(sql`
      UPDATE page_docs SET state = ${state}, state_format = ${STATE_V2}, state_vector = ${stateVector}
       WHERE page_id = ${documentName} AND updated_at::text = ${stamp}
      RETURNING 1 AS ok
    `)) as unknown as { ok: number }[]
    if (rows.length > 0) storeStats.converted++
  } catch (err) {
    console.error('[inkling] V2 conversion of page_docs failed', documentName, err)
  }
}

/** Retry timer of a failed store (docs/adr/1921-*): first wait, doubling up to the cap. Tests shorten it. */
export const collabStoreRetry = { baseMs: 5_000, maxMs: 60_000 }

/** Test/bench hook: stores written vs skipped as unchanged, V1 rows rewritten as V2 (docs/adr/1042-*, 1101-*). */
export const storeStats = { written: 0, skipped: 0, converted: 0 }

/**
 * Hocuspocus instance: used by the snapshots route to push a restore live into an open
 * document through openDirectConnection.
 */
export const hocuspocus = new Hocuspocus({
  debounce: 2000,
  maxDebounce: 10000,
  quiet: true,
  // Shutdown is coordinated together with fastify, so disable automatic signal handling
  stopOnSignals: false,
  extensions: [persistence],
  // Track updates of loaded page documents so reads know when the live doc still equals the
  // stored (and indexed) state (docs/adr/1041-*).
  async afterLoadDocument({ documentName, document }) {
    if (!isPageDocument(documentName)) return
    const loaded = loadedStamps.get(documentName)
    loadedStamps.delete(documentName)
    trackLiveDoc(document, loaded?.stamp ?? null)
    loadedDocs.add(document)
    // Document schema (docs/adr/2425-*): connections of older clients become read-only the moment
    // the page gains a node type they do not know.
    watchDocSchema(document, onSchemaRaised)
    if (loaded?.digest) persisted.set(document, { digest: loaded.digest, stamp: loaded.stamp, legacy: loaded.legacy })
    // A page never indexed (created without the indexer, or with no stored state yet) gets its
    // current state indexed before the first edit, so that edit is diffed against it in the change
    // feed instead of being the silent first index. Unchanged stores used to do this as a side
    // effect; they are skipped now (docs/adr/1042-*).
    // The bytes just loaded are that state: no re-encode (docs/adr/1102-*).
    if (loaded && !loaded.indexed) {
      await scheduleDocIndex(documentName, loaded.state ?? encodeStoredState(document), true, loaded.stamp)
    }
  },

  // Who is typing where (docs/adr/1002-*): attributes body mentions and followed-page updates.
  async onChange(data) {
    const uid = (data.context as { userId?: unknown } | undefined)?.userId
    if (typeof uid === 'string' && isPageDocument(data.documentName)) noteLiveEdit(data.documentName, uid)
  },
  // The storage counters of a page leave with it (quota/collabGrowth.ts).
  async afterUnloadDocument({ documentName }) {
    if (isPageDocument(documentName)) noteCollabUnloaded(documentName)
  },
  async onDisconnect({ documentName, context }) {
    const guard = (context as { queueGuard?: SocketQueueGuard } | undefined)?.queueGuard
    if (guard) noteSocketDisconnected(guard, documentName)
  },
  // Document schema guard (docs/adr/2425-*), before every message a connection sends: a client older
  // than the page's newest node type never writes it. Hocuspocus checks `readOnly` when it applies the
  // message, after this hook, so an update sent after the page gained such a node is dropped
  // (SyncStatus false) even when the connection was authorised before. Cheap for current clients.
  async beforeHandleMessage({ connection, context, document, documentName, update }) {
    // Storage limit and instance fuse (contract §14, docs/adr/2530-*): an update that does not fit is
    // never applied. Decided synchronously, before anything else here awaits.
    if (!connection.readOnly && collabGuardsOn() && isPageDocument(documentName) && loadedDocs.has(document)) {
      const bytes = syncGrowthBytes(update)
      const ws = (context as { workspaceId?: unknown } | undefined)?.workspaceId
      if (bytes > 0 && typeof ws === 'string') {
        const verdict = admitCollabUpdate(documentName, ws, bytes, () => encodeStoredState(document).length)
        if (verdict !== 'ok') {
          connection.readOnly = true
          if (verdict !== 'instance') noteCollabRefused(documentName, verdict)
          reconnectForStorage(connection as unknown as SchemaConnection & { sendStateless?: (p: string) => void }, verdict)
          return
        }
      }
    }
    const client = (context as { schema?: unknown } | undefined)?.schema
    if (typeof client !== 'number' || client >= DOC_SCHEMA_VERSION || connection.readOnly) return
    if (!isPageDocument(documentName) || !loadedDocs.has(document)) return
    if (docSchemaNeeds(document) > client) {
      connection.readOnly = true
      reconnectForSchema([connection as unknown as SchemaConnection])
    }
  },
  async onAuthenticate(data) {
    // 1) Session -> user from the upgrade request cookie
    const cookies = parseCookies(data.requestHeaders.cookie)
    const token = cookies[SESSION_COOKIE]
    if (!token) throw new Error('Unauthorized')
    const user = await getSessionUser(token)
    if (!user) throw new Error('Unauthorized')
    // Request gates (docs/adr/2502-*): the same checks as REST, for every document and the inbox.
    if (hasRequestGates()) await runRequestGates({ user, req: null, via: 'collab', channel: 'collab' })

    // 1.5) inbox channel (`inbox:<userId>`): stateless notifications only.
    //      Only subscribing to your own inbox is allowed (others' inboxes are blocked). It is an empty doc with no Yjs content,
    //      so it never touches page_docs/snapshots/indexing (fetch/store skip it via the UUID guard).
    if (data.documentName.startsWith(INBOX_PREFIX)) {
      const inboxUserId = data.documentName.slice(INBOX_PREFIX.length)
      if (inboxUserId !== user.id) throw new Error('Forbidden')
      return { userId: user.id, sessionToken: token }
    }

    // 2) Check that documentName is a UUID
    const parsed = uuidSchema.safeParse(data.documentName)
    if (!parsed.success) throw new Error('Invalid document name')
    const pageId = parsed.data

    // 3) The page must be alive and visible to me (collab connections to private pages are owner-only, rule 4).
    //    Even if someone else knows the URL, a private page is rejected here as not found.
    //    An account with page rows runs the lookup in its guest scope (docs/adr/1252-*): in a workspace
    //    where it is a guest, only the pages under its rows exist.
    const scope = await peopleScopeFor(user.id, !!user.hasGrants, false)
    const page = await runAsGuest(scope, async () =>
      (
        await db
          .select({ workspaceId: pages.workspaceId, docGen: pages.docGen })
          .from(pages)
          .where(and(eq(pages.id, pageId), isNull(pages.deletedAt), visibleTo(user.id), liveWorkspace(pages.workspaceId)))
          .limit(1)
      )[0],
    )
    if (!page) throw new Error('Page not found')

    const member = (
      await db
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, page.workspaceId),
            eq(workspaceMembers.userId, user.id),
          ),
        )
        .limit(1)
    )[0]
    const guest = !member && scope.workspaces.has(page.workspaceId)
    if (!member && !guest) throw new Error('Forbidden')
    // "Require two-step verification" (docs/adr/1112-*): no live editing once the grace period is over.
    // Guests follow the workspace's rule too (docs/adr/1253-*).
    if (await isTwoFactorBlocked(page.workspaceId, user.id)) throw new Error('TWO_FACTOR_REQUIRED')

    // Edit lock (docs/adr/0970-*) and the page's people rows (docs/adr/1251-*): someone who may not
    // edit the page gets a read-only connection. Hocuspocus then answers their sync updates with
    // SyncStatus(false) and never applies them; the client learns the scope from the authenticated
    // message. Lock and people changes close the live sockets of the subtree, so a reconnect always
    // re-evaluates this.
    const caps = await runAsGuest(scope, () =>
      capsFor(db, [pageId], { userId: user.id, role: member ? member.role : 'guest', agent: false }),
    )
    if (!((caps.get(pageId) ?? 0) & CAP_EDIT)) data.connection.readOnly = true
    // Storage limit (docs/adr/2506-*): a full workspace, or a page past its body cap, is read-only.
    if (!data.connection.readOnly && (await collabStorageReadOnly(pageId, page.workspaceId))) data.connection.readOnly = true

    // Document schema (docs/adr/2425-*): the client's version comes with the socket URL; 0.19 and
    // older send none (1). An older client than the page needs gets a read-only connection, decided
    // here because the scope goes out before the document is loaded. Only older clients pay the walk.
    const schema = parseSchemaVersion(data.requestParameters.get(SCHEMA_PARAM))
    let schemaNeeds: number | undefined
    if (schema < DOC_SCHEMA_VERSION) {
      const need = await pageSchemaNeeds(pageId)
      if (need > schema) {
        data.connection.readOnly = true
        schemaNeeds = need
      }
    }

    // sessionToken lets liveConnections close exactly the sockets of revoked sessions.
    // docGen is read here, before any content is sent to this connection, and handed to it in
    // `connected` (docs/adr/2201-*): a client never pairs a newer generation with older content.
    // workspaceId: the storage counters of live editing (quota/collabGrowth.ts) are per workspace
    return { userId: user.id, sessionToken: token, docGen: page.docGen, schema, schemaNeeds, workspaceId: page.workspaceId }
  },
  // The page's document generation for device copies (docs/adr/2201-*). Older clients ignore it.
  async connected({ context, connectionInstance, documentName }) {
    const ctx = context as { docGen?: unknown; schemaNeeds?: unknown; queueGuard?: SocketQueueGuard } | undefined
    if (ctx?.queueGuard) noteSocketConnected(ctx.queueGuard, documentName)
    try {
      if (typeof ctx?.docGen === 'number') connectionInstance.sendStateless(JSON.stringify({ t: 'gen', gen: ctx.docGen }))
      // read-only because the page needs a newer app (docs/adr/2425-*): clients that know the
      // message say so; 0.19 ignores unknown messages
      if (typeof ctx?.schemaNeeds === 'number') connectionInstance.sendStateless(JSON.stringify({ t: 'schema', needs: ctx.schemaNeeds }))
    } catch {
      // the socket went away meanwhile
    }
  },
})

registerHocuspocus(hocuspocus)

type SchemaConnection = { readOnly: boolean; context?: unknown; webSocket?: { close: (code?: number, reason?: string) => void } }

/**
 * The schema a page needs (docs/adr/2425-*): from the live document when it is loaded (walked again,
 * so a group removed since counts), otherwise from page_docs.
 */
export async function pageSchemaNeeds(pageId: string): Promise<number> {
  const live = hocuspocus.documents.get(pageId)
  if (live && loadedDocs.has(live)) return refreshDocSchema(live)
  const [row] = (await db.execute(sql`SELECT state FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { state: Buffer | null }[]
  return schemaOfStoredState(row?.state ?? null)
}

/**
 * A page just gained a node type (docs/adr/2425-*): every connection of an older client becomes
 * read-only now (synchronously, so the deletion its editor answers with is never applied), and its
 * socket is closed so the client reconnects and learns the read-only scope.
 */
function onSchemaRaised(doc: Y.Doc, need: number): void {
  const hit: SchemaConnection[] = []
  for (const conn of (doc as unknown as { getConnections: () => SchemaConnection[] }).getConnections()) {
    const client = (conn.context as { schema?: unknown } | undefined)?.schema
    if (typeof client !== 'number' || client >= need || conn.readOnly) continue
    conn.readOnly = true
    hit.push(conn)
  }
  if (hit.length) reconnectForSchema(hit)
}

/** Close code of that reconnect: an ordinary close, so the provider connects again at once (not 4401/4403). */
export const SCHEMA_RECONNECT_CODE = 4000

function reconnectForSchema(conns: SchemaConnection[]): void {
  setImmediate(() => {
    for (const c of conns) {
      try {
        c.webSocket?.close(SCHEMA_RECONNECT_CODE, 'document-schema')
      } catch {
        // already closed
      }
    }
  })
}
/** Close code of the storage reconnect: ordinary, so the provider connects again and is authorised read-only. */
export const STORAGE_RECONNECT_CODE = 4000

/**
 * An update did not fit (docs/adr/2530-*): the connection is read-only already (so nothing more from it
 * is applied); tell the client why and close its socket, so it reconnects and learns the read-only scope.
 */
function reconnectForStorage(conn: SchemaConnection & { sendStateless?: (p: string) => void }, why: string): void {
  try {
    conn.sendStateless?.(JSON.stringify({ t: 'storage', why }))
  } catch {
    // the socket is going away
  }
  setImmediate(() => {
    try {
      conn.webSocket?.close(STORAGE_RECONNECT_CODE, 'storage-full')
    } catch {
      // already closed
    }
  })
}

/**
 * The instance fuse (quota/instance.ts) tripped or cleared: live editing connections close so they come
 * back read-only, or read-only ones close so they are authorised anew. Only registered listeners run,
 * and the fuse only measures with LIMIT_INSTANCE_STORAGE_MB set.
 */
onInstanceFullChange((full) => {
  const sockets = new Set<{ close: (code?: number, reason?: string) => void }>()
  try {
    for (const [name, doc] of hocuspocus.documents) {
      if (!isPageDocument(name)) continue
      for (const conn of doc.getConnections()) {
        if (full === conn.readOnly) continue
        if (full) conn.readOnly = true
        const ws = (conn as unknown as SchemaConnection).webSocket
        if (ws) sockets.add(ws)
      }
    }
  } catch (err) {
    console.error('[inkling] instance fuse: collecting live connections failed', err)
  }
  setImmediate(() => {
    for (const ws of sockets) {
      try {
        ws.close(STORAGE_RECONNECT_CODE, full ? 'instance-full' : 'instance-room')
      } catch {
        // already closed
      }
    }
  })
})

// Before a server edit of a page someone is typing in, index the live document first, so the
// typing is logged as the typist's and the edit's change rows hold only the edit (CF-2,
// docs/adr/1625-*). The state indexed here is not stored yet; the edit's store follows at once.
registerTypingFlush(async (pageId) => {
  const doc = hocuspocus.documents.get(pageId)
  if (!doc) return
  await scheduleDocIndex(pageId, encodeStoredState(doc), true, null)
})

/**
 * Broadcast a stateless message to the collab clients that have the page open.
 * No-op if the document is not in memory (= nobody has it open); only clients with it open need it.
 * Fully isolated so a broadcast failure never breaks the caller (REST API).
 */
export function broadcastToPage(pageId: string, msg: object): void {
  try {
    hocuspocus.documents.get(pageId)?.broadcastStateless(JSON.stringify(msg))
  } catch (err) {
    console.error('[inkling] broadcastToPage failed', pageId, err)
  }
}

/**
 * Broadcast a stateless message to a user's inbox channel (`inbox:<userId>`).
 * No-op if the user isn't subscribed to the inbox; the next poll (the fallback) picks it up.
 */
export function broadcastToUser(userId: string, msg: object): void {
  try {
    hocuspocus.documents
      .get(`${INBOX_PREFIX}${userId}`)
      ?.broadcastStateless(JSON.stringify(msg))
  } catch (err) {
    console.error('[inkling] broadcastToUser failed', userId, err)
  }
}

// Yjs updates are small: a 2 MB cap blocks abuse with huge frames.
const MAX_PAYLOAD = 2 * 1024 * 1024
// Max concurrent collab sockets per IP (upgrade rejected beyond it).
// Audit F2: behind the proxy (Caddy) the client IP is restored from XFF, so per-client isolation holds.
// Set generously so normal users (many tabs) aren't blocked; only runaway clients are.
const MAX_CONN_PER_IP = 40
// Audit F3: limit upgrade attempts themselves per IP with a sliding window (mitigates auth floods).
const UPGRADE_WINDOW_MS = 10_000
const MAX_UPGRADES_PER_WINDOW = 30
// Hardening H2: upgrades rejected with 401/429 never go through the ws.on('close') cleanup path, so
// upgradeHits entries linger. When the map grows past this threshold, an upgrade attempt sweeps
// every entry once against the window (drops expired timestamps + deletes empty arrays).
const UPGRADE_HITS_SWEEP_THRESHOLD = 1024

/**
 * Client IP of an upgrade request: X-Forwarded-For is honoured only through the TRUST_PROXY hops,
 * exactly like Fastify's trustProxy for HTTP requests (C-L3). Trusting XFF unconditionally let a
 * direct client pick any IP and dodge the per-IP limits below.
 */
function clientIp(req: IncomingMessage): string {
  return trustedClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'])
}

/** Wire the HTTP server's /collab upgrades to Hocuspocus. */
export function attachCollab(httpServer: HttpServer): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    // Opening a large document (multi-MB Yjs state) used to send the first sync uncompressed; measured 3.7 MB -> 0.78 MB.
    perMessageDeflate: { threshold: 1024 },
  })

  // Active connection count per client IP.
  const connCountByIp = new Map<string, number>()
  // Storage guards (docs/adr/2530-*): the byte rate bucket per client IP.
  const bucketByIp = new Map<string, ByteBucket>()
  // Recent upgrade-attempt timestamps per client IP (sliding window).
  const upgradeHits = new Map<string, number[]>()

  // Don't propagate errors of the WebSocketServer itself (e.g. during upgrade handling) to the process.
  wss.on('error', (err) => {
    console.error('[inkling] collab wss error', err)
  })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    if (!collabGuardsOn()) {
      hocuspocus.handleConnection(socket, request)
      return
    }
    // Storage limit or instance fuse set (docs/adr/2530-*): bound the bytes a socket sends per second
    // and the frames Hocuspocus queues for documents not connected on it (it keeps them without
    // limit). Listening before Hocuspocus does, so this runs first for every frame.
    const ip = clientIp(request)
    // kept after the last socket closes (a reconnect must not refill it); a bucket that has refilled
    // completely says nothing and goes when the map grows
    if (bucketByIp.size > 1024) for (const [k, b] of bucketByIp) if (!connCountByIp.has(k) && takeBytes(b, 0) && b.tokens >= SOCKET_BURST_BYTES) bucketByIp.delete(k)
    let bucket = bucketByIp.get(ip)
    if (!bucket) bucketByIp.set(ip, (bucket = newByteBucket()))
    const queueGuard = newSocketQueueGuard(bucket)
    let closing = false
    socket.on('message', (data: Buffer) => {
      if (closing) return
      const why = admitSocketFrame(queueGuard, data)
      if (!why) return
      closing = true
      console.warn(`[inkling] collab socket closed: ${why === 'rate' ? 'it sent faster than the storage guard allows' : 'too many bytes for documents it has not opened'}`)
      // terminate, not close: the frames already received must not be handled while a close handshake runs
      socket.terminate()
    })
    hocuspocus.handleConnection(socket, request, { queueGuard })
  })

  const reject = (socket: Duplex, status: string): void => {
    try {
      if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    } catch {
      // ignore — destroyed below
    }
    socket.destroy()
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A socket error before the WebSocket exists must not become an unhandled 'error' event.
    socket.on('error', () => socket.destroy())
    void (async () => {
      // Shutting down: no new collaborators while documents are being flushed (B-H2).
      if (lifecycle.shuttingDown) {
        reject(socket, '503 Service Unavailable')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname !== '/collab') {
        socket.destroy()
        return
      }

      const ip = clientIp(req)

      // 0) Audit F3: sliding-window throttle on upgrade attempts (regardless of auth,
      //    blocked before any DB round trip; mitigates auth floods).
      const now = Date.now()
      // H2: rejection paths (401/429) skip the close cleanup, so upgradeHits can leak.
      //     When the map passes the threshold, sweep expired entries in bulk (delete empty arrays).
      if (upgradeHits.size > UPGRADE_HITS_SWEEP_THRESHOLD) {
        for (const [k, ts] of upgradeHits) {
          const fresh = ts.filter((t) => now - t < UPGRADE_WINDOW_MS)
          if (fresh.length === 0) upgradeHits.delete(k)
          else upgradeHits.set(k, fresh)
        }
      }
      const hits = (upgradeHits.get(ip) ?? []).filter(
        (t) => now - t < UPGRADE_WINDOW_MS,
      )
      hits.push(now)
      upgradeHits.set(ip, hits)
      if (hits.length > MAX_UPGRADES_PER_WINDOW) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }

      // 0) Cross-site WebSocket hijacking (C-L4, docs/adr/1062-*): a browser always sends Origin on
      //    the handshake, and the session cookie rides along, so another site's page must not open it.
      if (!upgradeOriginAllowed(req.headers).ok) {
        reject(socket, '403 Forbidden')
        return
      }

      // 1) Cookie auth at upgrade time: removes the pre-auth queuing window for anonymous sockets.
      //    (Per-document authorization is checked again in onAuthenticate: defense in depth.)
      const cookies = parseCookies(req.headers.cookie)
      const token = cookies[SESSION_COOKIE]
      const user = token ? await getSessionUser(token) : null
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      // 2) Per-IP connection cap: reject beyond it
      if ((connCountByIp.get(ip) ?? 0) >= MAX_CONN_PER_IP) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        connCountByIp.set(ip, (connCountByIp.get(ip) ?? 0) + 1)
        // Always attach a listener so socket-level errors such as exceeding maxPayload don't kill
        // the process as an unhandled 'error' (prevents one-shot crashes from malicious clients).
        ws.on('error', (err) => {
          console.error('[inkling] collab ws error', err)
        })
        ws.on('close', () => {
          const n = (connCountByIp.get(ip) ?? 1) - 1
          if (n <= 0) connCountByIp.delete(ip)
          else connCountByIp.set(ip, n)
          // Keep the upgradeHits map from growing without bound: clear expired records of IPs with no connections
          if (!connCountByIp.has(ip)) {
            const fresh = (upgradeHits.get(ip) ?? []).filter(
              (t) => Date.now() - t < UPGRADE_WINDOW_MS,
            )
            if (fresh.length === 0) upgradeHits.delete(ip)
            else upgradeHits.set(ip, fresh)
          }
        })
        wss.emit('connection', ws, req)
      })
    })().catch((err: unknown) => {
      // e.g. the session lookup failed because the database is down (B-H1): answer 503 instead
      // of leaving an unhandled rejection behind.
      console.error('[inkling] collab upgrade failed', err)
      reject(socket, '503 Service Unavailable')
    })
  })
}

/** Clean up Hocuspocus on shutdown */
export async function destroyCollab(): Promise<void> {
  // Documents waiting for a store retry (docs/adr/1921-*): one last attempt each, now.
  for (const [name, r] of [...storeRetries]) {
    if (r.timer) clearTimeout(r.timer)
    r.timer = null
    await runStoreRetry(name, r)
  }
  const unsaved = unsavedPinnedDocuments()
  // From here the unload guard no longer pins: hocuspocus.destroy() waits for every document to
  // unload, and the derived-index flush below must still run. What could not be stored is named.
  collabDestroying = true
  if (unsaved.length) {
    console.error(`[inkling] shutting down with unsaved changes in ${unsaved.length} document(s): ${unsaved.join(', ')}`)
    for (const name of unsaved) {
      const r = storeRetries.get(name)
      storeRetries.delete(name)
      if (r?.timer) clearTimeout(r.timer)
      const doc = r?.doc as (Y.Doc & { removeDirectConnection: () => void; getConnectionsCount: () => number }) | undefined
      if (!doc) continue
      doc.removeDirectConnection()
      if (doc.getConnectionsCount() === 0) await hocuspocus.unloadDocument(doc as Parameters<typeof hocuspocus.unloadDocument>[0]).catch(() => {})
    }
  }
  try {
    await hocuspocus.destroy()
  } finally {
    collabDestroying = false
  }
  // Debounced derived-index passes must not be lost on shutdown.
  await flushDocIndexes()
}
