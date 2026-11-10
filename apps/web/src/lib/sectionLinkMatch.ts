import type { SectionRef } from '@inkling/shared/sectionLink'

// Which heading block of a loaded document a section link means (docs/adr/2102-*). Pure, for tests.

export type BlockLike = { id: string; type: string; content?: unknown; children?: BlockLike[] }

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c: { type?: string; text?: string; content?: unknown }) =>
      c?.type === 'text' ? (c.text ?? '') : c?.type === 'link' ? inlineText(c.content) : '',
    )
    .join('')
}

/** Lower case, letters and digits joined by `-`: the server's anchor slug (context/chunker.ts slugify). */
export function headingSlug(s: string): string {
  return (
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'section'
  )
}

/**
 * The heading block a section link means in a loaded document: its block id (still a heading), else
 * the first heading with the same text (case-insensitive), else the same slug. Headings anywhere in
 * the document count here (also inside toggles); the server only knows top-level ones.
 */
export function findHeadingBlock(doc: BlockLike[], ref: SectionRef): string | null {
  const headings: BlockLike[] = []
  const walk = (list: BlockLike[]) => {
    for (const b of list) {
      if (b.type === 'heading') headings.push(b)
      if (Array.isArray(b.children)) walk(b.children)
    }
  }
  walk(doc)
  if (ref.blockId) {
    const byId = headings.find((b) => b.id === ref.blockId)
    if (byId) return byId.id
  }
  const want = ref.heading.trim().toLowerCase()
  const byText = headings.find((b) => inlineText(b.content).trim().toLowerCase() === want)
  if (byText) return byText.id
  const slug = headingSlug(ref.heading)
  return headings.find((b) => headingSlug(inlineText(b.content)) === slug)?.id ?? null
}
