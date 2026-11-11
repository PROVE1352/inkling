/**
 * Bounds on what one collab connection may announce through Yjs awareness (0.22.1 N1(c),
 * docs/adr/2541-*). Every server.
 *
 * Hocuspocus applies an awareness message from any connection, read-only ones included
 * (MessageReceiver: `applyAwarenessUpdate(document.awareness, …)`, y-protocols 1.0.7), and keeps one
 * state per client id until that id is removed or goes quiet for 30 s. Nothing bounded the ids or the
 * state size: the 0.22.0 re-review kept a 320 MB heap growing until it died by announcing 14,000 new
 * client ids of 16 KB each from read-only connections.
 *
 * A browser announces one id per document (its Y.Doc's) with a state of a few hundred bytes (name,
 * colour, account id and the cursor's two relative positions). The caps below are far above that, and a
 * message past any of them is never applied: collab.ts refuses it before Hocuspocus does anything with
 * it and closes the socket.
 *
 *   ids per document connection   4       (a client may change its id once in a while)
 *   one state                     16 KB
 *   one message                   64 KB
 *   kept states of one socket     256 KB  (all its documents together: a tab holds tens of documents)
 *
 * What one connection keeps is then at most 4 × 16 KB, and a socket at most 256 KB, so an address holds
 * at most 40 sockets (collab.ts MAX_CONN_PER_IP) × 256 KB = 10 MB of awareness.
 */

export const AWARENESS_MAX_CLIENTS = 4
export const AWARENESS_MAX_STATE_BYTES = 16 * 1024
export const AWARENESS_MAX_MESSAGE_BYTES = 64 * 1024
export const AWARENESS_MAX_SOCKET_BYTES = 256 * 1024

/** The awareness bytes one socket's documents keep (collab.ts passes one per socket in the default context). */
export interface SocketAwareness {
  bytes: number
}

export function newSocketAwareness(): SocketAwareness {
  return { bytes: 0 }
}

/** What one document connection announced: client id → the byte length of its last state (0 = removed). */
interface ConnectionAwareness {
  states: Map<number, number>
}

/** Keyed by the Hocuspocus hook context, which is one object per document per socket. */
const byContext = new WeakMap<object, ConnectionAwareness>()

/** Test and log hook. */
export const awarenessStats = { refused: 0, largestState: 0, largestMessage: 0 }

export type AwarenessRefusal = 'message' | 'state' | 'clients' | 'socket' | 'malformed'

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
 * socket's tally, absent for connections made without one). Returns why it must be refused, or null
 * when it is within the caps (and then records it). Reads lengths only: no state is parsed here.
 */
export function admitAwarenessFrame(frame: Uint8Array, context: object, socket: SocketAwareness | undefined): AwarenessRefusal | null {
  const why = check(frame, context, socket)
  if (why) awarenessStats.refused++
  return why
}

function check(frame: Uint8Array, context: object, socket: SocketAwareness | undefined): AwarenessRefusal | null {
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
  const conn = byContext.get(context) ?? { states: new Map<number, number>() }
  const next = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    let id: number
    let stateLen: number
    ;[id, pos] = readVarUint(frame, pos)
    if (id < 0) return 'malformed'
    ;[, pos] = readVarUint(frame, pos) // clock
    ;[stateLen, pos] = readVarUint(frame, pos)
    if (stateLen < 0 || pos + stateLen > end) return 'malformed'
    if (stateLen > AWARENESS_MAX_STATE_BYTES) return 'state'
    // "null" is a removal: nothing kept
    const kept = stateLen === 4 && frame[pos] === 0x6e && frame[pos + 1] === 0x75 && frame[pos + 2] === 0x6c && frame[pos + 3] === 0x6c ? 0 : stateLen
    pos += stateLen
    next.set(id, kept)
    if (stateLen > awarenessStats.largestState) awarenessStats.largestState = stateLen
  }
  let ids = conn.states.size
  for (const id of next.keys()) if (!conn.states.has(id)) ids++
  if (ids > AWARENESS_MAX_CLIENTS) return 'clients'
  let delta = 0
  for (const [id, kept] of next) delta += kept - (conn.states.get(id) ?? 0)
  if (socket && socket.bytes + delta > AWARENESS_MAX_SOCKET_BYTES) return 'socket'
  if (frame.length > awarenessStats.largestMessage) awarenessStats.largestMessage = frame.length
  for (const [id, kept] of next) conn.states.set(id, kept)
  byContext.set(context, conn)
  if (socket) socket.bytes += delta
  return null
}

/**
 * The document connection closed (collab.ts onDisconnect, after Hocuspocus removed the states of the
 * ids it announced): its bytes leave the socket's tally, and the awareness bookkeeping of ids that no
 * longer have a state is dropped. y-protocols keeps a clock record for every id it has seen until the
 * document unloads; without this, connecting and closing over and over would grow it by four ids each
 * time.
 */
export function releaseAwareness(
  context: object,
  socket: SocketAwareness | undefined,
  awareness: { states: Map<number, unknown>; meta: Map<number, unknown> } | undefined,
): void {
  const conn = byContext.get(context)
  if (!conn) return
  byContext.delete(context)
  let kept = 0
  for (const [id, bytes] of conn.states) {
    kept += bytes
    if (awareness && !awareness.states.has(id)) awareness.meta.delete(id)
  }
  if (socket) socket.bytes = Math.max(0, socket.bytes - kept)
}
