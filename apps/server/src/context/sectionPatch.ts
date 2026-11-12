import * as Y from 'yjs'
import { badRequest } from '../errors'
import { blocksToMarkdown, markdownToBlocks } from '../md/convert'
import type { AnyBlock, ResolveTitle } from '../md/convert'
import type { ParseNotationOptions } from '../md/notation'
import { getServerEditor } from '../md/editor'
import { blocksToLightMarkdown, findSection, inlinesText, splitSections } from './chunker'
import type { Section } from './chunker'
import { myers } from './diff'

/**
 * patch_section on the live Yjs document (docs/adr/0930-*, 0940-*).
 *
 * `replace` is a minimal edit, not a block swap:
 *   1. The old section blocks and the new ones are aligned block by block (Myers on a per-block key).
 *      A block the agent did not change keeps its Yjs item untouched (same id, same text items).
 *   2. Changed blocks of the same type are edited in place: the text of each Y.XmlText run is diffed
 *      character by character and only insert/delete/format operations are applied, so characters a
 *      person typed concurrently (not yet on the server) merge as ordinary CRDT edits.
 *   3. Only blocks without a counterpart are inserted (clones of containers BlockNote built on a
 *      throwaway doc) or deleted.
 *
 * Things the agent cannot see are never touched: containers the server schema does not know
 * (callout, page embed, link embed, plugin blocks), inline nodes it does not know (mentions), props
 * Markdown cannot express (colors, alignment, image width, toggleable headings) and marks Markdown
 * cannot express (underline, text/background color).
 *
 * The edit is first run on a copy of the document and validated there (the copy is read back
 * through BlockNote: every known block must survive the read, and every edited or inserted block
 * must read back as the requested content). Only then does the same deterministic edit run on the
 * live document, so a bug cannot leave half a patch behind; if validation fails the old block splice
 * runs instead. (Applying the copy's update instead would write under a foreign client id — one new
 * state-vector entry per patch — and Yjs refuses an update carrying the doc's own id.)
 *
 * Never call `yDocToBlocks` on the live document: y-prosemirror deletes the Yjs items of nodes the
 * schema does not know while reading (its recovery for invalid content), so reading the live doc
 * would remove every callout and mention in the page. Reads always go through a copy.
 */

export type PatchMode = 'replace' | 'append' | 'prepend' | 'insert_after' | 'delete'

export interface PatchStats {
  /** 'merge' = minimal edit, 'splice' = fallback block replacement, 'insert'/'delete' for those modes. */
  strategy: 'merge' | 'splice' | 'insert' | 'delete'
  /** Blocks (any depth) left untouched. */
  kept: number
  /** Blocks edited in place (id kept). */
  edited: number
  inserted: number
  deleted: number
}

export type PatchOutcome =
  | { status: 'ok'; section: Section | null; sections: Section[]; stats: PatchStats }
  | { status: 'conflict'; section: Section; blocks: AnyBlock[] }
  | { status: 'not_found'; sections: Section[] }

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Blocks of a Y.Doc read through BlockNote on a copy (the read is destructive for unknown nodes). */
export function readBlocks(doc: Y.Doc): AnyBlock[] {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  try {
    return getServerEditor().yDocToBlocks(copy, 'document') as unknown as AnyBlock[]
  } finally {
    copy.destroy()
  }
}

/**
 * A throwaway doc whose top-level group holds clones of `group`'s children [from, to) — a copy of
 * one region of a document, so reading or editing it costs the region, not the document
 * (docs/adr/1042-*).
 */
export function copyTopRange(group: Y.XmlElement, from: number, to: number): Y.Doc {
  const doc = new Y.Doc()
  const g = new Y.XmlElement('blockGroup')
  for (const [k, v] of Object.entries(group.getAttributes())) g.setAttribute(k, v as string)
  doc.getXmlFragment('document').insert(0, [g])
  g.insert(0, group.toArray().slice(from, to).map((el) => (el as Y.XmlElement | Y.XmlText).clone()))
  return doc
}

/** Blocks of `group`'s children [from, to), read through BlockNote on a copy of just that range. */
export function readTopRange(group: Y.XmlElement, from: number, to: number): AnyBlock[] {
  const tmp = copyTopRange(group, from, to)
  try {
    return getServerEditor().yDocToBlocks(tmp, 'document') as unknown as AnyBlock[]
  } finally {
    tmp.destroy()
  }
}

// ---------------------------------------------------------------------------
// what the agent saw: per-block "echo" keys
// ---------------------------------------------------------------------------

/**
 * Key of a block as Markdown sees it: the block exported to Markdown on its own and parsed back,
 * without id and children. The agent's new blocks are parsed from Markdown too, so an untouched
 * block has the same key even when the Markdown round trip is lossy (colors, toggles, mark combos).
 */
export interface EchoEntry {
  key: string
  type: string
}
export type EchoIndex = Map<string, EchoEntry>

/** Blocks as the server reads them back from Yjs (the form the patch compares). */
function normalizeBlocks(blocks: AnyBlock[]): AnyBlock[] {
  if (blocks.length === 0) return []
  const { tmp, read } = buildIncoming(blocks)
  tmp.destroy()
  return read
}

function fingerprint(b: AnyBlock): string {
  return JSON.stringify({ ...b, children: undefined })
}

function keyOf(b: AnyBlock): string {
  // A group of columns is one unit (docs/adr/2424-*): its key covers every block inside it at any depth,
  // so it is kept only when nothing in it changed and otherwise replaced whole.
  if (b.type === 'columnList' || b.type === 'column') return deepKey(b)
  return JSON.stringify([b.type ?? '', b.props ?? {}, b.content ?? null])
}

function deepKey(b: AnyBlock): string {
  return JSON.stringify([b.type ?? '', b.props ?? {}, b.content ?? null, (b.children ?? []).map((c) => deepKey(c))])
}

/**
 * Echo keys for blocks (and their children) — async, computed before the synchronous patch. The
 * agent read the section in the agent notation (docs/adr/1500-*), so the echo uses it too, and
 * parses with the same options as the agent's Markdown (`notation`: which mention chips may stay).
 */
export async function buildEchoIndex(
  blocks: AnyBlock[],
  resolveTitle: ResolveTitle,
  notation: ParseNotationOptions = {},
  incoming?: AnyBlock[],
): Promise<EchoIndex> {
  const out: EchoIndex = new Map()
  // Shortcut (docs/adr/1500-*): a block equal to one of the agent's new blocks as it is (key without
  // the round trip) needs no echo — it was sent back exactly. Only the others pay two conversions.
  const direct = new Set<string>()
  if (incoming?.length) {
    const collect = (bs: AnyBlock[]) => bs.forEach((x) => (direct.add(keyOf(x)), collect(x.children ?? [])))
    collect(normalizeBlocks(incoming))
  }
  const visit = async (b: AnyBlock): Promise<void> => {
    const own = keyOf(b)
    if (direct.has(own)) {
      out.set(fingerprint(b), { key: own, type: b.type ?? '' })
      for (const c of b.children ?? []) await visit(c)
      return
    }
    // a group of columns round-trips whole (its key covers its blocks); its inner blocks are never paired
    const group = b.type === 'columnList'
    const { markdown } = await blocksToMarkdown([group ? b : { ...b, children: [] }], { assetMode: 'absolute', notation: 'agent' })
    const parsed = normalizeBlocks(await markdownToBlocks(markdown, resolveTitle, undefined, notation))
    out.set(fingerprint(b), {
      key: parsed.length === 1 ? keyOf(parsed[0]) : `\u0000multi:${JSON.stringify(parsed.map(keyOf))}`,
      type: parsed.length === 1 ? (parsed[0].type ?? '') : (b.type ?? ''),
    })
    if (group) return
    for (const c of b.children ?? []) await visit(c)
  }
  for (const b of blocks) await visit(b)
  return out
}

// ---------------------------------------------------------------------------
// Markdown expressiveness (guarded by sectionPatch.test.ts against BlockNote's round trip)
// ---------------------------------------------------------------------------

/** Marks the Markdown round trip keeps; other marks on existing text are never changed. */
export const MARKDOWN_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link'])
/** Block props the Markdown round trip loses; an edit never overwrites them. */
export const NON_MARKDOWN_PROPS = new Set(['backgroundColor', 'textColor', 'textAlignment', 'isToggleable', 'previewWidth'])
/** Markdown has no toggle list: a toggle item reads back as a bullet item, so they pair. */
function pairType(type: string): string {
  return type === 'toggleListItem' ? 'bulletListItem' : type
}

// ---------------------------------------------------------------------------
// Yjs structure helpers (BlockNote 0.51 + y-prosemirror 1.3):
//   blockGroup > blockContainer{id} > [<content node>{props}, blockGroup?]
//   <content node> > (Y.XmlText | inline Y.XmlElement)*   (text runs and inline nodes alternate)
//   table > tableRow > tableHeader|tableCell > tableParagraph > Y.XmlText
// ---------------------------------------------------------------------------

function isEl(x: unknown, name?: string): x is Y.XmlElement {
  return x instanceof Y.XmlElement && (name === undefined || x.nodeName === name)
}

function contentNode(container: Y.XmlElement): Y.XmlElement | null {
  const first = container.get(0)
  return isEl(first) && first.nodeName !== 'blockGroup' ? first : null
}

function childGroup(container: Y.XmlElement): Y.XmlElement | null {
  for (const ch of container.toArray()) if (isEl(ch, 'blockGroup')) return ch
  return null
}

function structureError(): never {
  throw badRequest('Unexpected document structure; nothing was changed. Use update_page instead.')
}

function indexContainers(group: Y.XmlElement, map: Map<string, Y.XmlElement>): void {
  for (const c of group.toArray()) {
    if (isEl(c, 'columnList')) {
      // a group of columns is one top-level unit: replaced whole, never merged inside (docs/adr/2424-*)
      const id = c.getAttribute('id')
      if (typeof id === 'string') {
        if (map.has(id)) structureError()
        map.set(id, c)
      }
      continue
    }
    if (!isEl(c, 'blockContainer')) continue
    const id = c.getAttribute('id')
    if (typeof id === 'string') {
      if (map.has(id)) structureError()
      map.set(id, c)
    }
    const g = childGroup(c)
    if (g) indexContainers(g, map)
  }
}

let inlineNodeNames: Set<string> | null = null
/** Inline (non-text) nodes the server schema knows, e.g. hardBreak. Others (mention) are opaque. */
function knownInlineNodes(): Set<string> {
  if (!inlineNodeNames) {
    const schema = getServerEditor().editor.pmSchema
    inlineNodeNames = new Set(
      Object.values(schema.nodes)
        .filter((n) => n.isInline && !n.isText)
        .map((n) => n.name),
    )
  }
  return inlineNodeNames
}

// ---------------------------------------------------------------------------
// sequence alignment
// ---------------------------------------------------------------------------

type Op = { t: '='; i: number; j: number } | { t: '-'; i: number } | { t: '+'; j: number }

/**
 * Edit script between two key lists (common prefix/suffix, then Myers); over the caps: replace all.
 * `used.work` (optional) is increased by the Myers work this call took (docs/adr/2550-*).
 */
function align(a: string[], b: string[], maxD: number, maxWork: number, used?: { work: number }): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const out: Op[] = []
  for (let k = 0; k < pre; k++) out.push({ t: '=', i: k, j: k })
  const budget = { left: maxWork }
  const mid = am.length && bm.length ? myers(am, bm, maxD, budget) : null
  if (used) used.work += maxWork - Math.max(0, budget.left)
  if (mid) {
    let i = pre
    let j = pre
    for (const o of mid) {
      if (o.t === '=') out.push({ t: '=', i: i++, j: j++ })
      else if (o.t === '-') out.push({ t: '-', i: i++ })
      else out.push({ t: '+', j: j++ })
    }
  } else {
    for (let k = 0; k < am.length; k++) out.push({ t: '-', i: pre + k })
    for (let k = 0; k < bm.length; k++) out.push({ t: '+', j: pre + k })
  }
  for (let k = 0; k < suf; k++) out.push({ t: '=', i: a.length - suf + k, j: b.length - suf + k })
  return out
}

// ---------------------------------------------------------------------------
// inline (character level) reconcile
// ---------------------------------------------------------------------------

type Attrs = Record<string, unknown>
type CharTok = { k: 'c'; ch: string; attrs: Attrs; seg: Y.XmlText; off: number }
type ElTok = { k: 'e'; key: string; el: Y.XmlElement }
type Tok = CharTok | ElTok

function tokens(content: Y.XmlElement): Tok[] {
  const known = knownInlineNodes()
  const out: Tok[] = []
  for (const child of content.toArray()) {
    if (child instanceof Y.XmlText) {
      let off = 0
      for (const op of child.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
        if (typeof op.insert !== 'string') {
          off += 1 // embed: invisible to the server, keep in place
          continue
        }
        for (const ch of op.insert) {
          out.push({ k: 'c', ch, attrs: op.attributes ?? {}, seg: child, off })
          off += ch.length
        }
      }
    } else if (isEl(child) && known.has(child.nodeName)) {
      out.push({ k: 'e', key: `\u0000${child.nodeName}${JSON.stringify(child.getAttributes())}`, el: child })
    }
    // other inline elements (mention, …) are opaque: never part of the diff, never touched
  }
  return out
}

const tokKey = (t: Tok) => (t.k === 'c' ? t.ch : t.key)

function markdownMarks(attrs: Attrs): Attrs {
  const out: Attrs = {}
  for (const [k, v] of Object.entries(attrs)) if (MARKDOWN_MARKS.has(k) && v != null) out[k] = v
  return out
}

function otherMarks(attrs: Attrs): Attrs {
  const out: Attrs = {}
  for (const [k, v] of Object.entries(attrs)) if (!MARKDOWN_MARKS.has(k) && v != null) out[k] = v
  return out
}

/** Markdown-expressible mark changes from `from` to `to` ({} when equal). */
function markChange(from: Attrs, to: Attrs): Attrs {
  const a = markdownMarks(from)
  const b = markdownMarks(to)
  const change: Attrs = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) change[k] = b[k] ?? null
  }
  return change
}

const INLINE_MAX_D = 4_000
const INLINE_MAX_WORK = 4_000_000

/**
 * What one replace (patch_section or update_page) may spend on character-level edits
 * (docs/adr/2550-*). Each Yjs text operation can split an item, and a split moves the rest of the
 * writing client's struct array, so a replace that pairs hundreds of rewritten paragraphs costs
 * operations × structs; past the budget a changed block keeps its id but has its content node
 * swapped whole (`swapContent`). Counted, never timed, so the dry run and the live edit take the same
 * path. The values sit far above what any edit in the test suites uses (measured, see the ADR).
 */
export interface EditBudget {
  /** Yjs text operations (insert / delete / format calls) left. */
  textOps: number
  /** Diff work left: characters tokenized + Myers steps. */
  diffWork: number
}
export const REPLACE_BUDGET: Readonly<EditBudget> = { textOps: 2_000, diffWork: 40_000_000 }
/** A pair whose two content nodes hold more characters than this together is never diffed. */
const INLINE_MAX_TOKENS = 200_000
let budgetOverride: EditBudget | null = null
/**
 * A replace whose old and new blocks hold at most this many characters together has no budget: its
 * edit is the same as before the budget, byte for byte (a whole rewrite of a 50K body included). The
 * cost the budget bounds is operations × structs, which only a large range makes large.
 */
const BUDGET_FREE_CHARS = 128 * 1024
const UNBOUNDED: Readonly<EditBudget> = { textOps: Number.MAX_SAFE_INTEGER, diffWork: Number.MAX_SAFE_INTEGER }

/** Characters of blocks as the budget gate counts them: inline text, other content as JSON, children too. */
function blockChars(blocks: AnyBlock[]): number {
  let n = 0
  for (const b of blocks) {
    if (Array.isArray(b.content)) n += inlinesText(b.content).length
    else if (b.content != null) n += JSON.stringify(b.content).length
    n += blockChars(b.children ?? [])
  }
  return n
}

/**
 * A budget several patches share (patch_sections, a revert batch): each patch spends from what the
 * previous ones left. Make one per run over the edits, so a dry run and the live run start equal.
 */
export function newReplaceBudget(): EditBudget {
  return { ...(budgetOverride ?? REPLACE_BUDGET) }
}

/** Tests only: a smaller budget (null restores the default). */
export function setReplaceBudgetForTests(b: Partial<EditBudget> | null): void {
  budgetOverride = b ? { ...REPLACE_BUDGET, ...b } : null
}

/** What the last replace edit (its live run) used; for tests and benches. */
export interface ReplaceWork {
  textOps: number
  diffWork: number
  /** Changed blocks whose content node was swapped whole because the budget was spent. */
  swapped: number
}
let lastWork: ReplaceWork = { textOps: 0, diffWork: 0, swapped: 0 }
export function lastReplaceWork(): ReplaceWork {
  return { ...lastWork }
}

type Cursor = { k: 'text'; seg: Y.XmlText; off: number } | { k: 'after'; ref: Y.XmlElement | Y.XmlText | null }

type InlineEdit =
  | { kind: 'del'; pos: number; seg: Y.XmlText; off: number; len: number }
  | { kind: 'delEl'; pos: number; el: Y.XmlElement }
  | { kind: 'fmt'; pos: number; seg: Y.XmlText; off: number; len: number; change: Attrs; sig: string }
  | { kind: 'ins'; pos: number; toks: Tok[] }

/** A planned character-level edit of one content node, and the Yjs operations it will take. */
interface InlinePlan {
  content: Y.XmlElement
  old: Tok[]
  edits: InlineEdit[]
  textOps: number
}

/**
 * What the character diff compares, as one string: the text runs with their Markdown marks (keys
 * sorted, as `markChange` compares them key by key) and the known inline nodes' keys; embeds and
 * unknown inline nodes are left out as `tokens` leaves them out. Equal keys mean the diff of the two
 * nodes has no edit at all.
 */
function inlineKey(content: Y.XmlElement): string {
  const known = knownInlineNodes()
  const parts: string[][] = []
  let text = ''
  let sig: string | null = null
  const flush = () => {
    if (text) parts.push([sig ?? '', text])
    text = ''
    sig = null
  }
  for (const child of content.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
        if (typeof op.insert !== 'string' || !op.insert) continue
        const marks = markdownMarks(op.attributes ?? {})
        const s = JSON.stringify(Object.keys(marks).sort().map((k) => [k, marks[k]]))
        if (s !== sig) flush()
        sig = s
        text += op.insert
      }
    } else if (isEl(child) && known.has(child.nodeName)) {
      flush()
      parts.push([`\u0000${child.nodeName}${JSON.stringify(child.getAttributes())}`])
    }
  }
  flush()
  return JSON.stringify(parts)
}

/** Characters (and inline nodes) of a content node, counted without tokenizing it. */
function inlineLength(content: Y.XmlElement): number {
  let n = 0
  for (const child of content.toArray()) n += child instanceof Y.XmlText ? child.length : 1
  return n
}

/**
 * Turns the inline content of `oldContent` into that of `newContent` with character-level
 * insert/delete/format operations. Edits are applied from the end backwards so the offsets
 * recorded for earlier tokens stay valid.
 */
function reconcileInline(oldContent: Y.XmlElement, newContent: Y.XmlElement): void {
  applyInline(planInline(oldContent, newContent, null)!)
}

/**
 * The edit of `reconcileInline`, planned without touching the document. With a budget
 * (docs/adr/2550-*): null — and nothing charged but the diff work — when this edit does not fit in
 * what is left of the replace's budget; the caller then swaps the content node instead.
 */
function planInline(oldContent: Y.XmlElement, newContent: Y.XmlElement, budget: EditBudget | null): InlinePlan | null {
  // Same characters and Markdown marks: the diff would find nothing, so it is not run (and a block
  // the agent left alone is never swapped, whatever is left of the budget).
  if (budget && inlineKey(oldContent) === inlineKey(newContent)) return { content: oldContent, old: [], edits: [], textOps: 0 }
  if (budget) {
    // every character becomes a token object: a pair too large to tokenize is not diffed at all
    if (budget.textOps <= 0 || budget.diffWork <= 0) return null
    const size = inlineLength(oldContent) + inlineLength(newContent)
    if (size > INLINE_MAX_TOKENS) return null
    budget.diffWork -= size
  }
  const a = tokens(oldContent)
  const b = tokens(newContent)
  const used = { work: 0 }
  const ops = align(a.map(tokKey), b.map(tokKey), INLINE_MAX_D, INLINE_MAX_WORK, used)
  if (budget) budget.diffWork -= used.work

  type Edit = InlineEdit
  const edits: Edit[] = []
  let last: Edit | null = null
  let consumed = 0 // old tokens before the current op = the gap an insertion goes into
  for (const o of ops) {
    if (o.t === '+') {
      if (last && last.kind === 'ins' && last.pos === consumed) last.toks.push(b[o.j])
      else edits.push((last = { kind: 'ins', pos: consumed, toks: [b[o.j]] }))
      continue
    }
    consumed++
    const t = a[o.i]
    if (o.t === '-') {
      if (t.k === 'e') {
        edits.push((last = { kind: 'delEl', pos: o.i, el: t.el }))
      } else if (last && last.kind === 'del' && last.seg === t.seg && last.off + last.len === t.off) {
        last.len += t.ch.length
      } else {
        edits.push((last = { kind: 'del', pos: o.i, seg: t.seg, off: t.off, len: t.ch.length }))
      }
      continue
    }
    // '=': same character; sync Markdown marks only
    const nt = b[o.j]
    if (t.k !== 'c' || nt.k !== 'c') {
      last = null
      continue
    }
    const change = markChange(t.attrs, nt.attrs)
    const sig = JSON.stringify(change)
    if (sig === '{}') {
      last = null
      continue
    }
    if (last && last.kind === 'fmt' && last.seg === t.seg && last.off + last.len === t.off && last.sig === sig) {
      last.len += t.ch.length
    } else {
      edits.push((last = { kind: 'fmt', pos: o.i, seg: t.seg, off: t.off, len: t.ch.length, change, sig }))
    }
  }
  // Backwards; at equal positions deletions/formats of token `pos` before insertions in gap `pos`.
  edits.sort((x, y) => y.pos - x.pos || (x.kind === 'ins' ? 1 : 0) - (y.kind === 'ins' ? 1 : 0))
  let textOps = 0
  for (const e of edits) textOps += e.kind === 'ins' ? insertRuns(e.toks) : 1
  if (budget) {
    if (textOps > budget.textOps) return null
    budget.textOps -= textOps
  }
  return { content: oldContent, old: a, edits, textOps }
}

/** Yjs calls `insertTokens` makes for `toks`: one per inline node, one per run of equal marks. */
function insertRuns(toks: Tok[]): number {
  let n = 0
  let sig: string | null = null
  for (const t of toks) {
    if (t.k === 'e') {
      n++
      sig = null
      continue
    }
    const s = JSON.stringify(t.attrs)
    if (s !== sig) n++
    sig = s
  }
  return n
}

function applyInline(plan: InlinePlan): void {
  const { content: oldContent, old: a } = plan
  for (const e of plan.edits) {
    if (e.kind === 'del') e.seg.delete(e.off, e.len)
    else if (e.kind === 'fmt') e.seg.format(e.off, e.len, e.change as Record<string, unknown>)
    else if (e.kind === 'delEl') {
      const idx = oldContent.toArray().indexOf(e.el)
      if (idx >= 0) oldContent.delete(idx, 1)
    } else insertTokens(oldContent, a, e.pos, e.toks)
  }
}

function insertTokens(content: Y.XmlElement, old: Tok[], gap: number, toks: Tok[]): void {
  const left = gap > 0 ? old[gap - 1] : undefined
  const right = gap < old.length ? old[gap] : undefined
  let cur: Cursor
  if (left?.k === 'c') cur = { k: 'text', seg: left.seg, off: left.off + left.ch.length }
  else if (right?.k === 'c') cur = { k: 'text', seg: right.seg, off: right.off }
  else if (left?.k === 'e') cur = { k: 'after', ref: left.el }
  else if (right?.k === 'e') cur = { k: 'after', ref: previousSibling(content, right.el) }
  else cur = { k: 'after', ref: lastChild(content) }
  // Marks Markdown cannot express (underline, colors) continue from the neighbouring text.
  const inherited = left?.k === 'c' ? otherMarks(left.attrs) : right?.k === 'c' ? otherMarks(right.attrs) : {}

  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t.k === 'e') {
      cur = insertElement(content, cur, t.el.clone())
      i++
      continue
    }
    let text = ''
    const sig = JSON.stringify(t.attrs)
    while (i < toks.length && toks[i].k === 'c' && JSON.stringify((toks[i] as CharTok).attrs) === sig) {
      text += (toks[i] as CharTok).ch
      i++
    }
    const attrs = { ...inherited, ...markdownMarks(t.attrs) }
    if (cur.k === 'text') {
      cur.seg.insert(cur.off, text, attrs)
      cur = { k: 'text', seg: cur.seg, off: cur.off + text.length }
    } else {
      const seg = new Y.XmlText()
      insertChildAfter(content, cur.ref, seg)
      seg.insert(0, text, attrs)
      cur = { k: 'text', seg, off: text.length }
    }
  }
}

function previousSibling(content: Y.XmlElement, el: Y.XmlElement | Y.XmlText): Y.XmlElement | Y.XmlText | null {
  const arr = content.toArray()
  const idx = arr.indexOf(el)
  return idx > 0 ? (arr[idx - 1] as Y.XmlElement | Y.XmlText) : null
}

function lastChild(content: Y.XmlElement): Y.XmlElement | Y.XmlText | null {
  return content.length ? (content.get(content.length - 1) as Y.XmlElement | Y.XmlText) : null
}

function insertChildAfter(content: Y.XmlElement, ref: Y.XmlElement | Y.XmlText | null, child: Y.XmlElement | Y.XmlText): void {
  content.insertAfter(ref, [child])
}

/** Inserts an inline element at the cursor, splitting the text run when the cursor is inside it. */
function insertElement(content: Y.XmlElement, cur: Cursor, el: Y.XmlElement): Cursor {
  if (cur.k === 'after') {
    insertChildAfter(content, cur.ref, el)
    return { k: 'after', ref: el }
  }
  const { seg, off } = cur
  if (off === 0) {
    insertChildAfter(content, previousSibling(content, seg), el)
    return { k: 'text', seg, off: 0 }
  }
  if (off >= seg.length) {
    insertChildAfter(content, seg, el)
    return { k: 'after', ref: el }
  }
  // split: [seg | tail] → [seg, el, tail]
  const tail = sliceDelta(seg.toDelta() as { insert: unknown; attributes?: Attrs }[], off)
  seg.delete(off, seg.length - off)
  const rest = new Y.XmlText()
  insertChildAfter(content, seg, rest)
  rest.applyDelta(tail)
  insertChildAfter(content, seg, el)
  return { k: 'text', seg: rest, off: 0 }
}

function sliceDelta(delta: { insert: unknown; attributes?: Attrs }[], from: number): { insert: unknown; attributes?: Attrs }[] {
  const out: { insert: unknown; attributes?: Attrs }[] = []
  let pos = 0
  for (const op of delta) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1
    if (pos + len <= from) {
      pos += len
      continue
    }
    if (typeof op.insert === 'string') {
      const s = op.insert.slice(Math.max(0, from - pos))
      if (s) out.push(op.attributes ? { insert: s, attributes: op.attributes } : { insert: s })
    } else {
      out.push(op)
    }
    pos += len
  }
  return out
}

// ---------------------------------------------------------------------------
// block level reconcile
// ---------------------------------------------------------------------------

interface Ctx {
  echo: EchoIndex | null
  live: Map<string, Y.XmlElement>
  stats: PatchStats
  /** Edited/inserted blocks and the content they must read back as (validation). */
  expect: { id: string; block: AnyBlock | null }[]
  /** What is left of this edit's budget (docs/adr/2550-*); one per run, so the dry run and the live edit agree. */
  budget: EditBudget
  swapped: number
}

function countBlocks(blocks: AnyBlock[] | undefined): number {
  let n = 0
  for (const b of blocks ?? []) n += 1 + countBlocks(b.children)
  return n
}

/** Copies the new content node's props, except props Markdown cannot express (kept as they are). */
function reconcileAttrs(oldContent: Y.XmlElement, newContent: Y.XmlElement): void {
  const cur = oldContent.getAttributes()
  for (const [k, v] of Object.entries(newContent.getAttributes())) {
    if (NON_MARKDOWN_PROPS.has(k)) continue
    if (JSON.stringify(cur[k]) !== JSON.stringify(v)) oldContent.setAttribute(k, v as never)
  }
}

/**
 * Over the edit budget (docs/adr/2550-*): the changed block's content node is replaced by the new
 * one inside the same container, so the block id (comment anchors, block links) stays. Block colors,
 * alignment and toggles are carried over as in a retype; the old text's items are deleted, so marks Markdown
 * cannot express, inline nodes the server does not know (mention chips not in the new Markdown) and
 * characters typed into this block concurrently are lost, as in a table edit.
 */
function swapContent(oldEl: Y.XmlElement, oc: Y.XmlElement, nc: Y.XmlElement, ctx: Ctx): void {
  // a toggle item paired with a bullet item stays a toggle, as in the in-place edit
  const el = new Y.XmlElement(pairType(oc.nodeName) === pairType(nc.nodeName) ? oc.nodeName : nc.nodeName)
  oldEl.insert(0, [el])
  const oldAttrs = oc.getAttributes()
  for (const [k, v] of Object.entries(nc.getAttributes())) el.setAttribute(k, (NON_MARKDOWN_PROPS.has(k) && k in oldAttrs ? oldAttrs[k] : v) as never)
  el.insert(0, nc.toArray().map((c) => (c as Y.XmlElement | Y.XmlText).clone()))
  oldEl.delete(1, 1)
  ctx.swapped++
}

/** Content nodes a retype can carry inline content between (code blocks take no marks). */
function retypable(el: Y.XmlElement): boolean {
  return el.nodeName !== 'table' && el.nodeName !== 'codeBlock' && el.length > 0 && hasInlineContent(el)
}

function hasInlineContent(el: Y.XmlElement): boolean {
  return el.toArray().every((c) => c instanceof Y.XmlText || (isEl(c) && c.nodeName !== 'tableRow' && c.nodeName !== 'blockGroup'))
}

/** One old container ↔ one new container. `same`: the agent did not change this block itself. */
function reconcileBlock(
  oldEl: Y.XmlElement,
  oldBlock: AnyBlock,
  newEl: Y.XmlElement,
  newBlock: AnyBlock,
  same: boolean,
  ctx: Ctx,
): void {
  const oc = contentNode(oldEl)
  const nc = contentNode(newEl)
  if (!oc || !nc) structureError()
  if (same) {
    ctx.stats.kept++
    ctx.expect.push({ id: oldBlock.id as string, block: null })
  } else {
    ctx.stats.edited++
    ctx.expect.push({ id: oldBlock.id as string, block: newBlock })
    const sameNode = oc.nodeName === nc.nodeName || (pairType(oc.nodeName) === pairType(nc.nodeName))
    if (!sameNode && retypable(oc) && retypable(nc)) {
      if (!planInline(oc, nc, ctx.budget)) {
        // over the budget (docs/adr/2550-*): the new content, block colors and alignment kept
        swapContent(oldEl, oc, nc, ctx)
      } else {
        // Retyped (paragraph → list item, …): a node of the new type that starts from the old inline
        // content — marks Markdown cannot express and mention chips stay — then the character diff.
        // Block colors / alignment the new type also has are carried over (docs/adr/1500-*).
        const el = new Y.XmlElement(nc.nodeName)
        oldEl.insert(0, [el])
        const newAttrs = nc.getAttributes()
        const oldAttrs = oc.getAttributes()
        for (const [k, v] of Object.entries(newAttrs)) el.setAttribute(k, (NON_MARKDOWN_PROPS.has(k) && k in oldAttrs ? oldAttrs[k] : v) as never)
        el.insert(0, oc.toArray().map((c) => (c as Y.XmlElement | Y.XmlText).clone()))
        oldEl.delete(1, 1)
        reconcileInline(el, nc)
      }
    } else if (!sameNode || oc.nodeName === 'table' || !hasInlineContent(oc) || !hasInlineContent(nc)) {
      // Tables (and anything that is not inline content) are replaced as a whole node; the block id stays.
      oldEl.insert(0, [nc.clone()])
      oldEl.delete(1, 1)
    } else {
      const plan = planInline(oc, nc, ctx.budget)
      if (plan) {
        reconcileAttrs(oc, nc)
        applyInline(plan)
      } else {
        swapContent(oldEl, oc, nc, ctx)
      }
    }
  }
  // children
  const og = childGroup(oldEl)
  const ng = childGroup(newEl)
  const newKids = newBlock.children ?? []
  if (!og) {
    if (ng && newKids.length) {
      oldEl.insert(oldEl.length, [ng.clone()])
      ctx.stats.inserted += countBlocks(newKids)
      expectInserted(ng, newKids, ctx)
    }
    return
  }
  syncList(og, oldBlock.children ?? [], newKids, ng ? (ng.toArray().filter((c) => isEl(c, 'blockContainer')) as Y.XmlElement[]) : [], null, ctx)
  if (og.length === 0) {
    const idx = oldEl.toArray().indexOf(og)
    if (idx >= 0) oldEl.delete(idx, 1)
  }
}

function expectInserted(group: Y.XmlElement, blocks: AnyBlock[], ctx: Ctx): void {
  const els = group.toArray().filter((c) => isEl(c, 'blockContainer')) as Y.XmlElement[]
  els.forEach((el, k) => {
    const id = el.getAttribute('id')
    if (typeof id === 'string' && blocks[k]) ctx.expect.push({ id, block: blocks[k] })
    const g = childGroup(el)
    if (g && blocks[k]?.children?.length) expectInserted(g, blocks[k].children!, ctx)
  })
}

type Act = { t: 'keep' | 'edit'; i: number; j: number } | { t: 'del'; i: number } | { t: 'ins'; j: number }

const RETYPE_MIN_SIMILARITY = 0.5

function words(b: AnyBlock): string[] {
  return inlinesText(b.content).toLowerCase().split(/\s+/).filter(Boolean)
}

/** Dice coefficient of the two blocks' word multisets (1 = same words). */
function similarity(a: AnyBlock, b: AnyBlock): number {
  const wa = words(a)
  const wb = words(b)
  if (!wa.length || !wb.length) return 0
  const count = new Map<string, number>()
  for (const w of wa) count.set(w, (count.get(w) ?? 0) + 1)
  let common = 0
  for (const w of wb) {
    const n = count.get(w) ?? 0
    if (n > 0) {
      common++
      count.set(w, n - 1)
    }
  }
  return (2 * common) / (wa.length + wb.length)
}

const inlineBlock = (b: AnyBlock) => Array.isArray(b.content) && b.type !== 'codeBlock'

/**
 * A block the agent retyped (paragraph → list item, …) comes out of the type alignment as a
 * deletion plus an insertion. Between two edits, when the deleted and inserted blocks pair up one to
 * one with mostly the same words, they are edits instead: the block keeps its id, and what Markdown
 * cannot say (marks, chips, colors) moves to the new type (docs/adr/1500-*).
 */
function pairRetypes(run: Act[], oldBlocks: AnyBlock[], newBlocks: AnyBlock[]): Act[] {
  const out: Act[] = []
  let seg: Act[] = []
  const flush = () => {
    const dels = seg.filter((a): a is { t: 'del'; i: number } => a.t === 'del')
    const ins = seg.filter((a): a is { t: 'ins'; j: number } => a.t === 'ins')
    const ok =
      dels.length > 0 &&
      dels.length === ins.length &&
      dels.every((d, k) => {
        const o = oldBlocks[d.i]
        const n = newBlocks[ins[k].j]
        return inlineBlock(o) && inlineBlock(n) && similarity(o, n) >= RETYPE_MIN_SIMILARITY
      })
    if (ok) dels.forEach((d, k) => out.push({ t: 'edit', i: d.i, j: ins[k].j }))
    else out.push(...seg)
    seg = []
  }
  for (const a of run) {
    if (a.t === 'edit' || a.t === 'keep') {
      flush()
      out.push(a)
    } else seg.push(a)
  }
  flush()
  return out
}

/**
 * Makes the visible blocks `oldBlocks` (containers inside `group`) become `newBlocks`.
 * Containers in `group` that are not in `oldBlocks` (unknown to the server schema) stay where they are.
 * `start`: the element new blocks go after when they come first (null = start of the group).
 */
function syncList(
  group: Y.XmlElement,
  oldBlocks: AnyBlock[],
  newBlocks: AnyBlock[],
  newEls: Y.XmlElement[],
  start: Y.XmlElement | null,
  ctx: Ctx,
): void {
  if (newEls.length !== newBlocks.length) structureError()
  const oldEls = oldBlocks.map((b) => {
    const el = typeof b.id === 'string' ? ctx.live.get(b.id) : undefined
    if (!el || el.parent !== group) structureError()
    return el
  })
  const echo = (b: AnyBlock) => ctx.echo?.get(fingerprint(b))
  const oldKeys = oldBlocks.map((b) => echo(b)?.key ?? `\u0000old:${String(b.id)}`)
  const newKeys = newBlocks.map(keyOf)
  const ops = align(oldKeys, newKeys, 2_000, 2_000_000)

  // Within each run of changes pair blocks of the same type (edited in place); the rest is delete/insert.
  const acts: Act[] = []
  let k = 0
  while (k < ops.length) {
    const o = ops[k]
    if (o.t === '=') {
      acts.push({ t: 'keep', i: o.i, j: o.j })
      k++
      continue
    }
    const dels: number[] = []
    const ins: number[] = []
    while (k < ops.length && ops[k].t !== '=') {
      const x = ops[k] as Op
      if (x.t === '-') dels.push(x.i)
      else if (x.t === '+') ins.push(x.j)
      k++
    }
    const oldTypes = dels.map((i) => pairType(echo(oldBlocks[i])?.type ?? oldBlocks[i].type ?? ''))
    const newTypes = ins.map((j) => pairType(newBlocks[j].type ?? ''))
    const run: Act[] = []
    for (const p of align(oldTypes, newTypes, 1_000, 1_000_000)) {
      if (p.t === '=' && oldBlocks[dels[p.i]].type === 'columnList') run.push({ t: 'del', i: dels[p.i] }, { t: 'ins', j: ins[p.j] })
      else if (p.t === '=') run.push({ t: 'edit', i: dels[p.i], j: ins[p.j] })
      else if (p.t === '-') run.push({ t: 'del', i: dels[p.i] })
      else run.push({ t: 'ins', j: ins[p.j] })
    }
    acts.push(...pairRetypes(run, oldBlocks, newBlocks))
  }

  let anchor: Y.XmlElement | null = start
  const inserts: { after: Y.XmlElement | null; js: number[] }[] = []
  const pairs: { i: number; j: number; same: boolean }[] = []
  const deletes: Y.XmlElement[] = []
  let open: { after: Y.XmlElement | null; js: number[] } | null = null
  for (const a of acts) {
    if (a.t === 'ins') {
      if (!open) inserts.push((open = { after: anchor, js: [] }))
      open.js.push(a.j)
      continue
    }
    open = null
    anchor = oldEls[a.i]
    if (a.t === 'del') deletes.push(oldEls[a.i])
    else pairs.push({ i: a.i, j: a.j, same: a.t === 'keep' })
  }
  // 1) inserts (their anchors still exist), 2) in-place edits, 3) deletes
  for (const g of inserts) {
    const clones = g.js.map((j) => newEls[j].clone())
    group.insertAfter(g.after, clones)
    g.js.forEach((j, n) => {
      const id = clones[n].getAttribute('id')
      if (typeof id === 'string') ctx.expect.push({ id, block: newBlocks[j] })
      const cg = childGroup(clones[n])
      if (cg && newBlocks[j].children?.length) expectInserted(cg, newBlocks[j].children!, ctx)
      ctx.stats.inserted += 1 + countBlocks(newBlocks[j].children)
    })
  }
  for (const p of pairs) reconcileBlock(oldEls[p.i], oldBlocks[p.i], newEls[p.j], newBlocks[p.j], p.same, ctx)
  deleteChildren(group, deletes)
  ctx.stats.deleted += deletes.length
}

/**
 * Deletes `els` from `group`: their positions from one pass over the group, then from the last one
 * backwards in runs, so earlier positions stay valid (one `toArray` per call instead of one per
 * deleted block, which made a whole-page rewrite quadratic; docs/adr/2550-*). The same items are
 * deleted as one by one.
 */
function deleteChildren(group: Y.XmlElement, els: Y.XmlElement[]): void {
  if (!els.length) return
  const at = new Map<unknown, number>()
  group.toArray().forEach((el, i) => at.set(el, i))
  const idx = els.map((el) => at.get(el)).filter((i): i is number => i !== undefined)
  idx.sort((x, y) => y - x)
  for (let k = 0; k < idx.length; ) {
    let n = 1
    while (k + n < idx.length && idx[k + n] === idx[k] - n) n++
    group.delete(idx[k] - n + 1, n)
    k += n
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Containers BlockNote builds for `blocks` on a throwaway doc (plus that doc's reading of them). */
function buildIncoming(blocks: AnyBlock[]): { tmp: Y.Doc; els: Y.XmlElement[]; read: AnyBlock[] } {
  const editor = getServerEditor()
  const tmp = editor.blocksToYDoc(blocks as unknown as Parameters<typeof editor.blocksToYDoc>[0], 'document')
  const g = tmp.getXmlFragment('document').get(0)
  if (!isEl(g, 'blockGroup')) {
    tmp.destroy()
    throw badRequest('Could not convert the Markdown')
  }
  // a top-level block is a blockContainer or a group of columns (docs/adr/2420-*)
  const els = g.toArray().filter((c) => isEl(c, 'blockContainer') || isEl(c, 'columnList')) as Y.XmlElement[]
  // The server's own reading of the new blocks (normalized: "\n" → hardBreak → "\n", default props).
  // Read directly: `tmp` is a throwaway BlockNote built with the server schema, so the read has nothing
  // unknown to remove (copying it first doubled the peak memory of a large replace, docs/adr/2550-*).
  const read = editor.yDocToBlocks(tmp, 'document') as unknown as AnyBlock[]
  return { tmp, els, read }
}

function topGroup(doc: Y.Doc): Y.XmlElement {
  const frag = doc.getXmlFragment('document')
  const g = frag.get(0)
  if (frag.length !== 1 || !isEl(g, 'blockGroup')) structureError()
  return g
}

interface Range {
  /** Live index range [from, to) of the top-level group. */
  from: number
  to: number
  /** Visible (server-readable) blocks inside the range. */
  blocks: AnyBlock[]
}

/** Section bounds in the live group by block id (unknown containers in between belong to the range). */
function liveRange(top: Y.XmlElement[], live: Map<string, Y.XmlElement>, blocks: AnyBlock[], blockFrom: number, blockTo: number, liveFrom: number): Range {
  let to = top.length
  if (blockTo < blocks.length) {
    const el = live.get(String(blocks[blockTo].id))
    to = el ? top.indexOf(el) : -1
  }
  if (to < 0 || to < liveFrom) structureError()
  return { from: liveFrom, to, blocks: blocks.slice(blockFrom, blockTo) }
}

function liveIndexOf(top: Y.XmlElement[], live: Map<string, Y.XmlElement>, b: AnyBlock): number {
  const el = live.get(String(b.id))
  const idx = el ? top.indexOf(el) : -1
  if (idx < 0) structureError()
  return idx
}

/** Validates a patched copy (never the live doc): known blocks all survive a BlockNote read; edited/inserted ones read back as asked. */
function validate(doc: Y.Doc, expect: Ctx['expect']): string | null {
  // ids of containers whose content node the server schema knows (and whose ancestors it knows)
  const schema = getServerEditor().editor.pmSchema
  const knownIds: string[] = []
  const walk = (group: Y.XmlElement) => {
    for (const c of group.toArray()) {
      // blocks inside a group of columns must survive too (columnList > column > blockContainer, docs/adr/2420-*)
      if (isEl(c, 'columnList')) {
        for (const col of c.toArray()) if (isEl(col, 'column')) walk(col)
        continue
      }
      if (!isEl(c, 'blockContainer')) continue
      const cn = contentNode(c)
      if (!cn || !schema.nodes[cn.nodeName]) continue
      const id = c.getAttribute('id')
      if (typeof id === 'string') knownIds.push(id)
      const g = childGroup(c)
      if (g) walk(g)
    }
  }
  walk(topGroup(doc))
  // `doc` is the dry run's throwaway copy: read it directly (readBlocks would copy it once more only
  // to protect a live document from the destructive read; docs/adr/2550-*)
  const blocks = getServerEditor().yDocToBlocks(doc, 'document') as unknown as AnyBlock[]
  const byId = new Map<string, AnyBlock>()
  const index = (bs: AnyBlock[]) => {
    for (const b of bs) {
      byId.set(String(b.id), b)
      index(b.children ?? [])
    }
  }
  index(blocks)
  for (const id of knownIds) if (!byId.has(id)) return `block ${id} did not survive the read`
  for (const e of expect) {
    const got = byId.get(e.id)
    if (!got) return `block ${e.id} missing`
    if (!e.block) continue
    const norm = (b: AnyBlock) => blocksToLightMarkdown([{ ...b, type: pairType(b.type ?? ''), children: [] }])
    if (norm(got) !== norm(e.block)) return `block ${e.id} reads back as ${JSON.stringify(norm(got))}, expected ${JSON.stringify(norm(e.block))}`
  }
  return null
}

/**
 * replace on the live range `r` of `group` (docs/adr/0940-*): dry run on a copy of the region,
 * validated, then the same edit on `doc`; the block splice when the merge does not validate.
 */
function replaceRange(
  doc: Y.Doc,
  group: Y.XmlElement,
  r: Range,
  incoming: AnyBlock[],
  echo: EchoIndex | null,
  forced: 'merge' | 'splice' | undefined,
  shared?: EditBudget,
): { stats: PatchStats; firstId: string | null } {
  const { tmp, els, read } = buildIncoming(incoming)
  try {
    if (read.length !== els.length) throw badRequest('Could not convert the Markdown')
    // A small range is edited exactly as before the budget (docs/adr/2550-*): decided once, from the
    // blocks alone, so the dry run and the live edit (and a batch's copy run) agree.
    const small = !budgetOverride && blockChars(r.blocks) + blockChars(read) <= BUDGET_FREE_CHARS
    /**
     * Runs the edit on `target` (one transaction) for the range starting at top-level index `from`;
     * returns its stats, expectations and first new id.
     */
    const editOn = (target: Y.Doc, strategy: 'merge' | 'splice', from: number) => {
      const tGroup = topGroup(target)
      const tTop = tGroup.toArray() as Y.XmlElement[]
      const tLive = new Map<string, Y.XmlElement>()
      indexContainers(tGroup, tLive)
      const start: EditBudget = small ? { ...UNBOUNDED } : shared ? { ...shared } : newReplaceBudget()
      const budget: EditBudget = { ...start }
      const ctx: Ctx = { echo, live: tLive, stats: { strategy, kept: 0, edited: 0, inserted: 0, deleted: 0 }, expect: [], budget, swapped: 0 }
      const startRef = from > 0 ? tTop[from - 1] : null
      target.transact(() => {
        if (strategy === 'merge') {
          syncList(tGroup, r.blocks, read, els, startRef, ctx)
        } else {
          // fallback: the visible blocks of the range are replaced; unknown containers stay
          const olds = r.blocks.map((b) => tLive.get(String(b.id))!)
          const clones = els.map((e) => e.clone())
          tGroup.insertAfter(startRef, clones)
          deleteChildren(tGroup, olds)
          ctx.stats.inserted = countBlocks(read)
          ctx.stats.deleted = countBlocks(r.blocks)
          clones.forEach((c, n) => ctx.expect.push({ id: String(c.getAttribute('id')), block: read[n] }))
        }
      })
      // first new or kept top-level block of the range after the edit
      const firstEl = (tGroup.toArray() as Y.XmlElement[]).find(
        (el) => isEl(el, 'blockContainer') && ctx.expect.some((e) => e.id === el.getAttribute('id')),
      )
      lastWork = { textOps: start.textOps - budget.textOps, diffWork: start.diffWork - budget.diffWork, swapped: ctx.swapped }
      return { stats: ctx.stats, expect: ctx.expect, firstId: firstEl ? String(firstEl.getAttribute('id')) : null, budget }
    }
    /**
     * Dry run on a copy of the edited region (the range plus the container before it, the insert
     * anchor) — the edit only touches the range, so its copy validates it like a copy of the whole
     * document did; null when the result validates, else the problem.
     */
    const lo = Math.max(0, r.from - 1)
    const dryRun = (strategy: 'merge' | 'splice'): string | null => {
      const work = copyTopRange(group, lo, r.to)
      try {
        const res = editOn(work, strategy, r.from - lo)
        return validate(work, res.expect)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      } finally {
        work.destroy()
      }
    }
    let strategy: 'merge' | 'splice' = forced ?? 'merge'
    let problem = dryRun(strategy)
    if (problem && strategy === 'merge') {
      console.warn(`[patch_section] merge validation failed (${problem}); falling back to block replacement`)
      strategy = 'splice'
      problem = dryRun(strategy)
    }
    if (problem) throw badRequest(`Could not apply the patch (${problem}); nothing was changed. Use update_page instead.`)
    // The same deterministic edit on the live document (same content, same structure as the copy),
    // written by the live doc's own client so concurrent client edits merge as usual.
    const res = editOn(doc, strategy, r.from)
    // what is left goes to the next patch of the same run (a small range spends nothing from it)
    if (shared && !small) Object.assign(shared, res.budget)
    return { stats: res.stats, firstId: res.firstId }
  } finally {
    tmp.destroy()
  }
}

/**
 * Applies a section patch to a Y.Doc (normally the live document inside DirectConnection.transact).
 * Synchronous, so the version check and the edit are atomic with respect to other edits in this
 * process. `echo` (buildEchoIndex, computed beforehand) lets untouched blocks be recognized through
 * the lossy Markdown round trip; without it every block of the section is diffed (still minimal).
 */
export function applySectionPatch(
  doc: Y.Doc,
  ref: string,
  incoming: AnyBlock[],
  mode: PatchMode,
  baseVersion: string | undefined,
  echo: EchoIndex | null = null,
  opts: { strategy?: 'merge' | 'splice'; budget?: EditBudget } = {},
): PatchOutcome {
  const blocks = readBlocks(doc)
  const sections = splitSections(blocks)
  const sec = findSection(sections, ref)
  if (!sec) return { status: 'not_found', sections }
  if (baseVersion && baseVersion !== sec.version) return { status: 'conflict', section: sec, blocks }
  if (mode !== 'delete' && incoming.length === 0) throw badRequest('markdown is empty; use mode=delete to remove a section')

  const group = topGroup(doc)
  const top = group.toArray() as Y.XmlElement[]
  const live = new Map<string, Y.XmlElement>()
  indexContainers(group, live)
  const isIntro = sec.level === 0
  const secLive = isIntro ? 0 : liveIndexOf(top, live, blocks[sec.start])
  const bodyLive = isIntro ? 0 : secLive + 1
  const bodyBlock = isIntro ? sec.start : sec.start + 1

  const stats: PatchStats = { strategy: 'insert', kept: 0, edited: 0, inserted: 0, deleted: 0 }
  let firstNewId: string | null = null
  // The region the edit changes: live top-level indices [liveA, liveB) ↔ visible blocks [visA, visB).
  // Everything outside it is untouched, so the result is read back for this region only.
  let liveA = 0
  let liveB = 0
  let visA = 0
  let visB = 0
  const lenBefore = group.length

  if (mode === 'delete') {
    const r = liveRange(top, live, blocks, sec.start, sec.end, secLive)
    ;[liveA, liveB, visA, visB] = [r.from, r.to, sec.start, sec.end]
    doc.transact(() => {
      group.delete(r.from, r.to - r.from)
      if (group.length === 0) {
        const { tmp, els } = buildIncoming([{ type: 'paragraph', content: [] }])
        group.insert(0, els.map((e) => e.clone()))
        tmp.destroy()
      }
    })
    stats.strategy = 'delete'
    stats.deleted = r.to - r.from
  } else if (mode !== 'replace') {
    const { tmp, els } = buildIncoming(incoming)
    const at = mode === 'prepend' ? bodyLive : liveRange(top, live, blocks, sec.start, sec.end, secLive).to
    const visAt = mode === 'prepend' ? bodyBlock : sec.end
    ;[liveA, liveB, visA, visB] = [at, at, visAt, visAt]
    const clones = els.map((e) => e.clone())
    doc.transact(() => group.insert(at, clones))
    firstNewId = (clones[0]?.getAttribute('id') as string | undefined) ?? null
    tmp.destroy()
    stats.inserted = countBlocks(incoming)
  } else {
    // A leading heading in the new Markdown replaces the section heading too.
    const replacesHeading = !isIntro && incoming[0]?.type === 'heading'
    const blockFrom = replacesHeading ? sec.start : bodyBlock
    const r = liveRange(top, live, blocks, blockFrom, sec.end, replacesHeading ? secLive : bodyLive)
    ;[liveA, liveB, visA, visB] = [r.from, r.to, blockFrom, sec.end]
    const res = replaceRange(doc, group, r, incoming, echo, opts.strategy, opts.budget)
    Object.assign(stats, res.stats)
    firstNewId = res.firstId
  }

  // Blocks after the edit: unchanged blocks from the first read, the edited region read back.
  const liveB1 = liveB + (group.length - lenBefore)
  const after = [...blocks.slice(0, visA), ...readTopRange(group, liveA, liveB1), ...blocks.slice(visB)]
  const nextSections = splitSections(after)
  // The patched section after the edit (by heading block id, else the section holding the first new block).
  let next: Section | null = null
  if (mode !== 'delete') {
    const at = firstNewId ? after.findIndex((b) => b.id === firstNewId) : -1
    next =
      (sec.blockId ? nextSections.find((s) => s.blockId === sec.blockId) : undefined) ??
      (at >= 0 ? nextSections.find((s) => s.start <= at && at < s.end) : undefined) ??
      null
  }
  return { status: 'ok', section: next, sections: nextSections, stats }
}

/**
 * update_page(replace) as a minimal edit of the whole document (docs/adr/1500-*): the same block
 * alignment and in-place character edits as patch_section's replace, over every top-level block,
 * so blocks the agent left alone keep their ids, colors, toggles, marks and concurrent typing.
 * Synchronous (call inside DirectConnection.transact). Throws when neither the merge nor the block
 * splice validates; the caller then rewrites the document as before.
 */
export function applyDocumentReplace(doc: Y.Doc, incoming: AnyBlock[], echo: EchoIndex | null): PatchStats {
  const blocks = readBlocks(doc)
  const group = topGroup(doc)
  const next = incoming.length ? incoming : [{ type: 'paragraph', content: [] }]
  return replaceRange(doc, group, { from: 0, to: group.length, blocks }, next, echo, undefined).stats
}
