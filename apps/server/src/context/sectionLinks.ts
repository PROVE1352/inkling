import type { SectionRef } from '@inkling/shared/sectionLink'
import { findSection } from './chunker'
import type { Section } from './chunker'
import { resolveMovedSection } from './sectionMoves'
import { readOutline } from './sectionSource'

/**
 * Which heading of the target page a section link `[[Page#Heading]]` means now (docs/adr/2102-*).
 *
 * 1. The heading block id stored in the link (links made in the editor): survives renames of the
 *    heading and moves inside the page. The heading must still head a section of the page.
 * 2. The heading text, with the rules of read_page(section=…) (findSection: anchor, heading path,
 *    heading text, slug; case-insensitive) — links that came from Markdown, MCP or an import, and
 *    links whose heading block was replaced (update_page replace, vault upload).
 * 3. The change log (docs/adr/1501-*): a heading renamed after the link was written — through
 *    the same replay the agent tools use (traceAnchor), bounded by the change feed's retention.
 *
 * `renamed`: found, under another heading text than the link has (the link follows it); `missing`:
 * the page opens at the top and says the heading was not found. Sections are top-level headings
 * (ADR 0926), so a heading inside a toggle or a column is not a link target.
 */

export type SectionLinkStatus = 'found' | 'renamed' | 'missing'

export interface ResolvedSectionLink {
  status: SectionLinkStatus
  /** The heading text now (found, renamed) or the link's (missing). */
  heading: string
  blockId: string | null
  anchor: string | null
}

type LinkSection = Pick<Section, 'anchor' | 'blockId' | 'headingPath'>

const headingOf = (s: LinkSection) => s.headingPath[s.headingPath.length - 1] ?? ''
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function answer(ref: SectionRef, s: LinkSection): ResolvedSectionLink {
  const heading = headingOf(s)
  return { status: sameName(heading, ref.heading) ? 'found' : 'renamed', heading, blockId: s.blockId, anchor: s.anchor }
}

/** Steps 1–2 (no database): the section, or null when only the change log could still tell. */
export function matchSectionLink<T extends LinkSection>(sections: T[], ref: SectionRef): ResolvedSectionLink | null {
  if (ref.blockId) {
    const byId = sections.find((s) => s.blockId === ref.blockId)
    if (byId) return answer(ref, byId)
  }
  // only the heading text: a block id is never matched by name here
  const byName = findSection(sections, ref.heading)
  return byName ? answer(ref, byName) : null
}

/** All three steps over the page's current sections (readOutline / page_chunks). */
export async function resolveSectionLink<T extends LinkSection>(pageId: string, sections: T[], ref: SectionRef): Promise<ResolvedSectionLink> {
  const direct = matchSectionLink(sections, ref)
  if (direct) return direct
  const moved = await resolveMovedSection(
    pageId,
    ref.heading,
    sections.map((s) => s.anchor),
  ).catch(() => ({ status: 'none' as const }))
  if (moved.status === 'moved') {
    const s = sections.find((x) => x.anchor === moved.anchor)
    if (s) return { ...answer(ref, s), status: 'renamed' }
  }
  return { status: 'missing', heading: ref.heading, blockId: null, anchor: null }
}

export interface BacklinkSection {
  /** The heading as it is called now (found, renamed), or as the link names it (missing). */
  heading: string
  status: SectionLinkStatus
}

/**
 * The backlinks panel's "which heading" (docs/adr/2101-*): per source page, the headings of the
 * target that its section links name, resolved against the target's sections now. Null when no
 * source has section links (the response then has no `sections` field, as before 0.17).
 */
export async function backlinkSections(
  pageId: string,
  kind: string,
  rows: { id: string; linkSections: { h: string; b?: string }[] | null }[],
): Promise<Record<string, BacklinkSection[]> | null> {
  const withRefs = rows.filter((r) => r.linkSections?.length)
  if (!withRefs.length) return null
  const sections = kind === 'doc' ? await readOutline(pageId) : []
  const memo = new Map<string, Promise<ResolvedSectionLink>>()
  const out: Record<string, BacklinkSection[]> = {}
  for (const r of withRefs) {
    const list: BacklinkSection[] = []
    for (const ref of r.linkSections!) {
      const key = `${ref.b ?? ''}\u0000${ref.h}`
      let p = memo.get(key)
      if (!p) {
        p = resolveSectionLink(pageId, sections, { heading: ref.h, ...(ref.b ? { blockId: ref.b } : {}) })
        memo.set(key, p)
      }
      const res = await p
      if (!list.some((x) => x.heading === res.heading && x.status === res.status)) list.push({ heading: res.heading, status: res.status })
    }
    out[r.id] = list
  }
  return out
}
