import { NODE_SCHEMA } from '@inkling/shared'
import * as Y from 'yjs'
import { applyStoredState } from './yState'

/**
 * Which document schema a page needs (docs/adr/2425-*): the highest NODE_SCHEMA version of the node
 * types in its Yjs document, 1 when it holds none of them. A collaboration connection whose client
 * knows a lower schema is read-only on that page, because its editor would delete the nodes it does
 * not know (y-prosemirror, ADR 0940) and send the deletion as an edit.
 */

/** The highest version any listed node can need: a walk stops once it has seen it. */
export const MAX_NODE_SCHEMA = Math.max(1, ...Object.values(NODE_SCHEMA))

/** Schema the subtree under `node` needs (the node itself included when it is an element), at least `floor`. */
export function schemaOfNode(node: Y.XmlElement | Y.XmlFragment, floor = 1): number {
  let need = floor
  const visit = (el: Y.XmlElement): void => {
    const v = NODE_SCHEMA[el.nodeName]
    if (v !== undefined && v > need) need = v
    if (need >= MAX_NODE_SCHEMA) return
    for (const c of el.toArray()) {
      if (c instanceof Y.XmlElement) visit(c)
      if (need >= MAX_NODE_SCHEMA) return
    }
  }
  if (node instanceof Y.XmlElement) visit(node)
  else {
    for (const c of node.toArray()) {
      if (c instanceof Y.XmlElement) visit(c)
      if (need >= MAX_NODE_SCHEMA) break
    }
  }
  return need
}

/** Schema a whole document needs (its BlockNote fragment). */
export function schemaOfDoc(doc: Y.Doc): number {
  return schemaOfNode(doc.getXmlFragment('document'))
}

/** Schema a stored page state (page_docs.state, V1 or V2) needs; 1 for an empty state. */
export function schemaOfStoredState(state: Uint8Array | null | undefined): number {
  if (!state || state.length === 0) return 1
  const doc = new Y.Doc()
  try {
    applyStoredState(doc, state)
    return schemaOfDoc(doc)
  } finally {
    doc.destroy()
  }
}

/** Last known need of each loaded document. Raised at once by the observer below, lowered only by a full walk. */
const needs = new WeakMap<Y.Doc, number>()

/** Walks the document now and remembers the result (a group removed since lowers it again). */
export function refreshDocSchema(doc: Y.Doc): number {
  const v = schemaOfDoc(doc)
  needs.set(doc, v)
  return v
}

/** The remembered need of a watched document (a walk when it is not watched). O(1) once watched. */
export function docSchemaNeeds(doc: Y.Doc): number {
  return needs.get(doc) ?? refreshDocSchema(doc)
}

/**
 * Keeps the need of a loaded document current: a full walk now, then every transaction that adds
 * elements raises it when an added subtree holds a newer node. Runs synchronously at the end of the
 * transaction that applied the update, so `onRaise` sees it before any later message is handled.
 * Only element children inserted in the transaction are looked at (typing changes text, which is
 * skipped at once); a subtree inserted whole (a rewrite's new blockGroup) is walked.
 */
export function watchDocSchema(doc: Y.Doc, onRaise: (doc: Y.Doc, need: number) => void): void {
  if (needs.has(doc)) return
  refreshDocSchema(doc)
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    const before = needs.get(doc) ?? 1
    if (before >= MAX_NODE_SCHEMA) return
    let need = before
    for (const type of tr.changed.keys()) {
      if (!(type instanceof Y.XmlElement || type instanceof Y.XmlFragment)) continue
      for (let item = type._start; item !== null; item = item.right) {
        if (item.deleted || !(item.content instanceof Y.ContentType)) continue
        if (item.id.clock < (tr.beforeState.get(item.id.client) ?? 0)) continue
        const el = item.content.type
        if (el instanceof Y.XmlElement) need = schemaOfNode(el, need)
        if (need >= MAX_NODE_SCHEMA) break
      }
      if (need >= MAX_NODE_SCHEMA) break
    }
    if (need > before) {
      needs.set(doc, need)
      onRaise(doc, need)
    }
  })
}
