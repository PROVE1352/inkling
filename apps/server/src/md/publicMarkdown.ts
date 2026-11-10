/**
 * The Markdown download of a public page (docs/adr/2362-*).
 *
 * Input: the blocks routes/public.ts renders the page's HTML from, after every public rule ran
 * (publicCustomBlocks for embeds, database views, query blocks and charts; internal links made
 * public paths or text; attachment URLs made public file paths). On top of that this runs the
 * HTML's own last filter (convert.ts publicBlocks: no page/link embeds, plugin blocks or chart
 * configs, mentions as `@label`), so the file can never hold data the page does not show, and writes
 * people's Markdown (`plain` notation: no `<!-- inkling:… -->` tokens, no ids, no frontmatter).
 *
 * Differences from the page, all of them removals or address forms:
 *   - button blocks are left out (inert on a public page; the label only means something in the app)
 *   - links and attachments inside the link get the site's absolute address, so the file works
 *     outside the browser that downloaded it
 *   - the title is the first line, as a heading
 */
import { blocksToMarkdown, mapBlockInlines, publicBlocks, visitAssetBlocks } from './convert'
import type { AnyBlock, Inline, LinkInline } from './convert'
import { sanitizeName } from './mime'

export interface PublicMarkdownFile {
  filename: string
  body: string
}

function withoutButtons(blocks: AnyBlock[]): AnyBlock[] {
  const out: AnyBlock[] = []
  for (const b of blocks) {
    const children = withoutButtons(b.children ?? [])
    if (b.type === 'button') out.push(...children)
    else out.push({ ...b, children })
  }
  return out
}

/** `/s/…` and `/api/public/…` paths → `<origin>/…`; anything else is left as it is. */
function absolute(origin: string, url: string): string {
  return origin && url.startsWith('/') && !url.startsWith('//') ? `${origin}${url}` : url
}

/** Title as a Markdown heading line: one line, Markdown punctuation escaped. */
function headingLine(title: string): string {
  const text = (title || 'Untitled').replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>|~#]/g, '\\$&').trim()
  return `# ${text || 'Untitled'}\n\n`
}

export async function publicMarkdownFile(title: string, blocks: AnyBlock[], origin: string): Promise<PublicMarkdownFile> {
  const base = origin.replace(/\/+$/, '')
  const copy = withoutButtons(publicBlocks(structuredClone(blocks)))
  mapBlockInlines(copy, (inlines) =>
    inlines.map((inl): Inline => {
      if (inl.type !== 'link' || typeof (inl as LinkInline).href !== 'string') return inl
      const link = inl as LinkInline
      return { ...link, href: absolute(base, link.href) }
    }),
  )
  visitAssetBlocks(copy, (b) => {
    if (typeof b.props?.url === 'string') b.props.url = absolute(base, b.props.url)
  })
  const { markdown } = await blocksToMarkdown(copy, { assetMode: 'absolute', notation: 'plain' })
  return { filename: `${sanitizeName(title)}.md`, body: headingLine(title) + markdown }
}
