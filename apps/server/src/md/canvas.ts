import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { applyStoredState } from '../yState'

// ---------------------------------------------------------------------------
// Canvas conversion module — Yjs state (cnodes/cedges) ↔ JSON Canvas 1.0 (.canvas)
//
// - Internal Yjs data model (spec §data model):
//     doc.getMap('cnodes'): nodeId → { id, type:'text'|'page'|'link'|'image', x,y,width,height,
//                                       color?, text?, pageId?, url?, name? }
//     doc.getMap('cedges'): edgeId → { id, fromNode, toNode, fromSide?, toSide?, label?, color? }
// - JSON Canvas 1.0 (Obsidian .canvas): text/file/link/group nodes + edges.
//   page node ↔ file node (file path), link node ↔ link node (url).
//   image node → file node (assets/<id>.<ext>) in a zip export, link node in a single export
//   (/files/<id> absolute path — same rule as assetMode:'absolute' in single md export).
//   The reverse (.canvas import) only maps file/link back to page/link — image nodes come back
//   as link cards after a round trip (v1 limit, like pageEmbed and callouts).
// Like blocksToYDoc/stateToBlocks, it builds and fills a fresh Y.Doc, then encodes it.
// ---------------------------------------------------------------------------

type CanvasColor = string // '1'–'6' (preset) or '#rrggbb'

interface CanvasNodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
}
interface CanvasTextNode extends CanvasNodeBase {
  type: 'text'
  text: string
}
interface CanvasFileNode extends CanvasNodeBase {
  type: 'file'
  file: string
  subpath?: string
}
interface CanvasLinkNode extends CanvasNodeBase {
  type: 'link'
  url: string
}
interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group'
  label?: string
  background?: string
}
export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: 'top' | 'right' | 'bottom' | 'left'
  toSide?: 'top' | 'right' | 'bottom' | 'left'
  label?: string
  color?: CanvasColor
}

export interface CanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

// Internal Yjs node/edge shapes (plain objects stored as Y.Map values)
interface CNode {
  id: string
  type: 'text' | 'page' | 'link' | 'image'
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  pageId?: string
  url?: string
  name?: string
}
interface CEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: string
  toSide?: string
  label?: string
  color?: string
}

const DEFAULT_WIDTH = 250
const DEFAULT_HEIGHT = 60
const SIDES = new Set(['top', 'right', 'bottom', 'left'])

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}

function side(v: unknown): 'top' | 'right' | 'bottom' | 'left' | undefined {
  return typeof v === 'string' && SIDES.has(v)
    ? (v as 'top' | 'right' | 'bottom' | 'left')
    : undefined
}

/** Wikilink title from an md file path (last path segment, extension removed). */
function fileBaseName(filePath: string): string {
  const last = filePath.split('/').filter(Boolean).pop() ?? filePath
  return last.replace(/\.(md|canvas)$/i, '') || 'Untitled'
}

// ---------------------------------------------------------------------------
// state → JSON Canvas
// ---------------------------------------------------------------------------

export interface StateToCanvasOptions {
  /** A page node's pageId → relative file path inside the export zip. null if out of scope/deleted. */
  resolvePageFile: (pageId: string) => string | null
  /** Fallback title for a page node (null if out of scope/deleted → 'Untitled'). */
  resolvePageTitle: (pageId: string) => string | null
  /**
   * An image node's attachment id → relative path inside the zip (assets/<id>.<ext>). Passed only for zip export.
   * When omitted (single-page export), the original /files/<id> path is kept.
   */
  resolveAssetFile?: (fileId: string) => string | null
}

/** Extract the attachment id from '/files/<uuid>' (null for any other shape). */
const FILE_URL_RE =
  /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
function assetIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  return FILE_URL_RE.exec(url)?.[1] ?? null
}

/** Attachment ids referenced by image nodes in the state (to collect assets for zip export). */
export function collectAssetRefs(state: Uint8Array): string[] {
  const { cnodes } = readCanvasState(state)
  const ids = new Set<string>()
  for (const n of cnodes) {
    if (n.type !== 'image') continue
    const id = assetIdFromUrl(n.url)
    if (id) ids.add(id)
  }
  return [...ids]
}

/** Read cnodes/cedges out of a Yjs state (safe for an empty state). */
function readCanvasState(state: Uint8Array): { cnodes: CNode[]; cedges: CEdge[] } {
  const doc = new Y.Doc()
  if (state.length > 0) applyStoredState(doc, state)
  const cnodesMap = doc.getMap('cnodes').toJSON() as Record<string, CNode>
  const cedgesMap = doc.getMap('cedges').toJSON() as Record<string, CEdge>
  doc.destroy()
  const cnodes = Object.values(cnodesMap).filter(
    (n): n is CNode => !!n && typeof n === 'object',
  )
  const cedges = Object.values(cedgesMap).filter(
    (e): e is CEdge => !!e && typeof e === 'object',
  )
  // Deterministic output (sorted by id) — stable smoke tests/diffs
  cnodes.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  cedges.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { cnodes, cedges }
}

/** pageIds referenced by page nodes in the state (to prefetch titles for single export). */
export function collectPageRefs(state: Uint8Array): string[] {
  const { cnodes } = readCanvasState(state)
  const ids = new Set<string>()
  for (const n of cnodes) {
    if (n.type === 'page' && typeof n.pageId === 'string' && n.pageId) ids.add(n.pageId)
  }
  return [...ids]
}

export function stateToCanvasJson(
  state: Uint8Array,
  opts: StateToCanvasOptions,
): CanvasData {
  const { cnodes, cedges } = readCanvasState(state)
  const nodes: CanvasNode[] = []

  for (const n of cnodes) {
    const id = typeof n.id === 'string' && n.id ? n.id : randomUUID()
    const base: CanvasNodeBase = {
      id,
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: num(n.width, DEFAULT_WIDTH),
      height: num(n.height, DEFAULT_HEIGHT),
    }
    if (typeof n.color === 'string' && n.color) base.color = n.color

    if (n.type === 'page') {
      const file = typeof n.pageId === 'string' ? opts.resolvePageFile(n.pageId) : null
      if (file) {
        nodes.push({ ...base, type: 'file', file })
      } else {
        // Out-of-scope/deleted page → fall back to a text node ([[title]])
        const title =
          (typeof n.pageId === 'string' ? opts.resolvePageTitle(n.pageId) : null) ??
          'Untitled'
        nodes.push({ ...base, type: 'text', text: `[[${title}]]` })
      }
    } else if (n.type === 'link') {
      nodes.push({ ...base, type: 'link', url: typeof n.url === 'string' ? n.url : '' })
    } else if (n.type === 'image') {
      const assetId = assetIdFromUrl(n.url)
      const file = assetId ? (opts.resolveAssetFile?.(assetId) ?? null) : null
      if (file) {
        nodes.push({ ...base, type: 'file', file })
      } else if (typeof n.url === 'string' && n.url) {
        // Outside a zip (single export) — keep the absolute path that opens inside the app.
        nodes.push({ ...base, type: 'link', url: n.url })
      } else {
        nodes.push({ ...base, type: 'text', text: typeof n.name === 'string' ? n.name : '' })
      }
    } else {
      // text (any other unknown type also falls back to text)
      nodes.push({ ...base, type: 'text', text: typeof n.text === 'string' ? n.text : '' })
    }
  }

  const edges: CanvasEdge[] = []
  for (const e of cedges) {
    if (typeof e.fromNode !== 'string' || typeof e.toNode !== 'string') continue
    const edge: CanvasEdge = {
      id: typeof e.id === 'string' && e.id ? e.id : randomUUID(),
      fromNode: e.fromNode,
      toNode: e.toNode,
    }
    const fs = side(e.fromSide)
    const ts = side(e.toSide)
    if (fs) edge.fromSide = fs
    if (ts) edge.toSide = ts
    if (typeof e.label === 'string' && e.label) edge.label = e.label
    if (typeof e.color === 'string' && e.color) edge.color = e.color
    edges.push(edge)
  }

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// JSON Canvas → state
// ---------------------------------------------------------------------------

export interface CanvasToStateOptions {
  /** file node path → mapped pageId. null if none (→ text fallback). */
  resolveFile: (filePath: string) => string | null
}

/** Fill a fresh Y.Doc (cnodes/cedges) from JSON Canvas and encode it. */
export function canvasJsonToState(
  canvas: CanvasData,
  opts: CanvasToStateOptions,
): Buffer {
  const doc = new Y.Doc()
  const cnodes = doc.getMap<CNode>('cnodes')
  const cedges = doc.getMap<CEdge>('cedges')

  const rawNodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
  const rawEdges = Array.isArray(canvas?.edges) ? canvas.edges : []

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID()
    const base = {
      id,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      width: num(raw.width, DEFAULT_WIDTH),
      height: num(raw.height, DEFAULT_HEIGHT),
    }
    const color =
      typeof (raw as CanvasNodeBase).color === 'string'
        ? (raw as CanvasNodeBase).color
        : undefined

    let node: CNode
    if (raw.type === 'file') {
      const file = typeof (raw as CanvasFileNode).file === 'string'
        ? (raw as CanvasFileNode).file
        : ''
      const pageId = file ? opts.resolveFile(file) : null
      if (pageId) {
        node = { ...base, type: 'page', pageId }
      } else {
        // Unmapped file node → text fallback ([[file name]])
        node = { ...base, type: 'text', text: `[[${fileBaseName(file)}]]` }
      }
    } else if (raw.type === 'link') {
      node = {
        ...base,
        type: 'link',
        url: typeof (raw as CanvasLinkNode).url === 'string' ? (raw as CanvasLinkNode).url : '',
      }
    } else if (raw.type === 'group') {
      // group node → text fallback (v1 limit)
      const label = (raw as CanvasGroupNode).label
      node = { ...base, type: 'text', text: typeof label === 'string' ? label : '' }
    } else {
      node = {
        ...base,
        type: 'text',
        text: typeof (raw as CanvasTextNode).text === 'string' ? (raw as CanvasTextNode).text : '',
      }
    }
    if (color) node.color = color
    cnodes.set(node.id, node)
  }

  for (const raw of rawEdges) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.fromNode !== 'string' || typeof raw.toNode !== 'string') continue
    const edge: CEdge = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      fromNode: raw.fromNode,
      toNode: raw.toNode,
    }
    const fs = side(raw.fromSide)
    const ts = side(raw.toSide)
    if (fs) edge.fromSide = fs
    if (ts) edge.toSide = ts
    if (typeof raw.label === 'string' && raw.label) edge.label = raw.label
    if (typeof raw.color === 'string' && raw.color) edge.color = raw.color
    cedges.set(edge.id, edge)
  }

  const buf = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return buf
}
