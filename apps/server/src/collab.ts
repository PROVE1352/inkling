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
import { noteLiveEdit } from './context/attribution'
import { maybeAutoSnapshotStored } from './snapshotStore'
import { liveDocSeq, noteLiveStored, registerHocuspocus, trackLiveDoc } from './liveConnections'
import { createHash } from 'node:crypto'
import { parseCookies } from './util'
import { trustedClientIp } from './guard'
import { lifecycle, withRetry } from './lifecycle'
import { applyStoredState, encodeStoredState, STATE_V1, STATE_V2, wholeStateFormat } from './yState'

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
    // Stores of one document are serialised: Hocuspocus only debounces *timers*, so a
    // DirectConnection store (debounce 0) can run while a client store is mid-flight, and the
    // one holding the older state could finish last and overwrite page_docs. Inside the chain
    // we encode from the live Y.Doc, so whichever store runs last writes the newest state.
    return serialStore(documentName, () => {
      // Update counter at encode time: the live doc equals what this store writes (docs/adr/1041-*).
      const seq = liveDocSeq(document)
      const state = Buffer.from(encodeStoredState(document))
      return storeDocument(documentName, state, Buffer.from(Y.encodeStateVector(document)), document, socketId, document, seq)
    })
  },
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
): Promise<void> {
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
    return
  }
  storeStats.written++
  {
    // Auto snapshot of the state we are about to overwrite — decided and copied inside Postgres
    // (no full-state SELECT into Node), skipped from memory while the 10-min throttle is open.
    // Never throws (docs/adr/0750-*).
    await maybeAutoSnapshotStored(documentName)

    // Persist the state and bump pages.updated_at in one round trip. A short database outage
    // must not drop edits: retry with backoff (3 retries, ~1.75 s total), then rethrow so the
    // failure is visible — Hocuspocus keeps the document and stores again on the next change,
    // and the process-level unhandledRejection handler logs instead of crashing (B-H1).
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
  async onAuthenticate(data) {
    // 1) Session -> user from the upgrade request cookie
    const cookies = parseCookies(data.requestHeaders.cookie)
    const token = cookies[SESSION_COOKIE]
    if (!token) throw new Error('Unauthorized')
    const user = await getSessionUser(token)
    if (!user) throw new Error('Unauthorized')

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
          .select({ workspaceId: pages.workspaceId })
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

    // sessionToken lets liveConnections close exactly the sockets of revoked sessions.
    return { userId: user.id, sessionToken: token }
  },
})

registerHocuspocus(hocuspocus)

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
  // Recent upgrade-attempt timestamps per client IP (sliding window).
  const upgradeHits = new Map<string, number[]>()

  // Don't propagate errors of the WebSocketServer itself (e.g. during upgrade handling) to the process.
  wss.on('error', (err) => {
    console.error('[inkling] collab wss error', err)
  })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    hocuspocus.handleConnection(socket, request)
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
  await hocuspocus.destroy()
  // Debounced derived-index passes must not be lost on shutdown.
  await flushDocIndexes()
}
