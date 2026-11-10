import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { AppError } from '../errors'
import { matchSectionRef, refNameForms, slugify } from './chunker'
import type { Section } from './chunker'

/**
 * Old section anchors after a heading rename (docs/adr/1501-*).
 *
 * A section's anchor is its heading path slugged (ADR 0926), so renaming a heading — or a parent
 * heading — gives the section a new anchor, and an agent holding the old one got SECTION_NOT_FOUND.
 * The change log (ADR 0932) already records every rename as a `renamed` row with `prev_anchor`
 * (paired by heading block id, so a parent rename records each child too). On a miss, the page's
 * `renamed` / `removed` / `added` rows are replayed in order from the old anchor:
 *
 *   renamed  prev → anchor   the tracked section now answers to `anchor`
 *   removed  anchor          the tracked section is gone
 *   added    anchor = ref    another section took the old name: it is tracked too
 *
 * What is still tracked and exists now is the answer: one anchor → the section moved there; several
 * → ambiguous (the agent must pick one); none → not found as before. No schema change: the rows
 * already exist. They are kept for the change feed's retention (CHANGE_FEED_RETENTION_DAYS) and are
 * written once the indexer has seen the rename (immediately for REST/MCP writes, after the editor's
 * index debounce for typing), so an anchor older than the retention, or a rename typed seconds ago,
 * still gets SECTION_NOT_FOUND.
 */

export interface AnchorEvent {
  kind: 'renamed' | 'removed' | 'added'
  anchor: string
  prevAnchor: string | null
}

export type MoveResult =
  | { status: 'moved'; anchor: string }
  | { status: 'ambiguous'; anchors: string[] }
  | { status: 'none' }

/** The anchors `ref` may mean: as written (without § / #), and its heading path slugged like an anchor. */
export function refAnchors(ref: string): string[] {
  const r = ref.trim().replace(/^§/, '').replace(/^#/, '')
  if (!r) return []
  const slug = r
    .split(/\s*(?:›|>|\/)\s*/)
    .map(slugify)
    .join('/')
  return [...new Set([r, r.toLowerCase(), slug])]
}

/** Pure replay of a page's anchor events (oldest first) from `ref`; `current` = anchors that exist now. */
export function traceAnchor(ref: string, events: AnchorEvent[], current: readonly string[]): MoveResult {
  const names = new Set(refAnchors(ref))
  if (!names.size) return { status: 'none' }
  // A short anchor as find_context prints it (the last path segment): the one former anchor ending in it.
  const seen = new Set<string>()
  const former = new Set<string>()
  for (const e of events) {
    if (e.prevAnchor) {
      seen.add(e.prevAnchor)
      if (e.kind === 'renamed') former.add(e.prevAnchor)
    }
    seen.add(e.anchor)
  }
  if (![...names].some((n) => seen.has(n))) {
    const now = new Set(current)
    const bySuffix = [...former].filter((a) => !now.has(a) && [...names].some((n) => a.endsWith(`/${n}`)))
    if (bySuffix.length !== 1) return { status: 'none' }
    names.clear()
    names.add(bySuffix[0])
  }
  const tracked = new Set<string>(names)
  for (const e of events) {
    if (e.kind === 'renamed') {
      if (e.prevAnchor && e.prevAnchor !== e.anchor && tracked.has(e.prevAnchor)) {
        tracked.delete(e.prevAnchor)
        tracked.add(e.anchor)
      }
    } else if (e.kind === 'removed') {
      tracked.delete(e.anchor)
    } else if (names.has(e.anchor)) {
      tracked.add(e.anchor)
    }
  }
  const now = new Set(current)
  const hits = [...tracked].filter((a) => now.has(a)).sort()
  if (hits.length === 1) return { status: 'moved', anchor: hits[0] }
  if (hits.length > 1) return { status: 'ambiguous', anchors: hits }
  return { status: 'none' }
}

/** Upper bound of change rows replayed for one lookup (newest kept). */
const MAX_EVENTS = 5_000

/** The page's anchor events, oldest first (the newest MAX_EVENTS). */
async function anchorEvents(pageId: string): Promise<AnchorEvent[]> {
  return (await db.execute(sql`
    SELECT kind, anchor, prev_anchor AS "prevAnchor" FROM (
      SELECT seq, kind, anchor, prev_anchor FROM page_changes
       WHERE page_id = ${pageId} AND kind IN ('renamed', 'removed', 'added') AND anchor IS NOT NULL
       ORDER BY seq DESC LIMIT ${MAX_EVENTS}
    ) r ORDER BY seq
  `)) as unknown as AnchorEvent[]
}

/** Where the section `ref` (an anchor that no longer exists in the page) went. */
export async function resolveMovedSection(pageId: string, ref: string, current: readonly string[]): Promise<MoveResult> {
  if (!refAnchors(ref).length) return { status: 'none' }
  return traceAnchor(ref, await anchorEvents(pageId), current)
}

// ---------------------------------------------------------------------------
// Which section a write means (docs/adr/1960-*)
// ---------------------------------------------------------------------------

/**
 * A name (an anchor, a find_context short anchor, a heading text) can pass from one section to
 * another: a second "Decided" above the first takes `decided` and pushes the old one to
 * `decided~2`; a new "# Beta / ## Decided" takes the short anchor `decided` from the section that
 * was `alpha/decided`. An agent holding the name from an earlier read would then write into the new
 * section. A write is let through on its name alone only when the name fits one section now and no
 * other section that still exists answered to it before; otherwise the version the agent read
 * (baseVersion, printed as v=… next to every anchor) has to pick the section, or the write is refused
 * with the sections the name could mean.
 *
 * "Answered to it before" comes from two records:
 * - the change log: anchors a `renamed` row moved away from, followed to where they are now
 *   (traceAnchor, as ADR 1501 follows an anchor that no longer exists);
 * - the section index (page_chunks), for the seconds before the change log catches up with typing:
 *   an indexed section with this name whose heading block is now a different live section.
 * A section that was deleted is not a rival (as in ADR 1501, a new section under the old name takes
 * it over).
 */

type RefSection = Pick<Section, 'anchor' | 'blockId' | 'headingPath' | 'version'>

/** Does the anchor `a` carry the name of the ref (exact: the anchor itself; loose: its end)? */
function nameFits(a: string, exact: string | null, forms: string[]): boolean {
  if (exact !== null) return a === exact
  const l = a.toLowerCase()
  return forms.some((n) => l === n || l.endsWith(`/${n}`))
}

/**
 * Pure part of rivalHolders: live sections other than `targets` that answered to the ref before.
 * `exact` is the target's anchor for an exact ref, null for a loose one (`forms` then).
 */
export function rivalSections<T extends RefSection>(
  outline: readonly T[],
  targets: readonly T[],
  exact: string | null,
  forms: string[],
  events: AnchorEvent[],
  indexed: { anchor: string; blockId: string | null }[],
): T[] {
  const live = outline.map((s) => s.anchor)
  const isTarget = new Set(targets.map((s) => s.anchor))
  const out = new Map<string, T>()
  const add = (s: T | undefined) => {
    if (s && !isTarget.has(s.anchor)) out.set(s.anchor, s)
  }
  const former = new Set<string>()
  for (const e of events) if (e.kind === 'renamed' && e.prevAnchor && e.prevAnchor !== e.anchor && nameFits(e.prevAnchor, exact, forms)) former.add(e.prevAnchor)
  for (const a of former) {
    const t = traceAnchor(a, events, live)
    const hits = t.status === 'moved' ? [t.anchor] : t.status === 'ambiguous' ? t.anchors : []
    for (const h of hits) add(outline.find((s) => s.anchor === h))
  }
  const targetBlocks = new Set(targets.map((s) => s.blockId).filter(Boolean))
  for (const ix of indexed) {
    if (!ix.blockId || targetBlocks.has(ix.blockId) || !nameFits(ix.anchor, exact, forms)) continue
    add(outline.find((s) => s.blockId === ix.blockId))
  }
  return outline.filter((s) => out.has(s.anchor))
}

async function rivalHolders<T extends RefSection>(pageId: string, outline: readonly T[], targets: readonly T[], exact: string | null, forms: string[]): Promise<T[]> {
  // A structural edit of the last moment may still wait in the outbox (the change log is written by
  // its consumer, docs/adr/1080-*): apply this page's pending rows first, as changes_since does.
  const [pending] = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM outbox WHERE topic = 'change' AND state = 'pending' AND payload->>'pageId' = ${pageId}) AS "p"
  `)) as unknown as { p: boolean }[]
  if (pending?.p) await (await import('./changeLog')).drainChangeLog(5)
  // One small query each in the usual case: a page with no matching rename never loads its events.
  const prev = (await db.execute(sql`
    SELECT DISTINCT prev_anchor AS "a" FROM page_changes
     WHERE page_id = ${pageId} AND kind = 'renamed' AND prev_anchor IS NOT NULL
  `)) as unknown as { a: string }[]
  const events = prev.some((r) => nameFits(r.a, exact, forms)) ? await anchorEvents(pageId) : []
  const indexed = (await db.execute(sql`
    SELECT DISTINCT anchor, block_id AS "blockId" FROM page_chunks WHERE page_id = ${pageId}
  `)) as unknown as { anchor: string; blockId: string | null }[]
  return rivalSections(outline, targets, exact, forms, events, indexed)
}

export interface WriteRefOptions {
  /** baseVersion of the write: picks the section when the name could mean several. */
  baseVersion?: string
  /**
   * Check the history of exact anchors too (writes that can carry a baseVersion). Off for claims
   * and comments, which take no version: an exact anchor that fits one live section is used as is.
   */
  exactHistory?: boolean
}

/**
 * The anchor a section write should use for `ref` (docs/adr/1960-*), or `ref` unchanged when no
 * live section fits it (the caller's not-found / renamed-anchor path, ADR 1501, handles that).
 * Throws 409 SECTION_AMBIGUOUS when the name could mean several sections and baseVersion does not
 * pick one. Versions are not put in the error: the agent reads the section it means first.
 */
export async function resolveSectionWriteRef<T extends RefSection>(pageId: string, ref: string, outline: readonly T[], opts: WriteRefOptions = {}): Promise<string> {
  const m = matchSectionRef([...outline], ref)
  if (m.kind === 'none') return ref
  if (m.kind === 'exact' && (m.byBlockId || !opts.exactHistory)) return m.section.anchor
  const targets = m.kind === 'exact' ? [m.section] : m.candidates
  const rivals = await rivalHolders(pageId, outline, targets, m.kind === 'exact' ? m.section.anchor : null, refNameForms(ref))
  if (targets.length === 1 && rivals.length === 0) return targets[0].anchor
  if (opts.baseVersion) {
    const pinned = [...targets, ...rivals].filter((s) => s.version === opts.baseVersion)
    if (pinned.length === 1) return pinned[0].anchor
  }
  throw sectionAmbiguous(ref.trim(), targets, rivals, outline, opts.baseVersion, opts.exactHistory === true)
}

function sectionAmbiguous(
  ref: string,
  targets: readonly RefSection[],
  rivals: readonly RefSection[],
  outline: readonly RefSection[],
  baseVersion: string | undefined,
  takesVersion: boolean,
): AppError {
  const named = new Set([...targets, ...rivals].map((s) => s.anchor))
  const anchors = outline.filter((s) => named.has(s.anchor)).map((s) => s.anchor)
  const list = anchors.map((a) => `§${a}`).join(', ')
  const what =
    targets.length > 1
      ? `Section "${ref}" fits ${targets.length} sections: ${list}`
      : `Section "${ref}" now names §${targets[0].anchor}, but ${rivals.map((s) => `§${s.anchor}`).join(', ')} answered to that name before ` +
        '(a heading was added, moved or renamed since you got it)'
  const version = baseVersion ? `; none of them has version ${baseVersion}, so the one you read has changed` : ''
  return new AppError(
    409,
    'SECTION_AMBIGUOUS',
    `${what}${version}. Nothing was written. Read the one you mean with read_page(pageId, section=<anchor>) and retry with that ` +
      `anchor${takesVersion ? ' and its version as baseVersion' : ''}; read_page(pageId, outline=true) lists every section.`,
    undefined,
    { anchors },
  )
}
