import * as Y from 'yjs'
import { slugify } from '../context/chunker'
import { copyTopRange } from '../context/sectionPatch'
import { getServerEditor } from './editor'

/**
 * Splitting a document at its headings (docs/adr/1140-*), on the Yjs tree only.
 *
 * Nothing here reads the document through BlockNote: a BlockNote read of the live document deletes
 * the nodes the server schema does not know (mention chips) and would broadcast that. Sections are
 * found from the top-level containers and their first child (`heading`, attribute `level`), the same
 * top-level rule as `splitSections` (context/chunker.ts), so the plan matches the outline. A section
 * moves as clones of its containers: block ids, nested children, marks and unknown nodes come along
 * byte for byte.
 */

export interface PlannedSection {
  /** Id of the heading block (attribute `id` of its container). */
  blockId: string
  /** Anchor of the section before the split, computed like splitSections. */
  anchor: string
  title: string
  /** Top-level range [start, end) in the document's blockGroup. */
  start: number
  end: number
  /** The section's top-level containers (identity is checked again before they are removed). */
  containers: Y.XmlElement[]
  /** Every block id inside the section, nested ones included (comments move by these). */
  blockIds: string[]
}

export interface SplitPlan {
  group: Y.XmlElement
  /** Number of top-level headings per level 1–6 (index 0 = level 1). */
  levels: number[]
  sections: PlannedSection[]
  /** Top-level blocks of the document. */
  total: number
}

export class SplitError extends Error {}

function isBlockGroup(x: unknown): x is Y.XmlElement {
  return x instanceof Y.XmlElement && x.nodeName === 'blockGroup'
}

/** Heading level and plain text of a top-level container, or null when it is not a heading. */
export function headingOf(container: unknown): { level: number; title: string } | null {
  if (!(container instanceof Y.XmlElement) || container.nodeName !== 'blockContainer') return null
  const content = container.get(0)
  if (!(content instanceof Y.XmlElement) || content.nodeName !== 'heading') return null
  const level = Math.min(6, Math.max(1, Number(content.getAttribute('level')) || 1))
  let title = ''
  for (const child of content.toArray()) {
    if (!(child instanceof Y.XmlText)) continue
    for (const op of child.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') title += op.insert
  }
  return { level, title: title.replace(/\s+/g, ' ').trim() }
}

function collectIds(el: Y.XmlElement, out: string[]): void {
  if (el.nodeName === 'blockContainer') {
    const id = el.getAttribute('id')
    if (typeof id === 'string' && id) out.push(id)
  }
  for (const child of el.toArray()) if (child instanceof Y.XmlElement) collectIds(child, out)
}

/** The document's single top-level blockGroup (BlockNote's layout), or a SplitError. */
export function topGroup(doc: Y.Doc): Y.XmlElement {
  const frag = doc.getXmlFragment('document')
  const group = frag.get(0)
  if (frag.length !== 1 || !isBlockGroup(group)) throw new SplitError('Unexpected document structure; nothing was split')
  return group
}

/**
 * Sections that start at a top-level heading of `level` and run to the next top-level heading of
 * that level or a higher one. Blocks before the first such heading and headings of a higher level
 * (with what follows them up to the next `level` heading) stay on the page.
 */
export function planSplit(doc: Y.Doc, level: number): SplitPlan {
  const frag = doc.getXmlFragment('document')
  if (frag.length === 0) return { group: null as unknown as Y.XmlElement, levels: [0, 0, 0, 0, 0, 0], sections: [], total: 0 }
  const group = topGroup(doc)
  const items = group.toArray()
  const levels = [0, 0, 0, 0, 0, 0]
  const sections: PlannedSection[] = []
  // Anchor stack exactly like splitSections: slug path of the enclosing headings, ~n for repeats.
  const stack: { level: number; slug: string }[] = []
  const seen = new Map<string, number>()
  let open: PlannedSection | null = null
  const close = (end: number) => {
    if (!open) return
    open.end = end
    open.containers = items.slice(open.start, end) as Y.XmlElement[]
    for (const c of open.containers) collectIds(c, open.blockIds)
    sections.push(open)
    open = null
  }
  for (let i = 0; i < items.length; i++) {
    const h = headingOf(items[i])
    if (!h) continue
    levels[h.level - 1]++
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    stack.push({ level: h.level, slug: slugify(h.title) })
    const base = stack.map((s) => s.slug).join('/')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    if (h.level > level) continue
    close(i)
    if (h.level < level) continue
    const id = (items[i] as Y.XmlElement).getAttribute('id')
    if (typeof id !== 'string' || !id) continue // a heading without an id cannot be addressed; it stays
    open = { blockId: id, anchor: n === 1 ? base : `${base}~${n}`, title: h.title, start: i, end: i + 1, containers: [], blockIds: [] }
  }
  close(items.length)
  return { group, levels, sections, total: items.length }
}

/** A new document holding clones of the section's containers (ids kept), as a V2 state and its state vector. */
export function sectionDoc(plan: SplitPlan, s: PlannedSection): { state: Uint8Array; stateVector: Uint8Array } {
  const doc = copyTopRange(plan.group, s.start, s.end)
  try {
    return { state: Y.encodeStateAsUpdateV2(doc), stateVector: Y.encodeStateVector(doc) }
  } finally {
    doc.destroy()
  }
}

/**
 * One bullet container per subpage, each holding an internal link (`/w/<ws>/p/<id>`, the form the
 * backlink index reads). Built by BlockNote on a throwaway doc and cloned, never assembled by hand.
 */
export function linkContainers(workspaceId: string, links: { pageId: string; title: string }[]): Y.XmlElement[] {
  const editor = getServerEditor()
  const blocks = links.map((l) => ({
    type: 'bulletListItem',
    content: [{ type: 'link', href: `/w/${workspaceId}/p/${l.pageId}`, content: [{ type: 'text', text: l.title, styles: {} }] }],
  }))
  const tmp = editor.blocksToYDoc(blocks as unknown as Parameters<typeof editor.blocksToYDoc>[0], 'document')
  try {
    const group = topGroup(tmp)
    const els = group.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === 'blockContainer')
    if (els.length !== links.length) throw new SplitError('Could not build the subpage links')
    return els.map((c) => c.clone())
  } finally {
    tmp.destroy()
  }
}

/**
 * Watches the sections between planning and removal: any change inside a planned container marks
 * the plan stale. Changes elsewhere in the document (people typing in other sections) do not.
 */
export function watchSections(plan: SplitPlan, sections: PlannedSection[]): { stale: () => boolean; stop: () => void } {
  const moved = new Set<Y.AbstractType<unknown>>()
  for (const s of sections) for (const c of s.containers) moved.add(c as unknown as Y.AbstractType<unknown>)
  let dirty = false
  const fn = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    if (dirty) return
    for (const e of events) {
      let t: Y.AbstractType<unknown> | null = e.target
      while (t && t.parent && t.parent !== (plan.group as unknown as Y.AbstractType<unknown>)) t = t.parent as Y.AbstractType<unknown>
      if (t && moved.has(t)) {
        dirty = true
        return
      }
    }
  }
  plan.group.observeDeep(fn)
  return { stale: () => dirty, stop: () => plan.group.unobserveDeep(fn) }
}

/**
 * Removes the sections from the live document and puts the link to its subpage where each one was,
 * in one Yjs transaction (one update for every open client). Must run synchronously inside
 * DirectConnection.transact. Throws SplitError, without touching the document, when the sections are
 * no longer where the plan found them (a container deleted, moved, or a block inserted into a range).
 */
export function replaceSections(doc: Y.Doc, plan: SplitPlan, sections: PlannedSection[], links: Y.XmlElement[], level: number): void {
  const now = planSplit(doc, level)
  if (now.group !== plan.group) throw new SplitError('The page changed while it was being split; try again')
  const byId = new Map(now.sections.map((s) => [s.blockId, s]))
  for (const s of sections) {
    const cur = byId.get(s.blockId)
    if (!cur || cur.containers.length !== s.containers.length || cur.containers.some((c, i) => c !== s.containers[i])) {
      throw new SplitError('The page changed while it was being split; try again')
    }
    s.start = cur.start
    s.end = cur.end
  }
  const order = sections.map((s, i) => ({ s, link: links[i] })).sort((a, b) => b.s.start - a.s.start)
  doc.transact(() => {
    for (const { s, link } of order) {
      plan.group.delete(s.start, s.end - s.start)
      plan.group.insert(s.start, [link])
    }
  })
}
