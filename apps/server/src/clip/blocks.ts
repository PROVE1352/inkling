/**
 * Blocks of a clipped page (docs/adr/2260-*, 2261-*).
 *
 * Everything that came from outside — the title, the selected text, the article — is placed into
 * blocks as literal text. Nothing goes through markdownToBlocks, so `[[Title]]`, `@[x](user:…)` and
 * `<!-- inkling:pageEmbed … -->` in a web page stay text instead of becoming links, mentions or
 * embeds. The article HTML (already allow-listed by extract.ts) goes through BlockNote's own HTML
 * parser, and its blocks are checked once more here: known block types only, http(s)/mailto links,
 * https images.
 */
import { parseHttpUrl } from '@inkling/shared'
import { getServerEditor } from '../md/editor'
import type { AnyBlock, Inline, StyledText } from '../md/convert'
import { mapBlockInlines } from '../md/convert'

/** Most blocks an article contributes (the rest is cut, like the text cap). */
export const CLIP_MAX_BLOCKS = 3000

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'codeBlock'])

const text = (s: string, styles: Record<string, unknown> = {}): StyledText => ({ type: 'text', text: s, styles })

function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  if (/^mailto:/i.test(href)) return href.length <= 2048 ? href : null
  const u = parseHttpUrl(href)
  return u ? u.href : null
}

/** Inline content limited to text and safe links (other inline nodes keep their text, if any). */
function cleanInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const inl of inlines) {
    if (!inl || typeof inl !== 'object') continue
    if (inl.type === 'text' && typeof (inl as StyledText).text === 'string') {
      const t = inl as StyledText
      const styles: Record<string, unknown> = {}
      for (const k of ['bold', 'italic', 'underline', 'strike', 'code']) if (t.styles?.[k] === true) styles[k] = true
      out.push(text(t.text, styles))
    } else if (inl.type === 'link') {
      const content = Array.isArray(inl.content) ? (cleanInlines(inl.content as Inline[]) as StyledText[]) : []
      const href = safeHref(inl.href)
      if (href && content.length) out.push({ type: 'link', href, content })
      else out.push(...content)
    } else if (typeof (inl as { text?: unknown }).text === 'string') {
      out.push(text((inl as { text: string }).text))
    }
  }
  return out
}

function cleanBlocks(blocks: AnyBlock[], budget: { left: number }): AnyBlock[] {
  const out: AnyBlock[] = []
  for (const b of blocks) {
    if (budget.left <= 0) break
    const type = b.type ?? ''
    let block: AnyBlock | null = null
    if (TEXT_BLOCKS.has(type)) {
      const props: Record<string, unknown> = {}
      if (type === 'heading') props.level = Math.min(3, Math.max(1, Number(b.props?.level) || 2))
      if (type === 'codeBlock') props.language = 'text'
      if (type === 'checkListItem') props.checked = b.props?.checked === true
      block = { type, props, content: Array.isArray(b.content) ? b.content : [] }
    } else if (type === 'table' && b.content && !Array.isArray(b.content)) {
      block = { type, props: {}, content: b.content }
    } else if (type === 'image') {
      const url = typeof b.props?.url === 'string' ? b.props.url : ''
      const u = parseHttpUrl(url)
      if (u && u.protocol === 'https:') {
        const caption = typeof b.props?.caption === 'string' ? b.props.caption.slice(0, 500) : ''
        const name = typeof b.props?.name === 'string' ? b.props.name.slice(0, 300) : ''
        block = { type: 'image', props: { url: u.href, caption, name }, children: [] }
      }
    } else if (Array.isArray(b.content) && b.content.length) {
      block = { type: 'paragraph', props: {}, content: b.content }
    }
    if (!block) {
      // Unknown or refused block: its children still count.
      if (Array.isArray(b.children) && b.children.length) out.push(...cleanBlocks(b.children, budget))
      continue
    }
    budget.left--
    if (block.type !== 'image') {
      block.children = Array.isArray(b.children) && b.children.length ? cleanBlocks(b.children, budget) : []
    }
    out.push(block)
  }
  return out
}

/** Article HTML (from extractArticle) → checked blocks; `cut` when the block cap dropped the rest. */
export async function articleBlocks(html: string): Promise<{ blocks: AnyBlock[]; cut: boolean }> {
  const editor = getServerEditor()
  const parsed = (await editor.tryParseHTMLToBlocks(html)) as unknown as AnyBlock[]
  const budget = { left: CLIP_MAX_BLOCKS }
  const blocks = cleanBlocks(parsed, budget)
  mapBlockInlines(blocks, cleanInlines)
  return { blocks, cut: budget.left <= 0 }
}

// ---------------------------------------------------------------------------
// The clip's own blocks (source card, selection, tags, saved line)
// ---------------------------------------------------------------------------

const para = (content: Inline[]): AnyBlock => ({ type: 'paragraph', props: {}, content, children: [] })

/** Selected text as quote blocks: one per paragraph (blank line), line breaks kept inside. */
export function quoteBlocks(selection: string): AnyBlock[] {
  return selection
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
    .map((p) => ({ type: 'quote', props: {}, content: [text(p)], children: [] }))
}

export interface ClipBodyInput {
  url: string | null
  selection: string | null
  tags: string[]
  /** "Saved … from …" line, already localized. */
  savedLine: string
  article: AnyBlock[] | null
  /** Shown after a cut article. */
  truncatedNote: string | null
}

/**
 * The page body: a link card for the source (the editor's link embed in its card form), the selected
 * text as quotes, the tags as `#tag` text (the body is where page tags come from), the saved line,
 * then the article. The source URL and the date are also page properties (routes/clip.ts).
 */
export function clipBodyBlocks(input: ClipBodyInput): AnyBlock[] {
  const blocks: AnyBlock[] = []
  if (input.url) blocks.push({ type: 'linkEmbed', props: { url: input.url, display: 'card' }, children: [] })
  if (input.selection) blocks.push(...quoteBlocks(input.selection))
  if (input.tags.length) blocks.push(para([text(input.tags.map((t) => `#${t}`).join(' '))]))
  const saved: Inline[] = [text(input.savedLine, { italic: true })]
  if (input.url) {
    let host = input.url
    try {
      host = new URL(input.url).host
    } catch {
      /* keep the URL */
    }
    saved.push(text(' '), { type: 'link', href: input.url, content: [text(host, { italic: true })] })
  }
  blocks.push(para(saved))
  if (input.article?.length) {
    blocks.push(...input.article)
    if (input.truncatedNote) blocks.push(para([text(input.truncatedNote, { italic: true })]))
  }
  return blocks
}

/** The URL a clip stores and looks up: WHATWG-normalized http(s), or null. */
export function clipSourceUrl(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null
  return parseHttpUrl(raw.trim())?.href ?? null
}

/** The date the "Clipped" property gets: the saver's local date when it is within a day of the server's. */
export function clipDate(localDate: string | undefined, now = new Date()): string {
  const utc = now.toISOString().slice(0, 10)
  if (!localDate) return utc
  const t = Date.parse(`${localDate}T00:00:00Z`)
  if (!Number.isFinite(t)) return utc
  return Math.abs(t - Date.parse(`${utc}T00:00:00Z`)) <= 86_400_000 ? localDate : utc
}
