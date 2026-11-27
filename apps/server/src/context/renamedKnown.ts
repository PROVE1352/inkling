import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { PATH_SEP, sectionVersion, slugify } from './chunker'
import { traceAnchor } from './sectionMoves'
import type { AnchorEvent } from './sectionMoves'

/**
 * Renamed sections a reader already has (docs/adr/2597-*).
 *
 * read_page(knownSections={anchor: v}) with anchors from before a heading rename (typically every
 * heading renumbered by an update_page replace) used to send every renamed section in full: the old
 * anchors are gone and the new ones are unknown to the caller. A section version is
 * sha1(heading path + body) (ADR 0926) and the old heading text is stored nowhere (ADR 1501), so
 * "the body did not change" is proven, not assumed: the caller's version is recomputed from the
 * current body under a candidate old heading path, and only an exact match counts. Candidates:
 *   - the current path with the old anchor's slug words put back where they differ (same word count
 *     per heading; renumbered headings "2. Alpha" ← `1-alpha` are the case this is for);
 *   - heading paths the change log recorded under the old anchor (an added/modified row of it).
 * Which current section to try: the one the change log traces the old anchor to (ADR 1501), then
 * sections whose anchor differs from the old one only in numbers, nearest numbers first, at most
 * MAX_NUMBER_TRIES. Anything not proven is read in full as before, so a false "unchanged" would need
 * a sha1 collision.
 */

export interface KnownRename {
  /** The caller's anchor (gone). */
  from: string
  /** The current anchor holding the same body. */
  to: string
  /** The current version of `to`. */
  version: string
}

export interface RenameHints {
  /** old anchor → current anchor, from the change log replay. */
  targets: Map<string, string>
  /** old anchor → heading paths the change log recorded under it. */
  oldPaths: Map<string, string[][]>
}

interface SectionText {
  anchor: string
  headingPath: string[]
  text: string
  version: string
}

const MAX_NUMBER_TRIES = 16
const MAX_LOG_PATHS = 8
const MAX_EVENTS = 5_000

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const stripDup = (a: string) => a.replace(/~\d+$/, '')

/**
 * The current heading path with the words of `oldAnchor` put back where its slug differs, or nothing
 * when the heading count or a heading's word count differs.
 */
export function oldPathCandidates(path: string[], oldAnchor: string): string[][] {
  const segs = stripDup(oldAnchor).split('/')
  if (segs.length !== path.length) return []
  const out: string[] = []
  for (let i = 0; i < path.length; i++) {
    const title = path[i]
    if (slugify(title) === segs[i]) {
      out.push(title)
      continue
    }
    const norm = title.normalize('NFKC')
    const runs = [...norm.matchAll(/[\p{L}\p{N}]+/gu)]
    const words = segs[i].split('-')
    if (runs.length !== words.length) return []
    let s = ''
    let last = 0
    runs.forEach((m, k) => {
      s += norm.slice(last, m.index) + (m[0].toLowerCase() === words[k] ? m[0] : words[k])
      last = m.index + m[0].length
    })
    out.push(s + norm.slice(last))
  }
  return [out]
}

/** Numbers of an anchor that differs from `from` only in numbers (same words otherwise), or null. */
function numberDistance(from: string, to: string): number | null {
  const a = stripDup(from).split(/[-/]/)
  const b = stripDup(to).split(/[-/]/)
  if (a.length !== b.length || stripDup(from).replace(/[^/]/g, '') !== stripDup(to).replace(/[^/]/g, '')) return null
  let d = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (!/^\d+$/.test(a[i]) || !/^\d+$/.test(b[i])) return null
    d += Math.abs(Number(a[i]) - Number(b[i]))
  }
  return d
}

/**
 * The caller's gone (anchor, version) pairs that a current section holds with the same body, proven
 * by recomputing the version. Each current section is claimed once; old anchors are tried in code
 * unit order, so the answer is the same for the same input.
 */
export function matchRenamedKnown(gone: [string, string][], sections: SectionText[], hints: RenameHints): KnownRename[] {
  const out: KnownRename[] = []
  const claimed = new Set<string>()
  const byAnchor = new Map(sections.map((s) => [s.anchor, s]))
  for (const [from, rawV] of [...gone].sort((x, y) => cmp(x[0], y[0]))) {
    const v = rawV.toLowerCase()
    const targets: SectionText[] = []
    const traced = hints.targets.get(from)
    if (traced && byAnchor.has(traced)) targets.push(byAnchor.get(traced)!)
    const near: { s: SectionText; d: number }[] = []
    for (const s of sections) {
      if (s.anchor === traced) continue
      const d = numberDistance(from, s.anchor)
      if (d !== null) near.push({ s, d })
    }
    near.sort((x, y) => x.d - y.d || cmp(x.s.anchor, y.s.anchor))
    targets.push(...near.slice(0, MAX_NUMBER_TRIES).map((n) => n.s))
    const logged = hints.oldPaths.get(from) ?? []
    for (const s of targets) {
      if (claimed.has(s.anchor)) continue
      const paths = [...oldPathCandidates(s.headingPath, from), ...logged]
      if (!paths.some((p) => sectionVersion(p, s.text) === v)) continue
      out.push({ from, to: s.anchor, version: s.version })
      claimed.add(s.anchor)
      break
    }
  }
  return out
}

/** Change-log hints for the gone anchors: where each was traced to, and heading paths it had. */
export async function renameHints(pageId: string, gone: string[], current: readonly string[]): Promise<RenameHints> {
  const rows = (await db.execute(sql`
    SELECT kind, anchor, prev_anchor AS "prevAnchor", heading_path AS "headingPath" FROM (
      SELECT seq, kind, anchor, prev_anchor, heading_path FROM page_changes
       WHERE page_id = ${pageId} AND anchor IS NOT NULL AND kind IN ('renamed', 'removed', 'added', 'modified')
       ORDER BY seq DESC LIMIT ${MAX_EVENTS}
    ) r ORDER BY seq
  `)) as unknown as { kind: string; anchor: string; prevAnchor: string | null; headingPath: string }[]
  const events: AnchorEvent[] = rows.filter((r) => r.kind !== 'modified') as AnchorEvent[]
  const wanted = new Set(gone)
  const targets = new Map<string, string>()
  const oldPaths = new Map<string, string[][]>()
  for (const a of gone) {
    const t = traceAnchor(a, events, current)
    if (t.status === 'moved') targets.set(a, t.anchor)
  }
  const seen = new Set<string>()
  for (const r of rows) {
    if (!wanted.has(r.anchor) || !r.headingPath) continue
    const key = `${r.anchor}\u0000${r.headingPath}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = oldPaths.get(r.anchor) ?? []
    if (list.length >= MAX_LOG_PATHS) continue
    list.push(r.headingPath.split(PATH_SEP))
    oldPaths.set(r.anchor, list)
  }
  return { targets, oldPaths }
}

/**
 * update_page replace hint (docs/adr/2597-*): how many of the new sections have a body that no old
 * section had (each old body counted once).
 */
export function bodyChangeCount(before: string[], after: string[]): { changed: number; total: number } {
  const left = new Map<string, number>()
  for (const t of before) left.set(t, (left.get(t) ?? 0) + 1)
  let changed = 0
  for (const t of after) {
    const n = left.get(t) ?? 0
    if (n > 0) left.set(t, n - 1)
    else changed++
  }
  return { changed, total: after.length }
}
