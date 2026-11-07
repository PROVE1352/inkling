import * as Y from 'yjs'

/**
 * Stored Yjs state formats (docs/adr/1101-*).
 *
 * page_docs.state and page_snapshots.state are written in the Yjs **V2** update encoding (≈ 32 %
 * smaller on the measured 4.5 MB page, and faster to decode). Rows written before that, and every
 * writer that still produces V1 (importers, templates, sync), keep V1. Readers never assume either:
 *
 *  - A whole-document state is self-describing. A V2 update always starts with a 0 byte (the
 *    encoder's feature flag); a V1 whole-document update starts with the number of clients as a
 *    varuint, which is 0 only for the empty document `[0, 0]`. So "first byte 0 and longer than 2
 *    bytes" is V2, everything else V1. `page_docs.state_format` mirrors it for SQL (size
 *    thresholds, conversion progress) and is never trusted over the bytes.
 *  - A delta (snapshot diff) is not self-describing (a V1 diff with no new structs also starts with
 *    0), so page_snapshots carries `state_format` and readers use it.
 *
 * The collaboration protocol is untouched: Hocuspocus syncs clients in V1 from the in-memory doc.
 */

export const STATE_V1 = 1
export const STATE_V2 = 2
export type StateFormat = typeof STATE_V1 | typeof STATE_V2

/** Format of a whole-document state (see the module comment). */
export function wholeStateFormat(state: Uint8Array): StateFormat {
  return state.length > 2 && state[0] === 0 ? STATE_V2 : STATE_V1
}

/** Applies a stored state of the given (or sniffed, for whole-document states) format to `doc`. */
export function applyStoredState(doc: Y.Doc, state: Uint8Array, format: StateFormat = wholeStateFormat(state), origin?: unknown): void {
  if (state.length === 0) return
  if (format === STATE_V2) Y.applyUpdateV2(doc, state, origin)
  else Y.applyUpdate(doc, state, origin)
}

/** A fresh Y.Doc holding a stored whole-document state (V1 or V2). */
export function docFromStoredState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  applyStoredState(doc, state)
  return doc
}

/** Encoding used for new page_docs / page_snapshots rows. */
export function encodeStoredState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdateV2(doc)
}

/** State vector of a stored whole-document state without building a document (parses every struct). */
export function stateVectorOfStored(state: Uint8Array): Uint8Array {
  if (state.length === 0) return Y.encodeStateVector(new Y.Doc())
  return wholeStateFormat(state) === STATE_V2 ? Y.encodeStateVectorFromUpdateV2(state) : Y.encodeStateVectorFromUpdate(state)
}

/** The state as V1 (for formats that leave the server, e.g. template files). No-op for V1 input. */
export function toV1(state: Uint8Array): Uint8Array {
  return wholeStateFormat(state) === STATE_V2 ? Y.convertUpdateFormatV2ToV1(state) : state
}

/** True when state vector `a` covers `b` (every client of `b` is in `a` with at least its clock). */
export function stateVectorCovers(a: Uint8Array | Map<number, number>, b: Uint8Array | Map<number, number>): boolean {
  const ma = a instanceof Map ? a : Y.decodeStateVector(a)
  const mb = b instanceof Map ? b : Y.decodeStateVector(b)
  for (const [client, clock] of mb) if ((ma.get(client) ?? 0) < clock) return false
  return true
}

/** Same clients and clocks (encodings may order clients differently). Clients at clock 0 count as absent. */
export function stateVectorsEqual(a: Uint8Array | Map<number, number>, b: Uint8Array | Map<number, number>): boolean {
  return stateVectorCovers(a, b) && stateVectorCovers(b, a)
}
