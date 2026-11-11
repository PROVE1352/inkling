import { t } from '../i18n'

// Outline / outgoing links / tags for the right panel, read straight from the ProseMirror doc
// with a per-block cache (docs/adr/0705-right-panel-incremental-outline.md).
//
// The panel used to call `editor.document` (a full ProseMirror → BlockNote JSON conversion of
// every block) 300 ms after each change. ProseMirror nodes are immutable and structurally
// shared, so an unchanged top-level block keeps its node identity across edits: summaries are
// cached in a WeakMap keyed by that node and only edited blocks are re-read.
//
// Semantics match the previous editor.document walk: headings come from `heading` blocks
// (id = blockContainer id), text is the concatenated text of inline content (links included,
// other inline nodes such as mentions excluded, tables excluded), outgoing links are `link`
// marks pointing at /w/<ws>/p/<id>, tags are `#tag` tokens preceded by start or whitespace
// (outside code blocks and inline code).

export type Heading = { id: string; level: number; text: string }

export type Outline = { headings: Heading[]; outgoingIds: string[]; tags: string[] }

// Minimal structural view of a ProseMirror node (avoids a direct prosemirror-model dependency).
type PMNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  isText: boolean
  text?: string
  marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[]
  inlineContent: boolean
  childCount: number
  child: (i: number) => PMNode
}

type BlockSummary = { headings: Heading[]; links: string[]; tags: string[] }

const EMPTY: BlockSummary = { headings: [], links: [], tags: [] }
const cache = new WeakMap<PMNode, BlockSummary>()
const PAGE_LINK = /\/w\/[^/]+\/p\/([^/?#]+)/
const TAG = /(^|\s)#([\p{L}\p{N}_\-/]+)/gu

/** Inline text of a content node; `tagText` is the same text with inline `code` runs blanked. */
function readInline(content: PMNode, links: string[]): { text: string; tagText: string } {
  let text = ''
  let tagText = ''
  for (let i = 0; i < content.childCount; i++) {
    const n = content.child(i)
    if (n.isText) {
      text += n.text ?? ''
      tagText += n.marks.some((m) => m.type.name === 'code') ? ' ' : (n.text ?? '')
      for (const m of n.marks) {
        if (m.type.name === 'link' && typeof m.attrs.href === 'string') {
          const hit = PAGE_LINK.exec(m.attrs.href)
          if (hit) links.push(hit[1])
        }
      }
    } else if (n.type.name === 'hardBreak') {
      text += '\n'
      tagText += '\n'
    }
  }
  return { text, tagText }
}

function tagsOf(text: string, out: string[]) {
  TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG.exec(text)) !== null) out.push(m[2])
}

/** Summary of one blockContainer and its nested children (cached by node identity). */
function summarize(container: PMNode): BlockSummary {
  const hit = cache.get(container)
  if (hit) return hit
  let headings: Heading[] = []
  let links: string[] = []
  let tags: string[] = []
  for (let i = 0; i < container.childCount; i++) {
    const child = container.child(i)
    if (child.type.name === 'blockGroup') {
      for (let j = 0; j < child.childCount; j++) {
        const s = summarize(child.child(j))
        if (s === EMPTY) continue
        if (s.headings.length) headings = headings.concat(s.headings)
        if (s.links.length) links = links.concat(s.links)
        if (s.tags.length) tags = tags.concat(s.tags)
      }
    } else if (child.type.name === 'column') {
      // a group of columns (docs/adr/2420-*): its links and tags count, its headings are not part of
      // the outline (a heading inside a column is not a section, docs/adr/2424-*)
      for (let j = 0; j < child.childCount; j++) {
        const s = summarize(child.child(j))
        if (s === EMPTY) continue
        if (s.links.length) links = links.concat(s.links)
        if (s.tags.length) tags = tags.concat(s.tags)
      }
    } else if (child.inlineContent) {
      // the block's own content node (paragraph, heading, list items, code, …) — comes first
      const ownLinks: string[] = []
      const { text, tagText } = readInline(child, ownLinks)
      const ownTags: string[] = []
      // same rule as the server's page_tags (md/tagIndex.ts): nothing inside code is a tag
      if (child.type.name !== 'codeBlock') tagsOf(tagText, ownTags)
      if (child.type.name === 'heading') {
        headings = [
          {
            id: String(container.attrs.id ?? ''),
            level: Number(child.attrs.level ?? 1),
            text: text || t('common.untitled'),
          },
          ...headings,
        ]
      }
      links = ownLinks.concat(links)
      tags = ownTags.concat(tags)
    }
  }
  const out = headings.length || links.length || tags.length ? { headings, links, tags } : EMPTY
  cache.set(container, out)
  return out
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of list) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/** doc → blockGroup → blockContainer* (BlockNote's ProseMirror layout). */
export function computeOutline(doc: PMNode): Outline {
  const headings: Heading[] = []
  const links: string[] = []
  const tags: string[] = []
  for (let g = 0; g < doc.childCount; g++) {
    const group = doc.child(g)
    if (group.type.name !== 'blockGroup') continue
    for (let i = 0; i < group.childCount; i++) {
      const s = summarize(group.child(i))
      if (s === EMPTY) continue
      for (const h of s.headings) headings.push(h)
      for (const l of s.links) links.push(l)
      for (const t of s.tags) tags.push(t)
    }
  }
  return { headings, outgoingIds: dedupe(links), tags: dedupe(tags) }
}
