import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { AnyBlock } from './convert'

// ---------------------------------------------------------------------------
// Expand to canvas (M13) — turn a doc page's blocks into an ontology map (canvas cnodes/cedges).
//
// Rules:
//   - page title          → root node (center)
//   - H1/H2/H3 headings   → first-level nodes (linked to their parent by heading hierarchy, else the root)
//   - bullet/numbered/check items under a heading → children of that heading node (one level deep; deeper nesting is merged into the text)
//   - each data row of a table under a heading → child of that heading node (header rows excluded)
//   - an item/cell with a wikilink ([[page]] internal link) becomes a 'page' card
//   - an item/cell with an external URL link keeps it as a markdown link in the text node
//   - text longer than 60 characters → first 60 characters + …
//
// Layout: root centered, headings as left→right clusters, each cluster's children placed on a grid,
//   so even tables with many rows (e.g. 60) never overlap. Clusters are spaced generously.
//
// Storage: like canvasJsonToState in md/canvas.ts, fills a fresh Y.Doc (cnodes/cedges) and encodes it.
// ---------------------------------------------------------------------------

// Internal Yjs node/edge shapes (plain objects stored as Y.Map values) — same schema as md/canvas.ts
interface CNode {
  id: string
  type: 'text' | 'page' | 'link'
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  pageId?: string
  url?: string
}
interface CEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: 'top' | 'right' | 'bottom' | 'left'
  toSide?: 'top' | 'right' | 'bottom' | 'left'
  label?: string
  color?: string
}

// ── inline structure (loose view) ───────────────────────────────────────
interface StyledText {
  type: 'text'
  text: string
  styles?: Record<string, unknown>
}
interface LinkInline {
  type: 'link'
  href: string
  content: StyledText[]
}
type Inline = StyledText | LinkInline | { type: string; [k: string]: unknown }

interface TableCellObj {
  type: 'tableCell'
  content: Inline[]
  [k: string]: unknown
}
interface TableContent {
  type: 'tableContent'
  headerRows?: number
  rows: { cells: Inline[][] | TableCellObj[] }[]
  [k: string]: unknown
}

// Internal wikilink href: /w/<workspaceId>/p/<pageId> → capture = targetPageId
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const INTERNAL_HREF_RE = new RegExp(`^/w/${UUID}/p/(${UUID})$`)
const EXTERNAL_HREF_RE = /^(?:https?:\/\/|mailto:)/i

const ITEM_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])
const MAX_LABEL = 60

// ── layout constants ──────────────────────────────────────────────────
const ROOT_W = 280
const ROOT_H = 72
const HEAD_W = 240
const HEAD_H = 60
const CARD_W = 240
const CARD_H = 60
const COL_GAP = 40 // horizontal gap inside a cluster grid
const ROW_GAP = 28 // vertical gap inside a cluster grid
const CLUSTER_GAP = 120 // gap between clusters
const ROOT_Y = 0
const HEAD_Y = ROOT_Y + ROOT_H + 140 // top of the heading row
const ITEM_Y = HEAD_Y + HEAD_H + 100 // top of the first child grid row

const ROOT_COLOR = '6' // purple
const HEAD_COLOR = '5' // cyan

// ── inline helpers ────────────────────────────────────────────────────

/** Join the display text of an inline array (links by display text). */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const inl of content as Inline[]) {
    if (inl.type === 'text' && typeof (inl as StyledText).text === 'string') {
      out += (inl as StyledText).text
    } else if (inl.type === 'link' && Array.isArray((inl as LinkInline).content)) {
      out += (inl as LinkInline).content.map((c) => c.text ?? '').join('')
    }
  }
  return out
}

/** Target pageId of the first internal wikilink (null if none). */
function firstInternalPageId(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const inl of content as Inline[]) {
    if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
      const m = INTERNAL_HREF_RE.exec((inl as LinkInline).href)
      if (m) return m[1]
    }
  }
  return null
}

/** First external URL link {text, href} (null if none). */
function firstExternalLink(content: unknown): { text: string; href: string } | null {
  if (!Array.isArray(content)) return null
  for (const inl of content as Inline[]) {
    if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
      const href = (inl as LinkInline).href
      if (EXTERNAL_HREF_RE.test(href)) {
        const text = ((inl as LinkInline).content ?? []).map((c) => c.text ?? '').join('')
        return { text, href }
      }
    }
  }
  return null
}

/** Over 60 characters → first 60 + … (counted in Unicode code points). */
function truncate(s: string): string {
  const arr = [...s]
  return arr.length > MAX_LABEL ? arr.slice(0, MAX_LABEL).join('') + '…' : s
}

/** Collect the display text of a block tree (children included) in order (for merging nested items). */
function flattenChildText(children: unknown): string[] {
  if (!Array.isArray(children)) return []
  const out: string[] = []
  for (const child of children as AnyBlock[]) {
    const t = inlineText(child.content).trim()
    if (t) out.push(t)
    out.push(...flattenChildText(child.children))
  }
  return out
}

// ── item/row → node spec ──────────────────────────────────────────────

type ItemSpec = { pageId: string } | { text: string }

/** Bullet/numbered/check item → node spec. page for an internal link, else text (nested items merged, truncated). */
function bulletItemSpec(b: AnyBlock): ItemSpec {
  const pid = firstInternalPageId(b.content)
  if (pid) return { pageId: pid }
  const own = inlineText(b.content).trim()
  const kids = flattenChildText(b.children)
  const merged = [own, ...kids].filter(Boolean).join(' / ')
  return { text: truncate(merged) }
}

/** First table cell → node spec. page for an internal link, markdown link text for an external link, else text. */
function tableCellSpec(cell: Inline[] | TableCellObj): ItemSpec {
  const content = Array.isArray(cell) ? cell : cell?.content
  const pid = firstInternalPageId(content)
  if (pid) return { pageId: pid }
  const ext = firstExternalLink(content)
  if (ext) return { text: `[${truncate(ext.text || ext.href)}](${ext.href})` }
  return { text: truncate(inlineText(content).trim()) }
}

// ── group (section) parsing ───────────────────────────────────────────

interface Group {
  /** This group's heading node id (undefined for the group of items directly under the root) */
  headingId?: string
  headingText?: string
  /** Parent node id the heading node links to (the root or a higher heading) */
  headingParentId?: string
  /** Node id the child items link to (the heading or the root) */
  containerId: string
  items: ItemSpec[]
}

function headingLevel(b: AnyBlock): number {
  const lv = (b.props as { level?: unknown } | undefined)?.level
  return typeof lv === 'number' && lv >= 1 && lv <= 6 ? lv : 1
}

function isTableContent(c: unknown): c is TableContent {
  return !!c && typeof c === 'object' && (c as TableContent).type === 'tableContent'
}

/** Data rows of a table block (header excluded) → item specs. */
function tableRowSpecs(b: AnyBlock): ItemSpec[] {
  const c = b.content
  if (!isTableContent(c)) return []
  const skip = typeof c.headerRows === 'number' && c.headerRows > 0 ? c.headerRows : 0
  const specs: ItemSpec[] = []
  for (const row of c.rows.slice(skip)) {
    const cells = row?.cells
    if (!Array.isArray(cells) || cells.length === 0) continue
    specs.push(tableCellSpec(cells[0]))
  }
  return specs
}

/** Parse blocks into the root + heading groups. rootId is the root node id chosen up front. */
function parseGroups(blocks: AnyBlock[], rootId: string): Group[] {
  const rootGroup: Group = { containerId: rootId, items: [] }
  const groups: Group[] = []
  // heading hierarchy stack (level, nodeId)
  const stack: { level: number; nodeId: string }[] = []
  let current: Group = rootGroup

  const addItemsFrom = (b: AnyBlock, g: Group): void => {
    if (b.type && ITEM_TYPES.has(b.type)) {
      g.items.push(bulletItemSpec(b))
    } else if (b.type === 'table') {
      g.items.push(...tableRowSpecs(b))
    }
  }

  for (const b of blocks) {
    if (b.type === 'heading') {
      const level = headingLevel(b)
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      const parentId = stack.length > 0 ? stack[stack.length - 1].nodeId : rootId
      const headingId = randomUUID()
      const g: Group = {
        headingId,
        headingText: truncate(inlineText(b.content).trim()) || 'Untitled',
        headingParentId: parentId,
        containerId: headingId,
        items: [],
      }
      // Also harvest items/tables inside a heading's children (toggle headings etc.).
      if (Array.isArray(b.children)) {
        for (const child of b.children) addItemsFrom(child, g)
      }
      groups.push(g)
      stack.push({ level, nodeId: headingId })
      current = g
    } else {
      addItemsFrom(b, current)
    }
  }

  const out: Group[] = []
  if (rootGroup.items.length > 0) out.push(rootGroup)
  out.push(...groups)
  return out
}

// ── layout → nodes/edges ──────────────────────────────────────────────

function gridCols(n: number): number {
  return n <= 1 ? 1 : Math.ceil(Math.sqrt(n))
}

const edge = (from: string, to: string): CEdge => ({
  id: randomUUID(),
  fromNode: from,
  toNode: to,
  fromSide: 'bottom',
  toSide: 'top',
})

/**
 * doc blocks → canvas Yjs state (Buffer). Fills a fresh Y.Doc (cnodes/cedges) and encodes it.
 */
export function blocksToCanvasState(title: string, blocks: AnyBlock[]): Buffer {
  const rootId = randomUUID()
  const groups = parseGroups(blocks, rootId)

  const nodes: CNode[] = []
  const edges: CEdge[] = []

  // Lay out clusters (left→right). Each cluster: heading (if any) on top, children on a grid.
  let runningX = 0
  const clusterCenters: number[] = [] // each cluster's headingCenterX (to compute the root X)

  for (const g of groups) {
    const n = g.items.length
    const cols = gridCols(n)
    const gridWidth = n > 0 ? cols * CARD_W + (cols - 1) * COL_GAP : 0
    const clusterWidth = Math.max(HEAD_W, gridWidth)
    const clusterStartX = runningX
    const centerX = clusterStartX + clusterWidth / 2
    clusterCenters.push(centerX)

    // heading node
    if (g.headingId) {
      nodes.push({
        id: g.headingId,
        type: 'text',
        x: Math.round(centerX - HEAD_W / 2),
        y: HEAD_Y,
        width: HEAD_W,
        height: HEAD_H,
        color: HEAD_COLOR,
        text: g.headingText ?? 'Untitled',
      })
      edges.push(edge(g.headingParentId ?? rootId, g.headingId))
    }

    // child item grid
    const gridStartX = clusterStartX + (clusterWidth - gridWidth) / 2
    for (let i = 0; i < n; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = Math.round(gridStartX + col * (CARD_W + COL_GAP))
      const y = ITEM_Y + row * (CARD_H + ROW_GAP)
      const spec = g.items[i]
      const nodeId = randomUUID()
      if ('pageId' in spec) {
        nodes.push({
          id: nodeId,
          type: 'page',
          x,
          y,
          width: CARD_W,
          height: CARD_H,
          pageId: spec.pageId,
        })
      } else {
        nodes.push({
          id: nodeId,
          type: 'text',
          x,
          y,
          width: CARD_W,
          height: CARD_H,
          text: spec.text,
        })
      }
      edges.push(edge(g.containerId, nodeId))
    }

    runningX = clusterStartX + clusterWidth + CLUSTER_GAP
  }

  const totalWidth = clusterCenters.length > 0 ? runningX - CLUSTER_GAP : ROOT_W
  const rootCenterX = totalWidth / 2

  // root node (center)
  nodes.unshift({
    id: rootId,
    type: 'text',
    x: Math.round(rootCenterX - ROOT_W / 2),
    y: ROOT_Y,
    width: ROOT_W,
    height: ROOT_H,
    color: ROOT_COLOR,
    text: truncate(title.trim()) || 'Untitled',
  })

  // ── encode Y.Doc (cnodes/cedges) ──────────────────────────────────────
  const doc = new Y.Doc()
  const cnodes = doc.getMap<CNode>('cnodes')
  const cedges = doc.getMap<CEdge>('cedges')
  for (const nd of nodes) cnodes.set(nd.id, nd)
  for (const ed of edges) cedges.set(ed.id, ed)
  const buf = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return buf
}
