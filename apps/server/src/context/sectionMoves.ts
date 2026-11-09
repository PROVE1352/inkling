import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { slugify } from './chunker'

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

/** Where the section `ref` (an anchor that no longer exists in the page) went. */
export async function resolveMovedSection(pageId: string, ref: string, current: readonly string[]): Promise<MoveResult> {
  if (!refAnchors(ref).length) return { status: 'none' }
  const rows = (await db.execute(sql`
    SELECT kind, anchor, prev_anchor AS "prevAnchor" FROM (
      SELECT seq, kind, anchor, prev_anchor FROM page_changes
       WHERE page_id = ${pageId} AND kind IN ('renamed', 'removed', 'added') AND anchor IS NOT NULL
       ORDER BY seq DESC LIMIT ${MAX_EVENTS}
    ) r ORDER BY seq
  `)) as unknown as AnchorEvent[]
  return traceAnchor(ref, rows, current)
}
