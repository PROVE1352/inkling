/**
 * Bounds on what one collab connection may bring into a document's Yjs awareness (0.22.1 N1(c),
 * docs/adr/2541-*, corrected by docs/adr/2552-*). Every server.
 *
 * Hocuspocus applies an awareness message from any connection, read-only ones included
 * (MessageReceiver: `applyAwarenessUpdate(document.awareness, …)`, y-protocols 1.0.7), and keeps one
 * state per client id until that id is removed or goes quiet for 30 s, and a clock record per id until
 * the document unloads. The 0.22.0 re-review ran a 320 MB heap out of memory by announcing 14,000 new
 * client ids of 16 KB each from read-only connections.
 *
 * What a connection sends is not only its own id: the web app's provider (@hocuspocus/provider 2.15.3,
 * `awarenessUpdateHandler`) sends back every awareness change it applies, other people's included. So
 * an id counts against the connection that **brought it in** (applied while the document had no state
 * for it), never against one that echoes or updates an id already there (ADR 2552). Entries that y-protocols
 * would not apply (an older or equal clock: every echo) are not counted at all.
 *
 *   live ids one document connection brought in       4       (a browser brings in its Y.Doc's one)
 *   new ids (clock records) per socket                 64 at once, then 1 a second
 *   live ids in one document                           1024    (a new id past it is refused)
 *   one state                                          16 KB
 *   one message                                        1 MB    (an echo carries everyone's state)
 *   states one socket's connections brought in         256 KB  (all its documents together)
 *
 * A message past a cap is never applied: collab.ts refuses it before Hocuspocus does anything with it
 * and closes the socket. Clock records without a state are swept after a minute (sweepAwarenessMeta).
 */

export const AWARENESS_MAX_CLIENTS = 4
export const AWARENESS_MAX_STATE_BYTES = 16 * 1024
export const AWARENESS_MAX_MESSAGE_BYTES = 1024 * 1024
export const AWARENESS_MAX_SOCKET_BYTES = 256 * 1024
export const AWARENESS_MAX_DOC_IDS = 1024
export const AWARENESS_NEW_IDS_BURST = 64
export const AWARENESS_NEW_IDS_PER_SEC = 1
/**
 * State bytes a socket may change per second (128 KB at once, then 16 KB a second), counting only entries that
 * change something (echoes are free). Every change is sent on to every connection of the document, so without a
 * rate four ids of one's own re-sent fast multiply into the other connections' send buffers (measured: 30 sockets,
 * 3.4 GB of RSS in 15 s). An editor's cursor is ~0.4 KB per move.
 */
export const AWARENESS_BYTES_BURST = 128 * 1024
export const AWARENESS_BYTES_PER_SEC = 16 * 1024
/** A clock record without a state is dropped this long after its last change (sweepAwarenessMeta). */
export const AWARENESS_META_KEEP_MS = 60_000

/** One socket's tally (collab.ts passes one per socket in the default context). */
export interface SocketAwareness {
  /** Bytes of the live states its document connections brought in. */
  bytes: number
  /** New-id tokens (a bucket of AWARENESS_NEW_IDS_BURST refilled at AWARENESS_NEW_IDS_PER_SEC). */
  tokens: number
  at: number
  /** Changed-state byte tokens (AWARENESS_BYTES_BURST refilled at AWARENESS_BYTES_PER_SEC). */
  byteTokens: number
  byteAt: number
}

export function newSocketAwareness(): SocketAwareness {
  return { bytes: 0, tokens: AWARENESS_NEW_IDS_BURST, at: Date.now(), byteTokens: AWARENESS_BYTES_BURST, byteAt: Date.now() }
}

/** The document awareness as y-protocols keeps it (the fields this module reads). */
export interface AwarenessLike {
  clientID: number
  states: Map<number, unknown>
  meta: Map<number, { clock: number; lastUpdated: number }>
}

/** What one document connection brought in: id → byte length of its last state. */
interface ConnectionAwareness {
  owned: Map<number, number>
  /** Ids brought in by a message admitted this turn and not applied yet (Hocuspocus applies it next). */
  fresh: Set<number>
  /** Σ owned bytes as last counted into the socket's tally. */
  bytes: number
}

/**
 * Per document: what messages admitted this turn will do when Hocuspocus applies them (on the same turn,
 * after its hook chain). A provider sends several messages at once, and the second must not look new
 * again because the first has not been applied yet.
 */
const pendingByDoc = new WeakMap<object, Map<number, { clock: number; live: boolean }>>()

/** Keyed by the Hocuspocus hook context, which is one object per document per socket. */
const byContext = new WeakMap<object, ConnectionAwareness>()

/** Test and log hook. */
export const awarenessStats = { refused: 0, largestState: 0, largestMessage: 0, mostOwned: 0, newIds: 0, changedBytes: 0 }

export type AwarenessRefusal = 'message' | 'state' | 'clients' | 'new-ids' | 'document' | 'socket' | 'rate' | 'malformed'

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

/** The message type of a frame ([document name][type]…), or -1. */
export function frameMessageType(frame: Uint8Array): number {
  const [nameLen, p1] = readVarUint(frame, 0)
  if (nameLen < 0 || p1 + nameLen > frame.length) return -1
  return readVarUint(frame, p1 + nameLen)[0]
}

const MESSAGE_AWARENESS = 1

/**
 * An Awareness frame arrived on a document connection (`context`: its hook context; `socket`: its
 * socket's tally; `awareness`: the document's). Returns why it must be refused, or null when it is within
 * the caps (and then records it). Reads lengths only: no state is parsed here.
 */
export function admitAwarenessFrame(
  frame: Uint8Array,
  context: object,
  socket: SocketAwareness | undefined,
  awareness: AwarenessLike | undefined,
): AwarenessRefusal | null {
  const why = check(frame, context, socket, awareness)
  if (why) awarenessStats.refused++
  return why
}

function check(frame: Uint8Array, context: object, socket: SocketAwareness | undefined, awareness: AwarenessLike | undefined): AwarenessRefusal | null {
  if (frame.length > AWARENESS_MAX_MESSAGE_BYTES) return 'message'
  const [nameLen, p1] = readVarUint(frame, 0)
  if (nameLen < 0) return 'malformed'
  const [type, p2] = readVarUint(frame, p1 + nameLen)
  if (type !== MESSAGE_AWARENESS) return null
  const [len, p3] = readVarUint(frame, p2)
  if (len < 0 || p3 + len > frame.length) return 'malformed'
  const end = p3 + len
  let [n, pos] = readVarUint(frame, p3)
  if (n < 0) return 'malformed'
  const states = awareness?.states ?? new Map<number, unknown>()
  const meta = awareness?.meta ?? new Map<number, { clock: number; lastUpdated: number }>()
  const conn = byContext.get(context) ?? { owned: new Map<number, number>(), fresh: new Set<number>(), bytes: 0 }
  const owned = new Map(conn.owned)
  const fresh = new Set(conn.fresh)
  // what this message does, entry by entry, as y-protocols will apply it (a later entry for the same id wins)
  const clocks = new Map<number, { clock: number; live: boolean }>()
  const pending = awareness ? pendingByDoc.get(awareness) : undefined
  let newIds = 0
  let broughtIn = 0
  let changed = 0
  for (let i = 0; i < n; i++) {
    let id: number
    let clock: number
    let stateLen: number
    ;[id, pos] = readVarUint(frame, pos)
    if (id < 0) return 'malformed'
    ;[clock, pos] = readVarUint(frame, pos)
    if (clock < 0) return 'malformed'
    ;[stateLen, pos] = readVarUint(frame, pos)
    if (stateLen < 0 || pos + stateLen > end) return 'malformed'
    if (stateLen > AWARENESS_MAX_STATE_BYTES) return 'state'
    const isNull = stateLen === 4 && frame[pos] === 0x6e && frame[pos + 1] === 0x75 && frame[pos + 2] === 0x6c && frame[pos + 3] === 0x6c
    pos += stateLen
    if (stateLen > awarenessStats.largestState) awarenessStats.largestState = stateLen
    // y-protocols applyAwarenessUpdate: a newer clock, or the same clock removing a live state
    // this message's earlier entries, then messages admitted this turn but not applied yet, then the document
    const seen = clocks.get(id) ?? pending?.get(id)
    const curClock = seen ? seen.clock : (meta.get(id)?.clock ?? 0)
    const curLive = seen ? seen.live : states.has(id)
    if (!(curClock < clock || (curClock === clock && isNull && curLive))) continue // an echo: nothing happens
    if (!seen && !meta.has(id) && !pending?.has(id)) newIds++ // a clock record the document did not have
    clocks.set(id, { clock, live: !isNull })
    changed += stateLen
    if (isNull) {
      owned.delete(id)
      fresh.delete(id)
    } else if (owned.has(id)) {
      owned.set(id, stateLen)
    } else if (!curLive) {
      // brought in by this connection
      owned.set(id, stateLen)
      fresh.add(id)
      broughtIn++
    }
  }
  // ids this connection brought in that the document no longer holds (removed, timed out) leave the count
  for (const id of owned.keys()) if (!fresh.has(id) && !states.has(id)) owned.delete(id)
  if (owned.size > AWARENESS_MAX_CLIENTS) return 'clients'
  if (broughtIn > 0 && states.size + broughtIn > AWARENESS_MAX_DOC_IDS) return 'document'
  if (changed > 0 && socket) {
    const now = Date.now()
    const tokens = Math.min(AWARENESS_BYTES_BURST, socket.byteTokens + ((now - socket.byteAt) / 1000) * AWARENESS_BYTES_PER_SEC)
    if (tokens < changed) return 'rate'
    socket.byteTokens = tokens - changed
    socket.byteAt = now
  }
  if (newIds > 0 && socket) {
    const now = Date.now()
    const tokens = Math.min(AWARENESS_NEW_IDS_BURST, socket.tokens + ((now - socket.at) / 1000) * AWARENESS_NEW_IDS_PER_SEC)
    if (tokens < newIds) return 'new-ids'
    socket.tokens = tokens - newIds
    socket.at = now
  }
  let bytes = 0
  for (const b of owned.values()) bytes += b
  if (socket && socket.bytes + (bytes - conn.bytes) > AWARENESS_MAX_SOCKET_BYTES) return 'socket'
  // admitted: record it
  if (socket) socket.bytes = Math.max(0, socket.bytes + (bytes - conn.bytes))
  conn.owned = owned
  conn.fresh = fresh
  conn.bytes = bytes
  byContext.set(context, conn)
  if (fresh.size > 0) setImmediate(() => conn.fresh.clear()) // applied by then (Hocuspocus's hook chain is promises only)
  if (awareness && clocks.size > 0) {
    let p = pendingByDoc.get(awareness)
    if (!p) {
      pendingByDoc.set(awareness, (p = new Map()))
      const doc = awareness
      setImmediate(() => pendingByDoc.delete(doc))
    }
    for (const [id, c] of clocks) p.set(id, c)
  }
  if (frame.length > awarenessStats.largestMessage) awarenessStats.largestMessage = frame.length
  if (owned.size > awarenessStats.mostOwned) awarenessStats.mostOwned = owned.size
  awarenessStats.newIds += newIds
  awarenessStats.changedBytes += changed
  if (awareness) sweepAwarenessMeta(awareness)
  return null
}

const sweptAt = new WeakMap<object, number>()

/**
 * Drops clock records without a state once they are AWARENESS_META_KEEP_MS old, when a document holds
 * more than a few hundred of them (at most every 10 s per document). y-protocols keeps them until the
 * document unloads; a recent one must stay, or an echo of the removed state still on its way would
 * bring the id back.
 */
export function sweepAwarenessMeta(awareness: AwarenessLike, now = Date.now(), force = false): number {
  if (!force && awareness.meta.size <= awareness.states.size + 256) return 0
  const last = sweptAt.get(awareness) ?? 0
  if (!force && now - last < 10_000) return 0
  sweptAt.set(awareness, now)
  let n = 0
  for (const [id, m] of awareness.meta) {
    if (id === awareness.clientID || awareness.states.has(id) || now - m.lastUpdated < AWARENESS_META_KEEP_MS) continue
    awareness.meta.delete(id)
    n++
  }
  return n
}

/**
 * The document connection closed (collab.ts onDisconnect, after Hocuspocus removed the states of the
 * ids it brought in): its bytes leave the socket's tally. Clock records stay for the sweep (a removal
 * echoed back by another tab must still find them).
 */
export function releaseAwareness(context: object, socket: SocketAwareness | undefined): void {
  const conn = byContext.get(context)
  if (!conn) return
  byContext.delete(context)
  if (socket) socket.bytes = Math.max(0, socket.bytes - conn.bytes)
}
