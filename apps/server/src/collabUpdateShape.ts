/**
 * How much a Yjs update can add to a document's structure, read without decoding it (0.22.1 N1(a),
 * docs/adr/2540-*). Used by the collab socket's storage guards (quota/collabGrowth.ts) before an update
 * is applied: memory follows the number of structs (one Item or GC each, ~250–500 bytes of heap), not the
 * bytes, and a map of tiny entries packs ~10 bytes per struct.
 *
 * The scan walks the V1 update format (the one Hocuspocus's sync protocol carries) and skips every
 * value by its length prefix: no string is decoded, no object is made, so it costs one pass over the
 * bytes the frame already holds (≤ 2 MB, the socket's frame cap). What it cannot read is answered with
 * the byte length: every struct takes at least its info byte, so that is still an upper bound.
 */

/** A struct that brings a whole Y.Doc along (ContentDoc, a subdocument) counts as this many. */
export const SUBDOC_WEIGHT = 16

export interface UpdateShape {
  /** Structs the update carries (GC, Skip and Items; a subdocument counts SUBDOC_WEIGHT). */
  structs: number
  /** Of those, Items placed next to an existing one (an origin or a right origin): each may split it. */
  placed: number
  /** Delete-set ranges: each may split up to two existing items. */
  deleteRanges: number
  /** false: the update was not readable as V1; `structs` is then the byte length (an upper bound). */
  parsed: boolean
}

class Reader {
  pos: number
  constructor(
    readonly buf: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start
  }
  uint8(): number {
    if (this.pos >= this.end) throw RANGE
    return this.buf[this.pos++]
  }
  varUint(): number {
    let n = 0
    let mult = 1
    for (let i = 0; i < 8; i++) {
      const b = this.uint8()
      n += (b & 0x7f) * mult
      if (b < 0x80) return n
      mult *= 128
    }
    throw RANGE
  }
  /** A lib0 varInt (sign in the first byte); only its length matters here. */
  skipVarInt(): void {
    for (let i = 0; i < 10; i++) if (this.uint8() < 0x80) return
    throw RANGE
  }
  skip(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw RANGE
    this.pos += n
  }
  /** varString and varUint8Array: a length, then that many bytes. */
  skipBytes(): void {
    this.skip(this.varUint())
  }
  /** lib0 readAny, skipped. Nesting is bounded so a crafted value cannot exhaust the stack. */
  skipAny(depth = 0): void {
    if (depth > 64) throw RANGE
    const t = this.uint8()
    switch (t) {
      case 127: // undefined
      case 126: // null
      case 121: // false
      case 120: // true
        return
      case 125: // varInt
        return this.skipVarInt()
      case 124: // float32
        return this.skip(4)
      case 123: // float64
      case 122: // bigint64
        return this.skip(8)
      case 119: // string
      case 116: // Uint8Array
        return this.skipBytes()
      case 118: {
        // object: length, then key string + value
        const n = this.varUint()
        for (let i = 0; i < n; i++) {
          this.skipBytes()
          this.skipAny(depth + 1)
        }
        return
      }
      case 117: {
        // array
        const n = this.varUint()
        for (let i = 0; i < n; i++) this.skipAny(depth + 1)
        return
      }
      default:
        throw RANGE
    }
  }
}

const RANGE = new Error('not a V1 update')

const BITS5 = 31
const BIT6 = 32
const BIT7 = 64
const BIT8 = 128

/** The shape of a V1 update held in `buf[start, end)`. Never throws. */
export function updateShape(buf: Uint8Array, start = 0, end = buf.length): UpdateShape {
  const r = new Reader(buf, start, end)
  let structs = 0
  let placed = 0
  let deleteRanges = 0
  try {
    const clients = r.varUint()
    for (let c = 0; c < clients; c++) {
      const n = r.varUint()
      r.varUint() // client
      r.varUint() // first clock
      for (let i = 0; i < n; i++) {
        const info = r.uint8()
        const kind = info & BITS5
        structs++
        if (kind === 0 || kind === 10) {
          r.varUint() // GC or Skip: a length
          continue
        }
        if (info & (BIT7 | BIT8)) placed++
        if (info & BIT8) {
          r.varUint() // origin client, clock
          r.varUint()
        }
        if (info & BIT7) {
          r.varUint() // right origin
          r.varUint()
        }
        if ((info & (BIT7 | BIT8)) === 0) {
          // parent: a root type's name, or the id of the item that holds it
          if (r.varUint() === 1) r.skipBytes()
          else {
            r.varUint()
            r.varUint()
          }
          if (info & BIT6) r.skipBytes() // parentSub (a map key)
        }
        switch (kind) {
          case 1: // deleted: a length
            r.varUint()
            break
          case 2: {
            // JSON: count, then strings
            const len = r.varUint()
            for (let k = 0; k < len; k++) r.skipBytes()
            break
          }
          case 3: // binary
          case 4: // string
          case 5: // embed (a JSON string)
            r.skipBytes()
            break
          case 6: // format: key, JSON value
            r.skipBytes()
            r.skipBytes()
            break
          case 7: {
            // a type: XmlElement (3) and XmlHook (5) carry their name
            const ref = r.varUint()
            if (ref === 3 || ref === 5) r.skipBytes()
            else if (ref > 6) throw RANGE
            break
          }
          case 8: {
            // any: count, then values
            const len = r.varUint()
            for (let k = 0; k < len; k++) r.skipAny()
            break
          }
          case 9: // a subdocument: guid, options
            r.skipBytes()
            r.skipAny()
            structs += SUBDOC_WEIGHT - 1
            break
          default:
            throw RANGE
        }
      }
    }
    // delete set: clients, then (client, count, (clock, len)×count)
    const dsClients = r.varUint()
    for (let c = 0; c < dsClients; c++) {
      r.varUint()
      const n = r.varUint()
      for (let i = 0; i < n; i++) {
        r.varUint()
        r.varUint()
      }
      deleteRanges += n
    }
    return { structs, placed, deleteRanges, parsed: true }
  } catch {
    return { structs: end - start, placed: 0, deleteRanges: 0, parsed: false }
  }
}

/**
 * What an update may add to a document's structs once applied: each struct it carries, one split of an
 * existing item for each Item placed next to one (an insertion inside a merged run of text), two for
 * each delete range (both ends). A crafted update can split a little more (an Item whose origin and
 * right origin sit in two different items); collabGrowth re-reads the live count after each update, so
 * that never accumulates.
 */
export function structGrowthBound(shape: UpdateShape): number {
  return shape.parsed ? shape.structs + shape.placed + 2 * shape.deleteRanges : shape.structs
}

/**
 * The update a Sync frame carries: [docName varString][type][sync type][update varUint8Array]. Returns
 * its bounds in `frame`, or null for anything else (or a malformed frame).
 */
export function syncUpdateBounds(frame: Uint8Array): { start: number; end: number } | null {
  const r = new Reader(frame, 0, frame.length)
  try {
    r.skipBytes()
    const type = r.varUint()
    if (type !== 0 && type !== 4) return null // Sync, SyncReply
    const sync = r.varUint()
    if (sync !== 1 && sync !== 2) return null // step 2, update
    const len = r.varUint()
    if (r.pos + len > frame.length) return null
    return { start: r.pos, end: r.pos + len }
  } catch {
    return null
  }
}

/** Structs (Items and GCs) a live document holds: one array per client, so O(clients). */
export function liveStructCount(doc: { store: { clients: Map<number, unknown[]> } }): number {
  let n = 0
  for (const a of doc.store.clients.values()) n += a.length
  return n
}

/** Bytes a document holds back as updates waiting for missing structs or deletes (yjs pendingStructs/pendingDs). */
export function pendingUpdateBytes(doc: { store: { pendingStructs: { update: Uint8Array } | null; pendingDs: Uint8Array | null } }): number {
  return (doc.store.pendingStructs?.update.length ?? 0) + (doc.store.pendingDs?.length ?? 0)
}
