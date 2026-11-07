import { Database } from '@hocuspocus/extension-database'
import { Hocuspocus } from '@hocuspocus/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import { getSessionUser, SESSION_COOKIE } from './auth'
import { db } from './db/index'
import { pageDocs, pages, workspaceMembers } from './db/schema'
export { flushDocIndexes } from './docIndexer'
import { visibleTo } from './pageDto'
import { liveWorkspace } from './workspaceLive'
import { flushDocIndexes, scheduleDocIndex } from './docIndexer'
import { maybeAutoSnapshotStored } from './snapshotStore'
import { registerHocuspocus } from './liveConnections'
import { parseCookies } from './util'
import { trustedClientIp } from './guard'
import { lifecycle, withRetry } from './lifecycle'

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

// Yjs state persistence extension: stored in page_docs.state (bytea)
const databaseExtension = new Database({
  fetch: async ({ documentName }) => {
    // Non-UUID documents such as inbox have no persisted state: load as an empty document.
    if (!isPageDocument(documentName)) return null
    const rows = await db
      .select({ state: pageDocs.state })
      .from(pageDocs)
      .where(eq(pageDocs.pageId, documentName))
      .limit(1)
    return rows[0]?.state ?? null
  },
  store: ({ documentName, state, document, socketId }) => {
    // Non-UUID documents such as inbox are never stored/snapshotted/indexed: skip every store hook.
    if (!isPageDocument(documentName)) return Promise.resolve()
    // Stores of one document are serialised: Hocuspocus only debounces *timers*, so a
    // DirectConnection store (debounce 0) can run while a client store is mid-flight, and the
    // one holding the older state could finish last and overwrite page_docs. Inside the chain
    // we re-encode from the live Y.Doc, so whichever store runs last writes the newest state.
    return serialStore(documentName, () =>
      storeDocument(
        documentName,
        document instanceof Y.Doc ? Buffer.from(Y.encodeStateAsUpdate(document)) : state,
        document,
        socketId,
      ),
    )
  },
})

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
  document: { getConnectionsCount?: () => number } | undefined,
  socketId: string | undefined,
): Promise<void> {
  {
    // Auto snapshot of the state we are about to overwrite — decided and copied inside Postgres
    // (no full-state SELECT into Node), skipped from memory while the 10-min throttle is open.
    // Never throws (docs/adr/0750-*).
    await maybeAutoSnapshotStored(documentName)

    // Persist the state and bump pages.updated_at in one round trip. A short database outage
    // must not drop edits: retry with backoff (3 retries, ~1.75 s total), then rethrow so the
    // failure is visible — Hocuspocus keeps the document and stores again on the next change,
    // and the process-level unhandledRejection handler logs instead of crashing (B-H1).
    await withRetry(
      () =>
        db.execute(sql`
          WITH d AS (
            INSERT INTO page_docs (page_id, state, updated_at)
            VALUES (${documentName}, ${state}, now())
            ON CONFLICT (page_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
            RETURNING page_id
          )
          UPDATE pages SET updated_at = now() WHERE id IN (SELECT page_id FROM d)
        `),
      {
        attempts: 4,
        onRetry: (err, n) =>
          console.error(`[inkling] collab store of ${documentName} failed (retry ${n}/3)`, err),
      },
    )

    // Derived indexes (backlinks, search text, tags, dated tasks). Server-side DirectConnection
    // edits (REST/MCP/sync) and the final store after the last client leaves index right away;
    // live typing is debounced and diffed in docIndexer. Failures never fail the store.
    const lastClientGone = document?.getConnectionsCount?.() === 0
    await scheduleDocIndex(documentName, state, socketId === 'server' || lastClientGone)
  }
}

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
  extensions: [databaseExtension],
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
    const page = (
      await db
        .select({ workspaceId: pages.workspaceId })
        .from(pages)
        .where(and(eq(pages.id, pageId), isNull(pages.deletedAt), visibleTo(user.id), liveWorkspace(pages.workspaceId)))
        .limit(1)
    )[0]
    if (!page) throw new Error('Page not found')

    const member = (
      await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, page.workspaceId),
            eq(workspaceMembers.userId, user.id),
          ),
        )
        .limit(1)
    )[0]
    if (!member) throw new Error('Forbidden')

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
