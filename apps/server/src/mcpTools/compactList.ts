import type { PageMetaDTO } from '@inkling/shared'
import { SEARCH_MAX_LIMIT } from '../routes/agentSearchText'
import type { AgentSearchHit, AgentSearchResponse } from '../routes/agentSearchText'
import { cleanText, wrapUntrusted } from './trust'

/**
 * `format: 'compact'` for list_pages and search (docs/adr/1541-*). Pure functions, no database.
 *
 * - Short ids: the first 8 hex characters of the page id. Fixed length (not "shortest unique"), so
 *   adding a page never changes another page's id in the output (docs/adr/0937-*); only a page whose
 *   8-character prefix collides with another page of the same listing keeps its full id. Tools that
 *   take a page id resolve the prefix (mcpTools/shortIds.ts).
 * - Numbered or dated siblings fold into one line: "Weekly sync 2026-11-{03,10,17} ids: a,b,c".
 *   Only leaf pages with the same kind/section marks fold; a run needs at least MIN_RUN pages and
 *   exactly one number that differs (the rest of the title is identical). Consecutive numbers of the
 *   same width print as a range ({1..8}); ids follow in the same order as the values, so every page
 *   stays addressable.
 * - Tree depth is one space per level instead of two.
 */

export const SHORT_ID_LEN = 8
const MIN_RUN = 3
const LIMIT = 500

export const COMPACT_LEGEND =
  'ids are 8-character prefixes, accepted by every tool. A line like "Log {1..3}" stands for Log 1, Log 2, Log 3; ' +
  'its "ids:" are in the same order.'

/** id → printed id: the 8-character prefix, or the full id where two pages of `ids` share a prefix. */
export function shortIdsFor(ids: string[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const id of ids) count.set(id.slice(0, SHORT_ID_LEN), (count.get(id.slice(0, SHORT_ID_LEN)) ?? 0) + 1)
  return new Map(ids.map((id) => [id, (count.get(id.slice(0, SHORT_ID_LEN)) ?? 0) > 1 ? id : id.slice(0, SHORT_ID_LEN)]))
}

export interface FoldItem {
  id: string
  title: string
  /** Kind/section markers printed after the title (" [collection] 🔒"); folded pages share them. */
  marks: string
  /** False for pages that print children or a hidden-children count (they keep their own line). */
  foldable: boolean
}

export type Folded = { kind: 'one'; item: FoldItem } | { kind: 'run'; label: string; items: FoldItem[] }

/** Title split into text (even index) and digit runs (odd index). */
function segments(title: string): string[] {
  return title.split(/(\d+)/)
}

/** Index of the single digit run in which `a` and `b` differ, or -1 (other differences, or none). */
function varyingDigit(a: string[], b: string[]): number {
  if (a.length !== b.length) return -1
  let at = -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (i % 2 === 0 || at !== -1) return -1
    at = i
  }
  return at
}

/** "1..8" for consecutive numbers of one width, "03,10,17" otherwise; mixed runs combine both. */
export function braceValues(values: string[]): string {
  const parts: string[] = []
  let i = 0
  while (i < values.length) {
    let j = i
    const step = (x: string, y: string) => {
      const sameWidth = x.length === y.length || (!/^0\d/.test(x) && !/^0\d/.test(y))
      return sameWidth ? Number(y) - Number(x) : 0
    }
    const d = i + 1 < values.length ? step(values[i], values[i + 1]) : 0
    if (d === 1 || d === -1) {
      while (j + 1 < values.length && step(values[j], values[j + 1]) === d) j++
    }
    if (j - i >= 2) {
      parts.push(`${values[i]}..${values[j]}`)
      i = j + 1
    } else {
      parts.push(values[i])
      i++
    }
  }
  return parts.join(',')
}

/** Folds runs of numbered/dated leaf siblings (order kept). */
export function foldSiblings(items: FoldItem[]): Folded[] {
  const out: Folded[] = []
  let i = 0
  while (i < items.length) {
    const a = items[i]
    if (a.foldable && !/[{}]/.test(a.title)) {
      const sa = segments(a.title)
      let k = -1
      let j = i + 1
      for (; j < items.length; j++) {
        const b = items[j]
        if (!b.foldable || b.marks !== a.marks || /[{}]/.test(b.title)) break
        const at = varyingDigit(sa, segments(b.title))
        if (at < 0 || (k !== -1 && at !== k)) break
        k = at
      }
      if (j - i >= MIN_RUN && k > 0) {
        const run = items.slice(i, j)
        const values = run.map((x) => segments(x.title)[k])
        out.push({ kind: 'run', label: `${sa.slice(0, k).join('')}{${braceValues(values)}}${sa.slice(k + 1).join('')}`, items: run })
        i = j
        continue
      }
    }
    out.push({ kind: 'one', item: a })
    i++
  }
  return out
}

const titleOf = (p: { title: string }) => p.title || 'Untitled'
const marksOf = (p: PageMetaDTO) => `${p.kind !== 'doc' ? ` [${p.kind}]` : ''}${p.scope === 'private' ? ' 🔒' : ''}`

/**
 * list_pages(format='compact'): the 'lines' tree with short ids, folded sibling runs and one-space
 * indentation. Same order, depth limit and "(+N)" hidden-children count as 'lines'.
 */
export function renderCompactTree(all: PageMetaDTO[], opts: { parentId?: string; depth?: number }): string {
  const byId = new Map(all.map((p) => [p.id, p]))
  const children = new Map<string | null, PageMetaDTO[]>()
  for (const p of all) {
    const k = p.parentId && byId.has(p.parentId) ? p.parentId : null
    const list = children.get(k) ?? []
    list.push(p)
    children.set(k, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // Collisions are checked over the whole workspace, so a subtree listing prints the same ids.
  const short = shortIdsFor(all.map((p) => p.id).sort())
  const start = opts.parentId && opts.parentId !== 'root' ? opts.parentId : null
  const maxDepth = opts.depth ?? 64
  const lines: string[] = []
  let truncated = 0
  const countAll = (k: string | null, d: number): number =>
    (children.get(k) ?? []).reduce((n, c) => n + 1 + (d < maxDepth ? countAll(c.id, d + 1) : 0), 0)
  const walk = (k: string | null, d: number) => {
    const kids = children.get(k) ?? []
    const items = kids.map((c) => ({ id: c.id, title: titleOf(c), marks: marksOf(c), foldable: (children.get(c.id)?.length ?? 0) === 0 }))
    for (const f of foldSiblings(items)) {
      if (lines.length >= LIMIT) {
        if (f.kind === 'run') truncated += f.items.length
        else truncated += 1 + (d < maxDepth ? countAll(f.item.id, d + 1) : 0)
        continue
      }
      const pad = ' '.repeat(d - 1)
      if (f.kind === 'run') {
        lines.push(`${pad}- ${f.label}${f.items[0].marks} ids: ${f.items.map((x) => short.get(x.id)).join(',')}`)
        continue
      }
      const c = f.item
      const n = children.get(c.id)?.length ?? 0
      const hidden = d >= maxDepth && n ? ` (+${n})` : ''
      lines.push(`${pad}- ${c.title}${c.marks} ${short.get(c.id)}${hidden}`)
      if (d < maxDepth) walk(c.id, d + 1)
    }
  }
  walk(start, 1)
  if (lines.length === 0) return 'No pages here.'
  if (truncated) lines.push(`… ${truncated} more pages not shown; pass parentId or a smaller depth.`)
  return lines.join('\n')
}

// --- search (docs/adr/2184-*) ------------------------------------------------------------------

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const WS_NAME_MAX = 40
/** Workspace names in group heads: one line, at most 40 characters (cleaned again by the wrapper). */
function workspaceLabel(name: string): string {
  const s = [...(oneLine(cleanText(name)) || 'Untitled')]
  return s.length > WS_NAME_MAX ? `${s.slice(0, WS_NAME_MAX - 1).join('')}…` : s.join('')
}
const pageMarks = (h: AgentSearchHit) => `${h.kind !== 'doc' ? ` [${h.kind}]` : ''}${h.scope === 'private' ? ' 🔒' : ''}`
/** Remaining matches per workspace (count desc, then id), after the ones shown. */
function remainingByWorkspace(res: AgentSearchResponse): { id: string; name: string; more: number }[] {
  const shown = new Map<string, number>()
  for (const r of res.results) shown.set(r.workspaceId, (shown.get(r.workspaceId) ?? 0) + 1)
  return res.workspaces
    .map((w) => ({ id: w.id, name: w.name, more: w.matches - (shown.get(w.id) ?? 0) }))
    .filter((w) => w.more > 0)
    .sort((a, b) => b.more - a.more || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * search(format 'compact' | 'lines'): one line per page, "id | title [kind] 🔒", then for a heading
 * match " | §anchor Heading › Path", for a body match " | §anchor …snippet…". Results from more than
 * one workspace are grouped under "## Name (id)" heads, groups in the order of their best hit; one
 * workspace prints no head. The page lines (member-written) are wrapped as data; the "N more
 * matches" line after them is ours (ids and counts only). Compact: 8-character page, workspace and
 * section ids (shortest unique anchor suffix); lines: full ones.
 */
export function renderCompactSearch(res: AgentSearchResponse, opts: { format: 'compact' | 'lines'; workspaceGiven: boolean }): string {
  const compact = opts.format === 'compact'
  const pid = compact ? shortIdsFor(res.results.map((r) => r.id)) : new Map(res.results.map((r) => [r.id, r.id]))
  const wid = compact ? shortIdsFor(res.workspaces.map((w) => w.id).sort()) : new Map(res.workspaces.map((w) => [w.id, w.id]))
  const names = new Map(res.workspaces.map((w) => [w.id, w.name]))
  const line = (h: AgentSearchHit) => {
    let s = `${pid.get(h.id)} | ${oneLine(h.title) || 'Untitled'}${pageMarks(h)}`
    const anchor = h.anchor ? `§${compact ? (h.shortAnchor ?? h.anchor) : h.anchor}` : ''
    if (h.match === 'heading' && anchor) s += ` | ${anchor} ${oneLine(h.headingPath ?? '')}`.trimEnd()
    else if (h.match === 'body' && (anchor || h.snippet)) s += ` | ${[anchor, h.snippet ? oneLine(h.snippet) : ''].filter(Boolean).join(' ')}`
    return s
  }
  const groups = new Map<string, AgentSearchHit[]>()
  for (const h of res.results) groups.set(h.workspaceId, [...(groups.get(h.workspaceId) ?? []), h])
  const lines: string[] = []
  if (groups.size > 1) {
    for (const [ws, hits] of groups) {
      if (lines.length) lines.push('')
      lines.push(`## ${workspaceLabel(names.get(ws) ?? '')} (${wid.get(ws) ?? ws})`)
      for (const h of hits) lines.push(line(h))
    }
  } else for (const h of res.results) lines.push(line(h))
  const out = [wrapUntrusted(lines.join('\n'), { source: 'search' })]
  const more = searchMoreLine(res, opts.workspaceGiven, (id) => wid.get(id) ?? id)
  if (more) out.push(more)
  if (compact) out.push(COMPACT_LEGEND)
  return out.join('\n')
}

/**
 * "12 more matches (7 in 1a2b3c4d, 5 in 5e6f7a8b); narrow with workspaceId=<id or name> or more
 * specific words." when matches spread over several workspaces and none was given; otherwise a
 * shorter line about the words and the limit. Null when everything was shown.
 */
export function searchMoreLine(res: AgentSearchResponse, workspaceGiven: boolean, wsId: (id: string) => string = (id) => id): string | null {
  const more = res.total - res.results.length
  if (more <= 0) return null
  const noun = more === 1 ? 'match' : 'matches'
  if (!workspaceGiven && res.workspaces.length > 1) {
    const rest = remainingByWorkspace(res)
    const listed = rest.slice(0, 5).map((w) => `${w.more} in ${wsId(w.id)}`)
    const others = rest.slice(5)
    if (others.length) listed.push(`${others.reduce((n, w) => n + w.more, 0)} in ${others.length} other workspaces`)
    return `${more} more ${noun} (${listed.join(', ')}); narrow with workspaceId=<id or name> or more specific words.`
  }
  return `${more} more ${noun}; narrow with more specific words${res.limit < SEARCH_MAX_LIMIT ? ` or a higher limit (max ${SEARCH_MAX_LIMIT})` : ''}.`
}

/** search(format 'json'): `results` (as before, plus workspace, match, exact, anchor, heading), counts and the more line's numbers. */
export function searchJson(res: AgentSearchResponse): Record<string, unknown> {
  const names = new Map(res.workspaces.map((w) => [w.id, w.name]))
  return {
    results: res.results.map((h) => ({
      id: h.id,
      workspaceId: h.workspaceId,
      workspace: names.get(h.workspaceId) ?? '',
      title: h.title || 'Untitled',
      kind: h.kind,
      section: h.scope === 'private' ? 'private' : 'shared',
      match: h.match,
      exact: h.exact,
      ...(h.anchor ? { anchor: h.anchor, heading: h.headingPath ?? '' } : {}),
      ...(h.snippet ? { snippet: h.snippet } : {}),
    })),
    total: res.total,
    more: Math.max(0, res.total - res.results.length),
    moreByWorkspace: remainingByWorkspace(res).map((w) => ({ workspaceId: w.id, workspace: w.name, more: w.more })),
    // archived workspaces left out of a search without workspaceId (docs/adr/2304-*), only when any
    ...(res.archived?.length ? { archivedNotSearched: res.archived.map((w) => ({ workspaceId: w.id, workspace: w.name })) } : {}),
  }
}
