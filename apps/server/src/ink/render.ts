import { INK_CANVAS_WIDTH, strokeOutline } from '@inkling/shared'
import { encodePng } from './png'

/**
 * Server-side ink renderer for agents (read_ink, docs/adr/1511-*). No dependency: strokes become
 * the same outlines the web layer draws (strokeOutline from @inkling/shared), quadratic Béziers are
 * flattened to polygons, and each polygon is filled with a scanline rasteriser (nonzero winding,
 * like SVG's default fill rule) with anti-aliasing: 4 sub-scanlines per pixel row and exact
 * horizontal coverage at span ends. Strokes are composited in their stored order onto white,
 * pens opaque and highlighters at 0.32 opacity, exactly as the web <path opacity> does.
 *
 * The eraser removes whole strokes from the stored list (InkLayer eraseAt), so drawing what is
 * stored already reflects erasing; there is no eraser stroke to render.
 *
 * Coordinates: logical px of the ink sheet, x in [0, INK_CANVAS_WIDTH), y from the top of the
 * page body. Only the ink is drawn (no page text underneath); the page's text is what read_page
 * returns, and the y positions say where on the page a mark sits.
 */

export const HIGHLIGHTER_OPACITY = 0.32
/** Sub-scanlines per pixel row. */
const SUB = 4
/** Max output height of one image, in pixels. Taller ranges are split into several images. */
export const INK_TILE_MAX_PX = 1600
/** Max images per call; the rest is announced as `nextTop`. */
export const INK_MAX_TILES = 3
/** Blank space kept under the lowest stroke when the whole page is rendered. */
const BOTTOM_MARGIN = 16

export interface StoredStroke {
  tool?: string
  color?: string
  size?: number
  points?: unknown
}

export interface InkTile {
  /** Logical y range [top, top + height) this image shows. */
  top: number
  height: number
  width: number
  pixelHeight: number
  png: Buffer
}

export interface InkRender {
  tiles: InkTile[]
  /** Strokes drawn (at least partly inside the rendered range). */
  drawn: number
  /** Logical y of the lowest ink on the page (0 = no ink). */
  inkBottom: number
  /** Where the next call should start when the range did not fit in INK_MAX_TILES images. */
  nextTop: number | null
  /** End of the requested range (logical y). */
  rangeEnd: number
}

interface Edge {
  x0: number
  y0: number
  x1: number
  y1: number
  /** +1 downwards, -1 upwards. */
  dir: number
  /** dx/dy */
  slope: number
}

type Pt = { x: number; y: number }

function parseColor(c: unknown): [number, number, number] {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
  }
  return [0, 0, 0]
}

/** Valid [x, y, p, ...] numbers of a stored stroke (malformed data is skipped, never thrown). */
export function strokePoints(s: StoredStroke): number[] {
  const p = s.points
  if (!Array.isArray(p)) return []
  const n = p.length - (p.length % 3)
  const out: number[] = []
  for (let i = 0; i < n; i += 3) {
    const x = p[i]
    const y = p[i + 1]
    const pr = p[i + 2]
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      out.push(x, y, typeof pr === 'number' && Number.isFinite(pr) ? Math.min(1, Math.max(0, pr)) : 0.5)
    }
  }
  return out
}

function strokeSize(s: StoredStroke): number {
  const v = typeof s.size === 'number' && Number.isFinite(s.size) ? s.size : 3
  return Math.min(64 * 5, Math.max(0.5, v))
}

/** Lowest logical y any stroke reaches (its points plus half its width). */
export function inkBottom(strokes: StoredStroke[]): number {
  let max = 0
  for (const s of strokes) {
    const pts = strokePoints(s)
    const r = strokeSize(s) / 2
    for (let i = 1; i < pts.length; i += 3) if (pts[i] + r > max) max = pts[i] + r
  }
  return Math.ceil(max)
}

/** Flatten one stroke into closed polygons (output-pixel coordinates). */
function strokePolygon(flat: number[], size: number, scale: number, top: number): Pt[] | null {
  const o = strokeOutline(flat, size)
  if (!o) return null
  const tx = (p: Pt): Pt => ({ x: p.x * scale, y: (p.y - top) * scale })
  if (o.kind === 'dot') {
    const c = tx(o)
    const r = o.r * scale
    const n = Math.max(8, Math.min(64, Math.ceil((2 * Math.PI * r) / 2)))
    const out: Pt[] = []
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n
      out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
    }
    return out
  }
  const out: Pt[] = []
  // Same commands as strokePath: M L0, then Q(control P[i-1], end mid(P[i-1], P[i])) …, L P[last].
  const walk = (pts: Pt[]) => {
    let cur = out[out.length - 1]
    for (let i = 1; i < pts.length; i++) {
      const c = tx(pts[i - 1])
      const b = tx(pts[i])
      const e = { x: (c.x + b.x) / 2, y: (c.y + b.y) / 2 }
      const d = Math.hypot(c.x - cur.x, c.y - cur.y) + Math.hypot(e.x - c.x, e.y - c.y)
      const n = Math.max(1, Math.min(16, Math.ceil(d / 2)))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        out.push({ x: u * u * cur.x + 2 * u * t * c.x + t * t * e.x, y: u * u * cur.y + 2 * u * t * c.y + t * t * e.y })
      }
      cur = e
    }
    out.push(tx(pts[pts.length - 1]))
  }
  out.push(tx(o.left[0]))
  walk(o.left)
  const rightRev = [...o.right].reverse()
  out.push(tx(rightRev[0]))
  walk(rightRev)
  return out
}

/**
 * Fill `poly` (nonzero) into `rgb` (width × height) with colour `rgb3` at `opacity`, anti-aliased.
 */
function fillPolygon(
  rgb: Uint8Array,
  width: number,
  height: number,
  poly: Pt[],
  color: [number, number, number],
  opacity: number,
): boolean {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const edges: Edge[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (a.x < minX) minX = a.x
    if (a.x > maxX) maxX = a.x
    if (a.y < minY) minY = a.y
    if (a.y > maxY) maxY = a.y
    if (a.y === b.y) continue
    const down = a.y < b.y
    const p = down ? a : b
    const q = down ? b : a
    edges.push({ x0: p.x, y0: p.y, x1: q.x, y1: q.y, dir: down ? 1 : -1, slope: (q.x - p.x) / (q.y - p.y) })
  }
  const x0 = Math.max(0, Math.floor(minX))
  const x1 = Math.min(width, Math.ceil(maxX) + 1)
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(height, Math.ceil(maxY) + 1)
  if (x0 >= x1 || y0 >= y1 || edges.length === 0) return false
  edges.sort((a, b) => a.y0 - b.y0)

  const w = x1 - x0
  const acc = new Float32Array(w + 2)
  const run = new Float32Array(w + 2)
  const active: Edge[] = []
  const xs: { x: number; dir: number }[] = []
  let next = 0
  const unit = 1 / SUB
  const [cr, cg, cb] = color
  for (let py = y0; py < y1; py++) {
    let any = false
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB
      while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++])
      xs.length = 0
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i]
        if (e.y1 <= sy) {
          active[i] = active[active.length - 1]
          active.pop()
          continue
        }
        if (e.y0 > sy) continue
        xs.push({ x: e.x0 + (sy - e.y0) * e.slope, dir: e.dir })
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a.x - b.x)
      let wind = 0
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].dir
        if (wind === 0) continue
        let xa = xs[i].x - x0
        let xb = xs[i + 1].x - x0
        if (xa < 0) xa = 0
        if (xb > w) xb = w
        if (xb <= xa) continue
        any = true
        const ia = Math.floor(xa)
        const ib = Math.floor(xb)
        if (ia === ib) {
          acc[ia] += (xb - xa) * unit
        } else {
          acc[ia] += (ia + 1 - xa) * unit
          run[ia + 1] += unit
          run[ib] -= unit
          acc[ib] += (xb - ib) * unit
        }
      }
    }
    if (!any) continue
    let r = 0
    const rowOff = py * width * 3
    for (let i = 0; i < w; i++) {
      r += run[i]
      let cov = acc[i] + r
      acc[i] = 0
      run[i] = 0
      if (cov <= 0.0005) continue
      if (cov > 1) cov = 1
      const a = cov * opacity
      const o = rowOff + (x0 + i) * 3
      rgb[o] = Math.round(rgb[o] + (cr - rgb[o]) * a)
      rgb[o + 1] = Math.round(rgb[o + 1] + (cg - rgb[o + 1]) * a)
      rgb[o + 2] = Math.round(rgb[o + 2] + (cb - rgb[o + 2]) * a)
    }
    acc[w] = 0
    run[w] = 0
    acc[w + 1] = 0
    run[w + 1] = 0
  }
  return true
}

/** Render one image of the logical range [top, top + height). */
export function renderInkTile(
  strokes: StoredStroke[],
  opts: { top: number; height: number; scale: number },
  seen: Set<number> = new Set(),
): { tile: InkTile; drawn: number } {
  const width = Math.max(1, Math.round(INK_CANVAS_WIDTH * opts.scale))
  const pixelHeight = Math.max(1, Math.round(opts.height * opts.scale))
  const rgb = new Uint8Array(width * pixelHeight * 3).fill(255)
  let drawn = 0
  for (let idx = 0; idx < strokes.length; idx++) {
    const s = strokes[idx]
    const flat = strokePoints(s)
    if (flat.length === 0) continue
    const size = strokeSize(s)
    // Cheap reject before building the outline: the stroke's y extent plus its width.
    let lo = Infinity
    let hi = -Infinity
    for (let i = 1; i < flat.length; i += 3) {
      if (flat[i] < lo) lo = flat[i]
      if (flat[i] > hi) hi = flat[i]
    }
    if (hi + size < opts.top || lo - size > opts.top + opts.height) continue
    const poly = strokePolygon(flat, size, opts.scale, opts.top)
    if (!poly) continue
    const opacity = s.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1
    if (fillPolygon(rgb, width, pixelHeight, poly, parseColor(s.color), opacity)) {
      drawn++
      seen.add(idx)
    }
  }
  return {
    tile: { top: opts.top, height: opts.height, width, pixelHeight, png: encodePng(rgb, width, pixelHeight) },
    drawn,
  }
}

/**
 * Render a page's strokes. Without `height`, the range runs from `top` to just below the lowest
 * stroke. The range is cut into images of at most INK_TILE_MAX_PX pixels high; at most
 * INK_MAX_TILES images are returned and `nextTop` says where to continue.
 */
export function renderInk(
  strokes: StoredStroke[],
  opts: { top?: number; height?: number; scale?: number } = {},
): InkRender {
  const scale = opts.scale ?? 1
  const top = Math.max(0, Math.floor(opts.top ?? 0))
  const bottom = inkBottom(strokes)
  const rangeEnd = opts.height !== undefined ? top + Math.ceil(opts.height) : Math.max(top + 1, bottom + BOTTOM_MARGIN)
  const tileLogical = Math.max(1, Math.floor(INK_TILE_MAX_PX / scale))
  const tiles: InkTile[] = []
  const seen = new Set<number>()
  let y = top
  while (y < rangeEnd && tiles.length < INK_MAX_TILES) {
    const h = Math.min(tileLogical, rangeEnd - y)
    tiles.push(renderInkTile(strokes, { top: y, height: h, scale }, seen).tile)
    y += h
  }
  return { tiles, drawn: seen.size, inkBottom: bottom, nextTop: y < rangeEnd ? y : null, rangeEnd }
}
