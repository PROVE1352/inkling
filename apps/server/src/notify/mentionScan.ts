import * as Y from 'yjs'
import { applyStoredState } from '../yState'

/**
 * @mentions of people in a document body, read straight from the Yjs state (docs/adr/1002-*).
 *
 * The server's BlockNote schema has no `mention` inline (md/convert drops it), so the mention chips
 * the web editor writes (`XmlElement('mention', { kind, id, label })`) are found by walking the XML
 * fragment by node name. That is structure-agnostic: it does not depend on how BlockNote nests
 * blockGroup / blockContainer / content nodes, only on the inline's name and attributes.
 *
 * Plain-text "@Name" written by agents (they cannot create chips through Markdown) is matched
 * separately against member names (`textMentions`).
 */

export interface DocMention {
  userId: string
  /** BlockNote id of the block holding the chip (null when not inside a blockContainer). */
  blockId: string | null
  /** Index of the top-level block (for mapping to a section). */
  top: number
  /** Plain text of the line holding the chip, chips rendered as `@label`. */
  text: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Upper bound of mentions read from one document (a pasted wall of chips must not fan out). */
export const MAX_DOC_MENTIONS = 200
const MENTION_BYTES = Buffer.from('mention')

/** Cheap pre-check: a state without the bytes "mention" cannot hold a mention chip. */
export function mayHaveMentions(state: Uint8Array): boolean {
  return Buffer.from(state.buffer, state.byteOffset, state.byteLength).includes(MENTION_BYTES)
}

function attrString(el: Y.XmlElement, name: string): string {
  const v = el.getAttribute(name) as unknown
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function lineText(el: Y.XmlElement | Y.XmlFragment): string {
  let s = ''
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as { insert?: unknown }[]) if (typeof d.insert === 'string') s += d.insert
    } else if (c instanceof Y.XmlElement && c.nodeName === 'mention') {
      s += `@${attrString(c, 'label')}`
    }
  }
  return s.replace(/\s+/g, ' ').trim()
}

function walk(
  node: Y.XmlElement | Y.XmlFragment,
  depth: number,
  top: number,
  blockId: string | null,
  out: DocMention[],
): void {
  const children = node.toArray()
  for (let i = 0; i < children.length && out.length < MAX_DOC_MENTIONS; i++) {
    const c = children[i]
    if (!(c instanceof Y.XmlElement)) continue
    if (c.nodeName === 'mention') {
      const id = attrString(c, 'id')
      if (attrString(c, 'kind') !== 'page' && UUID_RE.test(id)) {
        out.push({ userId: id.toLowerCase(), blockId, top, text: lineText(node) })
      }
      continue
    }
    let t = top
    let b = blockId
    if (c.nodeName === 'blockContainer') {
      b = attrString(c, 'id') || null
      // depth 1 = children of the top-level blockGroup (fragment › blockGroup › blockContainer)
      if (depth === 1) t = i
    }
    walk(c, depth + 1, t, b, out)
  }
}

/** Every person mention chip in the document, in document order. */
export function scanMentions(state: Uint8Array): DocMention[] {
  if (!mayHaveMentions(state)) return []
  const doc = new Y.Doc()
  try {
    applyStoredState(doc, state)
    return scanMentionsInDoc(doc)
  } finally {
    doc.destroy()
  }
}

/** Mention chips of an already decoded document (read-only Yjs walk; run it before a BlockNote read). */
export function scanMentionsInDoc(doc: Y.Doc): DocMention[] {
  const out: DocMention[] = []
  walk(doc.getXmlFragment('document'), 0, 0, null, out)
  return out
}

/**
 * Plain-text "@Display Name" mentions in `text` that match a member name exactly (case-insensitive,
 * NFKC). Longest names first so "@Ann Lee" wins over "@Ann". Returns matched user ids.
 */
export function textMentions(text: string, members: { id: string; name: string }[]): string[] {
  if (!text.includes('@') && !text.includes('＠')) return []
  const norm = (s: string) => s.normalize('NFKC').toLowerCase()
  const hay = norm(text)
  const sorted = members.filter((m) => m.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length)
  const found = new Set<string>()
  // '@' positions already claimed by a longer name ("@Ann Lee" is not also "@Ann")
  const taken = new Set<number>()
  for (const m of sorted) {
    const needle = `@${norm(m.name.trim())}`
    let at = hay.indexOf(needle)
    while (at >= 0) {
      const before = at === 0 ? ' ' : hay[at - 1]
      const after = hay[at + needle.length] ?? ' '
      // a word boundary on both sides: not part of an email address or a longer word
      if (!taken.has(at) && !/[\p{L}\p{N}_.]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
        found.add(m.id)
        taken.add(at)
      }
      at = hay.indexOf(needle, at + 1)
    }
  }
  return [...found]
}
