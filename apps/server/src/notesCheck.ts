import { and, eq, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from './db/index'
import { pageChunks, pageLinks, pageTexts, pages } from './db/schema'
import { buildTitleResolver } from './md/importer'
import { resolveSectionLink } from './context/sectionLinks'
import { readOutline } from './context/sectionSource'
import { visibleTo } from './pageDto'
import { localISODate } from './review'
import { listVerified } from './verification'

/**
 * Memory check of a workspace or one subtree (docs/adr/2003-*): the material an agent needs to tidy a
 * team's notes, in one read. Nothing is written and nothing is judged; the caller decides.
 *
 * Every page this reads is a page the viewer can see right now (visibleTo: shared pages, the
 * viewer's own private pages, the connection range of the request), live, in a live workspace the
 * route already checked membership, agent blocks and the two-step requirement for. Whether a link
 * is broken, whether two titles collide and whether a page has links are decided over that visible
 * set only: a [[Title]] that names someone else's private page is "missing" for this viewer, the
 * same answer as for a title nobody used, so the report is never an oracle for hidden titles; a link
 * to a hidden page is not an edge (as in linkIslands.ts, docs/adr/1123-*).
 *
 * Kinds:
 * - broken: `[[X]]` left as text (page_texts keeps a resolved link as its bare label, so a literal
 *   `[[…]]` there never resolved; X is looked up with the write path's resolver: titles, aliases,
 *   former titles, `Page#Heading`) — `missing`, or `exists` when a visible page has that name now
 *   (writing the line again links it); and links (page_links) whose target is now in the trash.
 *   Limits: page_texts keeps the head and tail of a body over 200 KB, and code blocks count.
 *   Section links `[[Page#Heading]]` to a visible page whose heading is not there any more (by block
 *   id, name or the change log's rename trace, docs/adr/2102-*) are `noHeading` (docs/adr/2103-*).
 * - duplicates: pages whose titles are equal after Unicode normalisation, case, punctuation,
 *   spacing and word order are ignored.
 * - unlinked: no link in or out among visible pages (folders and collection rows excluded).
 * - verification: lapsed verifications, and verified pages that changed much since (0.15).
 * - quietLarge: documents of at least LARGE_TOKENS indexed tokens not changed for QUIET_DAYS.
 *
 * Ordering is fixed (ties by id) and dates are server-local days, so the same notes give the same
 * answer on the same day (docs/adr/0937-*).
 */

export const NOTES_CHECK_LARGE_TOKENS = 3_000
export const NOTES_CHECK_QUIET_DAYS = 180
export const NOTES_CHECK_DEFAULT_LIMIT = 10
export const NOTES_CHECK_MAX_LIMIT = 50
/** Most broken links listed per page (the page's count is always given). */
const LINKS_PER_PAGE = 5
const DAY_MS = 86_400_000
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g

export interface BrokenLink {
  text: string
  state: 'missing' | 'exists' | 'trashed' | 'noHeading'
  /** exists: the page the text names now; trashed: the trashed target; noHeading: the page that lacks the heading. */
  targetId?: string
  trashedOn?: string
}

export interface NotesCheckDTO {
  workspaceId: string
  rootId: string | null
  /** Pages in scope (collection rows not counted). */
  checked: number
  broken: { total: number; pages: number; items: { pageId: string; title: string; count: number; links: BrokenLink[] }[] }
  duplicates: { total: number; items: { title: string; pageIds: string[] }[] }
  unlinked: { total: number; items: { pageId: string; title: string; updatedOn: string }[] }
  verification: {
    total: number
    items: { pageId: string; title: string; state: 'lapsed' | 'changed'; until: string; changedSections: number }[]
  }
  quietLarge: {
    total: number
    minTokens: number
    /** Server-local date: not changed since before this day. */
    before: string
    items: { pageId: string; title: string; tokens: number; updatedOn: string }[]
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Title key for duplicate detection: NFKC, lower case, letters and digits only, words sorted. */
export function duplicateKey(title: string): string {
  const words = title
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (!words.length) return ''
  const key = words.sort().join(' ')
  return key === 'untitled' ? '' : key
}

/** Unique `[[…]]` texts of a plain body, in order of first appearance (case-insensitive). */
export function literalWikiLinks(body: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const t = m[1].trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

interface Node {
  id: string
  title: string
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  parentId: string | null
  updatedAt: Date
  row: boolean
}

/**
 * Run the check for `userId` in `workspaceId` (membership already checked by the caller, inside the
 * request's range scope). `rootId` limits it to that page and its descendants (null = the workspace).
 */
export async function notesCheck(
  workspaceId: string,
  userId: string,
  rootId: string | null,
  opts: { limit?: number; now?: number } = {},
): Promise<NotesCheckDTO> {
  const limit = Math.min(NOTES_CHECK_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? NOTES_CHECK_DEFAULT_LIMIT)))
  const now = opts.now ?? Date.now()
  const parent = alias(pages, 'parent')
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      kind: pages.kind,
      parentId: pages.parentId,
      updatedAt: pages.updatedAt,
      parentKind: parent.kind,
    })
    .from(pages)
    .leftJoin(parent, eq(pages.parentId, parent.id))
    .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
  const visible = new Map<string, Node>()
  for (const r of rows) visible.set(r.id, { id: r.id, title: r.title, kind: r.kind, parentId: r.parentId, updatedAt: r.updatedAt, row: r.parentKind === 'collection' })

  // scope: the root and its visible descendants (a hidden page cuts its subtree, as in the tree view)
  let scope: Set<string>
  if (rootId) {
    const children = new Map<string, string[]>()
    for (const n of visible.values()) {
      if (!n.parentId) continue
      const list = children.get(n.parentId) ?? []
      list.push(n.id)
      children.set(n.parentId, list)
    }
    scope = new Set()
    const stack = visible.has(rootId) ? [rootId] : []
    while (stack.length && scope.size < visible.size) {
      const id = stack.pop()!
      if (scope.has(id)) continue
      scope.add(id)
      for (const c of children.get(id) ?? []) stack.push(c)
    }
  } else {
    scope = new Set(visible.keys())
  }
  const inScope = [...scope].map((id) => visible.get(id)!)
  const pagesInScope = inScope.filter((n) => !n.row)
  const titleOf = (id: string) => visible.get(id)?.title || 'Untitled'

  // --- broken links -------------------------------------------------------------------------
  const brokenBy = new Map<string, BrokenLink[]>()
  const texts = scope.size
    ? await db
        .select({ pageId: pageTexts.pageId, text: pageTexts.text })
        .from(pageTexts)
        .innerJoin(pages, eq(pages.id, pageTexts.pageId))
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId), like(pageTexts.text, '%[[%]]%')))
    : []
  const withLiteral = texts.filter((t) => scope.has(t.pageId))
  if (withLiteral.length) {
    // the write path's resolver over the pages this viewer can see (docs/adr/0756-*)
    const resolve = await buildTitleResolver(workspaceId, new Map(), userId)
    for (const t of withLiteral) {
      for (const label of literalWikiLinks(t.text)) {
        const url = resolve(label)
        const target = url ? url.slice(url.lastIndexOf('/') + 1) : null
        const list = brokenBy.get(t.pageId) ?? []
        list.push(target && visible.has(target) ? { text: label, state: 'exists', targetId: target } : { text: label, state: 'missing' })
        brokenBy.set(t.pageId, list)
      }
    }
  }
  const linkRows = visible.size
    ? await db
        .select({ s: pageLinks.sourcePageId, t: pageLinks.targetPageId, sections: pageLinks.sections })
        .from(pageLinks)
        .innerJoin(pages, eq(pages.id, pageLinks.sourcePageId))
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
    : []
  // links whose target is in the trash, from pages in scope; the target counts only when visible
  const deadTargets = [...new Set(linkRows.filter((l) => scope.has(l.s) && visible.has(l.s) && !visible.has(l.t)).map((l) => l.t))]
  if (deadTargets.length) {
    const trashed = new Map(
      (
        await db
          .select({ id: pages.id, title: pages.title, deletedAt: pages.deletedAt })
          .from(pages)
          .where(and(inArray(pages.id, deadTargets), eq(pages.workspaceId, workspaceId), isNotNull(pages.deletedAt), visibleTo(userId)))
      ).map((r) => [r.id, r]),
    )
    for (const l of linkRows) {
      const t = trashed.get(l.t)
      if (!t || !scope.has(l.s)) continue
      const list = brokenBy.get(l.s) ?? []
      list.push({ text: t.title || 'Untitled', state: 'trashed', targetId: t.id, trashedOn: localISODate(t.deletedAt!) })
      brokenBy.set(l.s, list)
    }
  }
  // section links whose heading is gone, from pages in scope to pages this viewer can see
  const sectionLinks = linkRows
    .filter((l) => l.sections?.length && scope.has(l.s) && visible.has(l.s) && visible.has(l.t))
    .sort((a, b) => cmp(a.s, b.s) || cmp(a.t, b.t))
  if (sectionLinks.length) {
    const outlines = new Map<string, Awaited<ReturnType<typeof readOutline>>>()
    for (const l of sectionLinks) {
      if (visible.get(l.t)!.kind !== 'doc') continue
      let sections = outlines.get(l.t)
      if (!sections) {
        sections = await readOutline(l.t)
        outlines.set(l.t, sections)
      }
      for (const ref of l.sections!) {
        const res = await resolveSectionLink(l.t, sections, { heading: ref.h, ...(ref.b ? { blockId: ref.b } : {}) })
        if (res.status !== 'missing') continue
        const list = brokenBy.get(l.s) ?? []
        list.push({ text: `${titleOf(l.t)}#${ref.h}`, state: 'noHeading', targetId: l.t })
        brokenBy.set(l.s, list)
      }
    }
  }
  const brokenItems = [...brokenBy.entries()]
    .map(([pageId, links]) => ({
      pageId,
      title: titleOf(pageId),
      count: links.length,
      // literal links in body order, then trashed targets by id
      links: [...links.filter((l) => l.state !== 'trashed'), ...links.filter((l) => l.state === 'trashed').sort((a, b) => cmp(a.targetId!, b.targetId!))].slice(0, LINKS_PER_PAGE),
    }))
    .sort((a, b) => b.count - a.count || cmp(a.pageId, b.pageId))

  // --- duplicates ---------------------------------------------------------------------------
  const groups = new Map<string, string[]>()
  for (const n of pagesInScope) {
    const key = duplicateKey(n.title)
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(n.id)
    groups.set(key, list)
  }
  const dupItems = [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids: ids.sort(cmp) }))
    .sort((a, b) => b.ids.length - a.ids.length || cmp(a.key, b.key))
    .map((g) => ({ title: titleOf(g.ids[0]), pageIds: g.ids }))

  // --- unlinked -----------------------------------------------------------------------------
  const linked = new Set<string>()
  for (const l of linkRows) {
    const s = visible.get(l.s)
    const t = visible.get(l.t)
    if (!s || !t || s.row || t.row || l.s === l.t) continue
    linked.add(l.s)
    linked.add(l.t)
  }
  const unlinkedAll = pagesInScope
    .filter((n) => n.kind !== 'folder' && !linked.has(n.id))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || cmp(a.id, b.id))

  // --- verification (0.15) -------------------------------------------------------------------
  const verified = await listVerified(workspaceId, userId, { now })
  const verItems = [
    ...verified.expired.map((v) => ({ v, state: 'lapsed' as const })),
    ...[...verified.expiring, ...verified.verified].filter((v) => v.verification.changedMuch).map((v) => ({ v, state: 'changed' as const })),
  ]
    .filter(({ v }) => scope.has(v.pageId))
    .map(({ v, state }) => ({
      pageId: v.pageId,
      title: v.title,
      state,
      until: localISODate(new Date(v.verification.expiresAt)),
      changedSections: v.verification.changedSections,
    }))
    .sort((a, b) =>
      a.state !== b.state
        ? a.state === 'lapsed' ? -1 : 1
        : a.state === 'lapsed'
          ? cmp(a.until, b.until) || cmp(a.pageId, b.pageId)
          : b.changedSections - a.changedSections || cmp(a.pageId, b.pageId),
    )

  // --- large documents nobody changed for a long time ---------------------------------------
  const cutoff = new Date(now - NOTES_CHECK_QUIET_DAYS * DAY_MS)
  const quietDocs = pagesInScope.filter((n) => n.kind === 'doc' && n.updatedAt < cutoff)
  const sizes = quietDocs.length
    ? await db
        .select({ pageId: pageChunks.pageId, tokens: sql<number>`sum(${pageChunks.tokenEstimate})::int` })
        .from(pageChunks)
        .where(eq(pageChunks.workspaceId, workspaceId))
        .groupBy(pageChunks.pageId)
        .having(sql`sum(${pageChunks.tokenEstimate}) >= ${NOTES_CHECK_LARGE_TOKENS}`)
    : []
  const tokensOf = new Map(sizes.map((s) => [s.pageId, Number(s.tokens)]))
  const quietAll = quietDocs
    .map((n) => ({ n, tokens: tokensOf.get(n.id) ?? 0 }))
    .filter((x) => x.tokens >= NOTES_CHECK_LARGE_TOKENS)
    .sort((a, b) => b.tokens - a.tokens || cmp(a.n.id, b.n.id))

  return {
    workspaceId,
    rootId,
    checked: pagesInScope.length,
    broken: { total: brokenItems.reduce((s, x) => s + x.count, 0), pages: brokenItems.length, items: brokenItems.slice(0, limit) },
    duplicates: { total: dupItems.length, items: dupItems.slice(0, limit) },
    unlinked: {
      total: unlinkedAll.length,
      items: unlinkedAll.slice(0, limit).map((n) => ({ pageId: n.id, title: n.title, updatedOn: localISODate(n.updatedAt) })),
    },
    verification: { total: verItems.length, items: verItems.slice(0, limit) },
    quietLarge: {
      total: quietAll.length,
      minTokens: NOTES_CHECK_LARGE_TOKENS,
      before: localISODate(cutoff),
      items: quietAll.slice(0, limit).map(({ n, tokens }) => ({ pageId: n.id, title: n.title, tokens, updatedOn: localISODate(n.updatedAt) })),
    },
  }
}
