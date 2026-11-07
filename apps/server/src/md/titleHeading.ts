import type { AnyBlock, Inline } from './convert'

// Imported documents often start with `# <same as the file name>` (Obsidian notes, exported
// Markdown, some Notion pages). The file name already becomes the page title, so that heading
// showed the title twice. Imports drop it; existing pages are never rewritten.

/** Comparison key: Unicode NFC (macOS zip names are NFD), whitespace collapsed, case folded. */
export function titleKey(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function inlineText(content: Inline[]): string {
  let out = ''
  for (const inl of content) {
    if (inl.type === 'text') out += (inl as { text: string }).text
    else if (inl.type === 'link') out += inlineText(((inl as { content?: Inline[] }).content ?? []) as Inline[])
  }
  return out
}

/**
 * Removes the first block when it is a level-1 heading whose text equals `title` (after
 * `titleKey`). A heading with nested children is kept (dropping it would lose them). Returns the
 * same array when nothing is removed. An empty title never matches.
 */
export function dropLeadingTitleHeading(blocks: AnyBlock[], title: string): AnyBlock[] {
  const first = blocks[0]
  if (!first || first.type !== 'heading') return blocks
  if (Number(first.props?.level ?? 1) !== 1) return blocks
  if (first.children && first.children.length > 0) return blocks
  if (!Array.isArray(first.content)) return blocks
  const want = titleKey(title)
  if (!want || titleKey(inlineText(first.content)) !== want) return blocks
  return blocks.slice(1)
}
