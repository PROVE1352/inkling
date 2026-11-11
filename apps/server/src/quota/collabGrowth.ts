import { sql } from 'drizzle-orm'
import { limits, mbToBytes } from '../limits'
import { autoSnapshotMayBeDue } from '../snapshotStore'
import { instanceFullNow } from './instance'

/**
 * Live editing against the storage limit (contract §14, security review F2, docs/adr/2530-*).
 *
 * Page bodies grow over the collab socket outside any transaction, and what is typed is only stored
 * (and counted, quota/storage.ts noteBodyStore) 2–10 s later. Before 0.22.0 shipped, the store path
 * only noted the growth after the fact, so one socket could push a workspace far past its limit and
 * the server's heap with it. Here every incoming Yjs update is counted **when it arrives**, before
 * Hocuspocus applies it (collab.ts beforeHandleMessage, synchronously: one hook chain per frame, so an
 * await before the decision would let a burst through):
 *
 *   - per page: stored body + unsaved growth + this update ≤ the page body cap (¼ of the limit);
 *   - per workspace: cached use (`workspaces.storage_bytes`) + unsaved growth of its live pages + the
 *     version copy the next store may take + this update ≤ the workspace limit;
 *   - the instance fuse (LIMIT_INSTANCE_STORAGE_MB, quota/instance.ts) is not tripped.
 *
 * An update that does not fit is never applied or stored: collab.ts makes the connection read-only
 * (Hocuspocus then answers SyncStatus(false) and drops it) and closes the socket with an ordinary code,
 * so the client reconnects and is authorised read-only (this module remembers the page for
 * REFUSED_PAGE_MS, so the reconnect does not loop through write-refuse-close).
 *
 * The unsaved growth is the byte length of the update messages (an upper bound of what they add to the
 * stored state), re-based on every successful store to the stored length and the workspace's cached use.
 * Only Sync frames count: awareness never reaches a store.
 *
 * Nothing here runs without LIMIT_WORKSPACE_STORAGE_MB or LIMIT_INSTANCE_STORAGE_MB: collab.ts asks
 * collabGuardsOn() first, so a server without them has no new read, close or refusal on its editing path.
 */

/** A page refused for storage authorises read-only for this long (or until the server restarts). */
export const REFUSED_PAGE_MS = 10 * 60_000
/** The cached workspace use is re-read in the background when older than this, as updates arrive. */
export const USED_REFRESH_MS = 2_000

interface PageAcc {
  ws: string
  /** Stored body bytes (state + state vector) at load or at the last successful store. */
  base: number
  /** Update bytes applied since then. */
  pending: number
  /** Bytes reserved for the auto version copy the next store may take (0 or `base`). */
  reserve: number
}

interface WsAcc {
  used: number
  at: number
  pending: number
  reserve: number
  pages: number
  refreshing: boolean
}

const pageAcc = new Map<string, PageAcc>()
const wsAcc = new Map<string, WsAcc>()
const refusedPages = new Map<string, number>()

/** The storage checks of the collab socket run (a storage limit or the instance fuse is set). */
export function collabGuardsOn(): boolean {
  return limits.workspaceStorageMb != null || limits.instanceStorageMb !== undefined
}

function storageLimit(): number | null {
  return limits.workspaceStorageMb == null ? null : mbToBytes(limits.workspaceStorageMb)
}

function wsOf(workspaceId: string): WsAcc {
  let w = wsAcc.get(workspaceId)
  if (!w) {
    w = { used: 0, at: 0, pending: 0, reserve: 0, pages: 0, refreshing: false }
    wsAcc.set(workspaceId, w)
  }
  return w
}

function pageOf(pageId: string, workspaceId: string, base: () => number): PageAcc {
  let p = pageAcc.get(pageId)
  if (!p) {
    p = { ws: workspaceId, base: base(), pending: 0, reserve: 0 }
    pageAcc.set(pageId, p)
    wsOf(workspaceId).pages++
  }
  return p
}

function refreshSoon(workspaceId: string, w: WsAcc): void {
  if (w.refreshing || Date.now() - w.at < USED_REFRESH_MS) return
  w.refreshing = true
  void (async () => {
    try {
      const { db } = await import('../db/index')
      const [r] = (await db.execute(sql`SELECT storage_bytes AS used FROM workspaces WHERE id = ${workspaceId}`)) as unknown as {
        used: string | number
      }[]
      if (r) {
        w.used = Number(r.used)
        w.at = Date.now()
      }
    } catch (err) {
      console.warn('[inkling] collab storage refresh failed', workspaceId, err)
    } finally {
      w.refreshing = false
    }
  })()
}

/**
 * A connection to `pageId` was authorised (collab.ts onAuthenticate, through storage.ts
 * collabStorageReadOnly): the database's numbers right now. A page already live keeps its counters.
 */
export function noteCollabAuthorised(pageId: string, workspaceId: string, storedBody: number, used: number): void {
  const w = wsOf(workspaceId)
  w.used = used
  w.at = Date.now()
  pageOf(pageId, workspaceId, () => storedBody)
}

/**
 * Read-only from what is in memory: the page was refused lately, the page's live body is past its cap,
 * or the workspace's use with the unsaved growth has reached the limit.
 */
export function collabFullInMemory(pageId: string, workspaceId: string): boolean {
  const until = refusedPages.get(pageId)
  if (until !== undefined) {
    if (until > Date.now()) return true
    refusedPages.delete(pageId)
  }
  const limit = storageLimit()
  if (limit == null) return false
  const w = wsAcc.get(workspaceId)
  if (w && w.used + w.pending + w.reserve >= limit) return true
  const p = pageAcc.get(pageId)
  return !!p && p.base + p.pending > Math.floor(limit / 4)
}

export type Admission = 'ok' | 'page' | 'workspace' | 'instance'

/** Test and log hook: updates admitted and refused since the process started. */
export const collabGrowthStats = { admitted: 0, refused: 0 }

/**
 * May an update of `bytes` be applied to the live page now? Synchronous (no await between the
 * decision and the reservation). `liveBody` gives the page's size when it has no counters yet (a
 * connection authorised before a limit was set in tests). On 'ok' the bytes are reserved.
 */
export function admitCollabUpdate(pageId: string, workspaceId: string, bytes: number, liveBody: () => number): Admission {
  const verdict = admit(pageId, workspaceId, bytes, liveBody)
  if (verdict === 'ok') collabGrowthStats.admitted++
  else collabGrowthStats.refused++
  return verdict
}

function admit(pageId: string, workspaceId: string, bytes: number, liveBody: () => number): Admission {
  if (instanceFullNow()) return 'instance'
  const limit = storageLimit()
  if (limit == null) return 'ok'
  const p = pageOf(pageId, workspaceId, liveBody)
  const w = wsOf(p.ws)
  refreshSoon(p.ws, w)
  if (p.base + p.pending + bytes > Math.floor(limit / 4)) return 'page'
  // the next store copies the stored body into the version history when the throttle is open
  const reserve = p.reserve === 0 && p.base > 0 && autoSnapshotMayBeDue(pageId) ? p.base : 0
  if (w.used + w.pending + w.reserve + reserve + bytes > limit) return 'workspace'
  p.pending += bytes
  w.pending += bytes
  if (reserve > 0) {
    p.reserve = reserve
    w.reserve += reserve
  }
  return 'ok'
}

/** The page refused an update: connections to it authorise read-only for REFUSED_PAGE_MS. */
export function noteCollabRefused(pageId: string): void {
  refusedPages.set(pageId, Date.now() + REFUSED_PAGE_MS)
  if (refusedPages.size > 10_000) {
    const oldest = refusedPages.keys().next().value
    if (oldest !== undefined) refusedPages.delete(oldest)
  }
}

/** Unsaved growth counted for the page right now (read when a store encodes the state). */
export function collabPendingBytes(pageId: string): number {
  return pageAcc.get(pageId)?.pending ?? 0
}

/**
 * A store of the page succeeded: `stored` bytes are in page_docs now, covering `pendingAtEncode` of
 * the counted growth; `used` is the workspace's cached use after it (null = unknown).
 */
export function noteCollabStored(pageId: string, stored: number, pendingAtEncode: number, used: number | null): void {
  const p = pageAcc.get(pageId)
  if (!p) return
  const w = wsOf(p.ws)
  const covered = Math.min(pendingAtEncode, p.pending)
  p.pending -= covered
  w.pending = Math.max(0, w.pending - covered)
  w.reserve = Math.max(0, w.reserve - p.reserve)
  p.reserve = 0
  p.base = stored
  if (used != null) {
    w.used = used
    w.at = Date.now()
  }
}

/** The page left memory: its counters go (what it stored is in the cached use). */
export function noteCollabUnloaded(pageId: string): void {
  const p = pageAcc.get(pageId)
  if (!p) return
  pageAcc.delete(pageId)
  const w = wsAcc.get(p.ws)
  if (!w) return
  w.pending = Math.max(0, w.pending - p.pending)
  w.reserve = Math.max(0, w.reserve - p.reserve)
  if (--w.pages <= 0) wsAcc.delete(p.ws)
}

/** A recount (quota/storage.ts) set the workspace's cached use. */
export function noteWorkspaceUsed(workspaceId: string, used: number): void {
  const w = wsAcc.get(workspaceId)
  if (!w) return
  w.used = used
  w.at = Date.now()
}

/**
 * Bytes of live editing in the workspace that its cached use does not hold yet (unsaved growth and the
 * version copies reserved for the next stores). The REST storage checks add them (quota/room.ts), so
 * an upload and a burst of typing cannot both take the same room.
 */
export function collabUnsavedBytes(workspaceId: string): number {
  const w = wsAcc.get(workspaceId)
  return w ? w.pending + w.reserve : 0
}

/** Test hook: forget every counter. */
export function _resetCollabGrowth(): void {
  pageAcc.clear()
  wsAcc.clear()
  refusedPages.clear()
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function readVarUint(buf: Uint8Array, pos: number): [number, number] {
  let n = 0
  let mult = 1
  for (let i = 0; i < 8 && pos < buf.length; i++) {
    const b = buf[pos++]
    n += (b & 0x7f) * mult
    if (b < 0x80) return [n, pos]
    mult *= 128
  }
  return [-1, pos]
}

/**
 * The bytes a frame can add to a document: the length of a Sync (or SyncReply) message carrying an
 * update or SyncStep2; 0 for everything else (SyncStep1 is a state vector; awareness, auth, stateless
 * and close messages never reach a store). Layout (Hocuspocus 2): varString document name, varUint
 * message type, varUint sync type, varUint8Array payload.
 */
export function syncGrowthBytes(frame: Uint8Array): number {
  const [nameLen, p1] = readVarUint(frame, 0)
  if (nameLen < 0) return 0
  const [type, p2] = readVarUint(frame, p1 + nameLen)
  if (type !== 0 && type !== 4) return 0 // MessageType.Sync, MessageType.SyncReply
  const [syncType] = readVarUint(frame, p2)
  return syncType === 1 || syncType === 2 ? frame.length : 0 // messageYjsSyncStep2, messageYjsUpdate
}

// ---------------------------------------------------------------------------
// Frames for documents a socket has not connected yet
// ---------------------------------------------------------------------------

/**
 * Hocuspocus keeps every frame for a document that is not connected on the socket yet (before its
 * Auth message, while it loads, and for good after its authentication failed) in an unbounded queue
 * that never reaches beforeHandleMessage. With the guards on, a socket may hold at most this many
 * bytes of such frames; past it the socket is closed (collab.ts attachCollab).
 */
export const QUEUED_BYTES_CAP = 8 * 1024 * 1024

/**
 * Bytes the sockets of one client address may send together: a bucket of SOCKET_BURST_BYTES refilled
 * at SOCKET_BYTES_PER_SEC (an address may hold 40 sockets, collab.ts MAX_CONN_PER_IP, so a per-socket
 * rate would multiply). Refused updates are never applied, but they still arrive and sit in memory
 * until handled; without a rate a client that does not wait for answers pours hundreds of MB into the
 * server before its socket closes (measured: 40 pages × 8 MB on one socket, 0.22 report). A browser
 * sends far less: a paste is one update (≤ 2 MB, the frame cap), and a reconnect sends each open
 * page's unsent changes once.
 */
export const SOCKET_BURST_BYTES = 16 * 1024 * 1024
export const SOCKET_BYTES_PER_SEC = 4 * 1024 * 1024

/** The rate bucket of one client address (shared by its sockets). */
export interface ByteBucket {
  tokens: number
  filledAt: number
}

export function newByteBucket(): ByteBucket {
  return { tokens: SOCKET_BURST_BYTES, filledAt: Date.now() }
}

/** Take `n` bytes from the bucket; false = empty. */
export function takeBytes(b: ByteBucket, n: number): boolean {
  const now = Date.now()
  b.tokens = Math.min(SOCKET_BURST_BYTES, b.tokens + ((now - b.filledAt) / 1000) * SOCKET_BYTES_PER_SEC)
  b.filledAt = now
  b.tokens -= n
  return b.tokens >= 0
}

export interface SocketQueueGuard {
  /** Documents whose connection is set up on this socket (collab.ts `connected`, until `onDisconnect`). */
  connected: Set<string>
  /** Bytes of frames held for each other document. */
  perDoc: Map<string, number>
  /** Their sum. */
  queued: number
  /** The rate bucket of the socket's client address. */
  bucket: ByteBucket
}

export function newSocketQueueGuard(bucket: ByteBucket = newByteBucket()): SocketQueueGuard {
  return { connected: new Set(), perDoc: new Map(), queued: 0, bucket }
}

/**
 * Count one incoming frame; a reason when the socket must close: it sends faster than the rate, or it
 * holds too many queued bytes for documents it has not opened.
 */
export function admitSocketFrame(guard: SocketQueueGuard, frame: Uint8Array): 'rate' | 'queued' | null {
  if (!takeBytes(guard.bucket, frame.length)) return 'rate'
  return admitQueuedFrame(guard, frame) ? null : 'queued'
}

/** Count one incoming frame; false = the socket holds too many queued bytes and must close. */
export function admitQueuedFrame(guard: SocketQueueGuard, frame: Uint8Array): boolean {
  const [nameLen, p1] = readVarUint(frame, 0)
  if (nameLen < 0 || p1 + nameLen > frame.length) return true // malformed: Hocuspocus closes the socket itself
  const name = Buffer.from(frame.buffer, frame.byteOffset + p1, nameLen).toString('utf8')
  if (guard.connected.has(name)) return true
  guard.perDoc.set(name, (guard.perDoc.get(name) ?? 0) + frame.length)
  guard.queued += frame.length
  return guard.queued <= QUEUED_BYTES_CAP
}

/** The document's connection is set up: its queue was replayed, its bytes no longer wait. */
export function noteSocketConnected(guard: SocketQueueGuard, name: string): void {
  guard.connected.add(name)
  guard.queued -= guard.perDoc.get(name) ?? 0
  guard.perDoc.delete(name)
}

/** The document's connection on this socket ended: later frames for it would queue again. */
export function noteSocketDisconnected(guard: SocketQueueGuard, name: string): void {
  guard.connected.delete(name)
}
