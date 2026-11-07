import type { GraphDTO } from '../../api'
import { t } from '../../i18n'

// Graph API response (GraphDTO) → node/link model for the renderer.
// Groups (= top-level folders), tag nodes, the orphan filter and local (N-hop) subgraphs are all built here in one pass.

/** Special group indices — values >= 0 index into groups[] */
export const G_NEUTRAL = -1 // root page (no group)
export const G_TAG = -2 // tag node
export const G_ORPHAN = -3 // orphan node

export type ModelNode = {
  id: string
  label: string
  /** Degree (counting only the links currently shown) */
  degree: number
  /** Group index (groups[]) or G_* */
  gi: number
  isTag: boolean
}

export type ModelLink = { source: string; target: string }

export type ModelGroup = { key: string; label: string; count: number }

export type GraphModel = {
  nodes: ModelNode[]
  links: ModelLink[]
  groups: ModelGroup[]
  /** Whether the data has any tags at all (decides whether the tag toggle is shown) */
  hasTags: boolean
}

export type ModelOptions = {
  showOrphans: boolean
  showTags: boolean
  /** Local graph: `depth` hops from focus, with direction filters */
  local?: { focusId: string; depth: number; incoming: boolean; outgoing: boolean }
}

const TAG_PREFIX = 'tag:'
export const isTagId = (id: string) => id.startsWith(TAG_PREFIX)

export function buildModel(graph: GraphDTO, opt: ModelOptions): GraphModel {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  // The API contract guarantees both ends are in nodes, but filter defensively (dangling edges crash d3). Drop duplicates and self-links.
  const seen = new Set<string>()
  const pageLinks: ModelLink[] = []
  for (const e of graph.edges) {
    if (e.source === e.target || !byId.has(e.source) || !byId.has(e.target)) continue
    const k = `${e.source}>${e.target}`
    if (seen.has(k)) continue
    seen.add(k)
    pageLinks.push({ source: e.source, target: e.target })
  }

  const tagRows = graph.tags ?? []
  const hasTags = tagRows.length > 0

  // --- Decide the node set -----------------------------------------------------
  let keep: Set<string>
  if (opt.local) {
    keep = neighborhood(pageLinks, opt.local)
  } else {
    keep = new Set(graph.nodes.map((n) => n.id))
  }

  const links = pageLinks.filter((l) => keep.has(l.source) && keep.has(l.target))

  // Tag nodes: only tags of pages being shown. Names are merged case-insensitively.
  const tagLinks: ModelLink[] = []
  const tagLabel = new Map<string, string>()
  if (opt.showTags && hasTags) {
    const tseen = new Set<string>()
    for (const row of tagRows) {
      if (!keep.has(row.pageId)) continue
      const key = TAG_PREFIX + row.tag.toLowerCase()
      if (!tagLabel.has(key)) tagLabel.set(key, `#${row.tag}`)
      const k = `${row.pageId}>${key}`
      if (tseen.has(k)) continue
      tseen.add(k)
      tagLinks.push({ source: row.pageId, target: key })
    }
  }

  const degree = new Map<string, number>()
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1)
  for (const l of links) {
    bump(l.source)
    bump(l.target)
  }
  for (const l of tagLinks) {
    bump(l.source)
    bump(l.target)
  }

  // --- Groups (topmost ancestor) ----------------------------------------------
  // Walk up the parent chain and use the topmost *visible* ancestor as the group key. A root page
  // itself only becomes a group when it is a folder or has children (otherwise it gets the neutral color).
  const hasChild = new Set<string>()
  for (const n of graph.nodes) if (n.parentId && byId.has(n.parentId)) hasChild.add(n.parentId)
  const rootOf = new Map<string, string>()
  const findRoot = (id: string): string => {
    const cached = rootOf.get(id)
    if (cached) return cached
    const chain: string[] = []
    let cur = id
    for (let guard = 0; guard < 64; guard++) {
      chain.push(cur)
      const p = byId.get(cur)?.parentId
      if (!p || !byId.has(p) || rootOf.has(p)) {
        const r = p && rootOf.has(p) ? rootOf.get(p)! : cur
        for (const c of chain) rootOf.set(c, r)
        return r
      }
      cur = p
    }
    for (const c of chain) rootOf.set(c, cur)
    return cur
  }

  const groupCount = new Map<string, number>()
  const nodeGroupKey = new Map<string, string | null>()
  for (const id of keep) {
    const n = byId.get(id)
    if (!n) continue
    const root = findRoot(id)
    const rn = byId.get(root)
    const grouped = root !== id || rn?.kind === 'folder' || hasChild.has(id)
    const key = grouped ? root : null
    nodeGroupKey.set(id, key)
    if (key) groupCount.set(key, (groupCount.get(key) ?? 0) + 1)
  }
  // Color assignment order: biggest groups first (the first palette colors are the most distinct), ties by title — stable.
  const groups: ModelGroup[] = [...groupCount.entries()]
    .map(([key, count]) => ({ key, label: byId.get(key)?.title || t('common.untitled'), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const gIndex = new Map(groups.map((g, i) => [g.key, i]))

  const nodes: ModelNode[] = []
  for (const id of keep) {
    const n = byId.get(id)
    if (!n) continue
    const d = degree.get(id) ?? 0
    const orphan = d === 0
    // The local graph's focus node is always shown, even with no links
    if (orphan && !opt.showOrphans && id !== opt.local?.focusId) continue
    const key = nodeGroupKey.get(id)
    nodes.push({
      id,
      label: n.title || t('common.untitled'),
      degree: d,
      gi: orphan ? G_ORPHAN : key != null ? gIndex.get(key)! : G_NEUTRAL,
      isTag: false,
    })
  }
  for (const [key, label] of tagLabel) {
    nodes.push({ id: key, label, degree: degree.get(key) ?? 0, gi: G_TAG, isTag: true })
  }

  return { nodes, links: [...links, ...tagLinks], groups, hasTags }
}

// N-hop neighbourhood of focus (with direction filters), via BFS.
function neighborhood(
  links: ModelLink[],
  o: { focusId: string; depth: number; incoming: boolean; outgoing: boolean },
): Set<string> {
  const out = new Map<string, string[]>()
  const inn = new Map<string, string[]>()
  for (const l of links) {
    if (!out.has(l.source)) out.set(l.source, [])
    out.get(l.source)!.push(l.target)
    if (!inn.has(l.target)) inn.set(l.target, [])
    inn.get(l.target)!.push(l.source)
  }
  const keep = new Set<string>([o.focusId])
  let frontier = [o.focusId]
  for (let h = 0; h < o.depth && frontier.length; h++) {
    const next: string[] = []
    for (const id of frontier) {
      const nbs = [
        ...(o.outgoing ? (out.get(id) ?? []) : []),
        ...(o.incoming ? (inn.get(id) ?? []) : []),
      ]
      for (const nb of nbs) {
        if (!keep.has(nb)) {
          keep.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return keep
}

// --- Colors ------------------------------------------------------------------

// Desaturated group palette (light/dark). The olive used for tags is deliberately left out.
const PALETTE_LIGHT = [
  '#6b8fd6',
  '#d9885b',
  '#5fae8b',
  '#b77fc8',
  '#cfa244',
  '#5aa9b8',
  '#d0718a',
  '#8c7bd6',
  '#b08a6a',
]
const PALETTE_DARK = [
  '#7fa2e6',
  '#e59c70',
  '#6fc19d',
  '#c894d8',
  '#dcb45e',
  '#6cbccb',
  '#df869d',
  '#a08fe6',
  '#c49e7e',
]

export type GraphColors = {
  bg: string
  ink: string
  sub: string
  line: string
  accent: string
  /** Root pages (no group) */
  neutral: string
  orphan: string
  tag: string
  groups: string[]
}

/** Read theme colors from CSS variables (call again when the theme changes). */
export function readGraphColors(dark: boolean): GraphColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb
  const sub = v('--color-sub', dark ? '#9b9b98' : '#787774')
  return {
    bg: v('--color-app', dark ? '#191919' : '#ffffff'),
    ink: v('--color-ink', dark ? '#e6e6e4' : '#37352f'),
    sub,
    line: v('--color-line', dark ? '#2e2e2e' : '#e9e9e7'),
    accent: v('--color-accent', dark ? '#818cf8' : '#6366f1'),
    neutral: sub,
    orphan: dark ? '#5c5c5a' : '#bdbcb8',
    tag: dark ? '#9bbd52' : '#7c9a3a',
    groups: dark ? PALETTE_DARK : PALETTE_LIGHT,
  }
}

export function colorOf(gi: number, c: GraphColors, colorGroups: boolean): string {
  if (gi === G_TAG) return c.tag
  if (gi === G_ORPHAN) return c.orphan
  if (gi === G_NEUTRAL || !colorGroups) return c.neutral
  return c.groups[gi % c.groups.length]
}
