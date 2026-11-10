// Section links `[[Page#Heading]]` (docs/adr/2100-*).
//
// A section link is the same BlockNote `link` inline as a page link (href `/w/<ws>/p/<page>`) with a
// fragment that names the heading:
//
//   /w/<ws>/p/<page>#h=<heading>&b=<heading block id>&p=<page title>
//
//   h  the heading text when the link was made (always): Markdown export writes it, and it is the
//      name the link falls back to when the block id is gone (replace, import, vault upload)
//   b  the heading's block id (only when known: links made in the editor). It survives renames and
//      moves of the heading inside its page, so the link follows them
//   p  the page title when the link was made: `[[p#h|shown]]` can be written back without a title
//      lookup (the link's text is the alias then)
//
// The link's text is what the page shows: `Page#Heading` for a link without an alias, the alias
// otherwise. Everything that only knows page links (backlinks, graph, previews) keeps working: the
// path is unchanged and a fragment is ignored by them.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
/** `/w/<ws>/p/<page>` with an optional `#fragment`; captures workspace, page, fragment. */
export const INTERNAL_LINK_RE = new RegExp(`^/w/(${UUID})/p/(${UUID})(?:#(.*))?$`)

export interface SectionRef {
  /** Heading text when the link was made. */
  heading: string
  /** Heading block id, when known. */
  blockId?: string
  /** Page title when the link was made. */
  page?: string
}

export interface InternalLink {
  workspaceId: string
  pageId: string
  /** null: a plain page link (or a fragment that names no heading) */
  section: SectionRef | null
}

const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/** The section a fragment names (`#h=…&b=…&p=…`, with or without the `#`); null when it names none. */
export function parseSectionFragment(fragment: string | null | undefined): SectionRef | null {
  if (!fragment) return null
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment
  let heading: string | null = null
  let blockId: string | undefined
  let page: string | undefined
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    const value = decode(part.slice(eq + 1))
    if (value === null) continue
    if (key === 'h') heading = value
    else if (key === 'b' && BLOCK_ID_RE.test(value)) blockId = value
    else if (key === 'p') page = value
  }
  const h = heading?.trim()
  if (!h) return null
  return { heading: h, ...(blockId ? { blockId } : {}), ...(page !== undefined && page.trim() ? { page: page.trim() } : {}) }
}

/** `h=…&b=…&p=…` (no `#`), fields in this fixed order so the same link always gives the same href. */
export function sectionFragment(ref: SectionRef): string {
  const parts = [`h=${encodeURIComponent(ref.heading)}`]
  if (ref.blockId && BLOCK_ID_RE.test(ref.blockId)) parts.push(`b=${ref.blockId}`)
  if (ref.page) parts.push(`p=${encodeURIComponent(ref.page)}`)
  return parts.join('&')
}

/** href of a link to page `pageId`, to its section `ref` when given. */
export function internalHref(workspaceId: string, pageId: string, ref?: SectionRef | null): string {
  const base = `/w/${workspaceId}/p/${pageId}`
  return ref ? `${base}#${sectionFragment(ref)}` : base
}

/** Parse an internal link href (page or section link); null for anything else. */
export function parseInternalHref(href: unknown): InternalLink | null {
  if (typeof href !== 'string') return null
  const m = INTERNAL_LINK_RE.exec(href)
  if (!m) return null
  return { workspaceId: m[1], pageId: m[2], section: parseSectionFragment(m[3]) }
}

/** The wikilink target a section link stands for: `Page#Heading`. */
export function sectionTarget(ref: SectionRef, fallbackPage: string): string {
  return `${ref.page ?? fallbackPage}#${ref.heading}`
}

/**
 * Markdown of a section link: `[[Page#Heading]]` when the shown text is that target, else
 * `[[Page#Heading|shown]]`. `title` (the page's current title) wins over the one stored in the link
 * when the caller knows it (vault sync); without either, the shown text before its `#` is used.
 */
export function sectionLinkMarkdown(ref: SectionRef, shown: string, title?: string | null): string {
  const stored = ref.page ?? (shown.includes('#') ? shown.slice(0, shown.lastIndexOf('#')) : shown)
  const target = `${title || stored}#${ref.heading}`
  const unaliased = !shown || shown === `${stored}#${ref.heading}` || shown === target
  return unaliased ? `[[${target}]]` : `[[${target}|${shown}]]`
}

export interface WikiSectionTarget {
  page: string
  heading: string
  /** `[[Page#Heading|alias]]`: the text after the first `|` */
  alias: string | null
}

/**
 * The page/heading splits of a wikilink's inner text that has a `#`, left to right (a title may itself
 * contain `#`, as in "C# notes#Setup"). `|alias` is cut off first. Empty page or heading parts are skipped.
 */
export function wikiSectionCandidates(inner: string): WikiSectionTarget[] {
  const bar = inner.indexOf('|')
  const target = bar >= 0 ? inner.slice(0, bar) : inner
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() || null : null
  const out: WikiSectionTarget[] = []
  for (let i = target.indexOf('#'); i >= 0; i = target.indexOf('#', i + 1)) {
    const page = target.slice(0, i).trim()
    const heading = target.slice(i + 1).trim()
    if (page && heading) out.push({ page, heading, alias })
  }
  return out
}
