// Turns a pressure-sensitive, variable-width stroke into an outline. Shared by the web ink layer
// (SVG path) and the server's PNG renderer for agents (read_ink, docs/adr/1511-*), so a stroke has
// exactly one shape everywhere. Moved here unchanged from apps/web/src/lib/inkStroke.ts.
//
// Computed here instead of using a library (perfect-freehand), to avoid touching the lockfile and
// to tune the brush feel directly. The algorithm is of the same family:
//   1) lightly smooth the coordinates to kill hand tremor and sensor jitter
//   2) find the normal perpendicular to the direction of travel at each point
//   3) set the half-width from pressure and offset both ways to get left/right outlines
//   4) walk the left side, round the end cap, walk back along the right side and close
//
// Coordinates are logical px relative to INK_CANVAS_WIDTH; screen scaling is handled by the SVG
// viewBox (web) or the renderer's scale (server), so it is not a concern here.

export interface InkPoint {
  x: number
  y: number
  /** 0..1 — input without pressure arrives filled with 0.5 */
  p: number
}

/** Flat [x,y,p,...] array → points. A trailing remainder (length not a multiple of 3) is dropped. */
export function toPoints(flat: number[]): InkPoint[] {
  const out: InkPoint[] = []
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push({ x: flat[i], y: flat[i + 1], p: flat[i + 2] })
  }
  return out
}

/** How far pressure affects the half-width — even at 0 this fraction of the width remains. */
const MIN_PRESSURE_RATIO = 0.35
/** Length (px) over which stroke ends taper. Short strokes taper over at most half their length. */
const TAPER = 12

function smooth(points: InkPoint[]): InkPoint[] {
  if (points.length < 3) return points
  const out: InkPoint[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    out.push({
      x: (a.x + 2 * b.x + c.x) / 4,
      y: (a.y + 2 * b.y + c.y) / 4,
      // Pressure is smoothed harder to remove stair-stepping
      p: (a.p + b.p + c.p) / 3,
    })
  }
  out.push(points[points.length - 1])
  return out
}

/** Cumulative distance — for the end taper */
function cumulativeLengths(points: InkPoint[]): number[] {
  const lens = [0]
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    lens.push(lens[i - 1] + Math.hypot(dx, dy))
  }
  return lens
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * One stroke's shape: a circle (a tap or a very short stroke), or a closed outline that walks
 * `left` forward and `right` backward, each side joined with quadratic Béziers through the
 * midpoints of consecutive points (see strokePath).
 */
export type StrokeOutline =
  | { kind: 'dot'; x: number; y: number; r: number }
  | { kind: 'outline'; left: { x: number; y: number }[]; right: { x: number; y: number }[] }

function dotOf(pt: InkPoint, size: number): StrokeOutline {
  return { kind: 'dot', x: pt.x, y: pt.y, r: (size / 2) * (MIN_PRESSURE_RATIO + (1 - MIN_PRESSURE_RATIO) * pt.p) }
}

/**
 * Outline of one stroke (null for no points).
 * @param flat  [x,y,pressure, ...]
 * @param size  base width (px) — the diameter at pressure 1
 */
export function strokeOutline(flat: number[], size: number): StrokeOutline | null {
  const raw = toPoints(flat)
  if (raw.length === 0) return null
  if (raw.length === 1) return dotOf(raw[0], size)

  const points = smooth(raw)
  const lens = cumulativeLengths(points)
  const total = lens[lens.length - 1]
  if (total < 0.6) return dotOf(points[0], size)

  const taper = Math.min(TAPER, total / 2)
  const left: { x: number; y: number }[] = []
  const right: { x: number; y: number }[] = []

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(points.length - 1, i + 1)]
    let dx = next.x - prev.x
    let dy = next.y - prev.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) {
      // Stationary point — skip it so the previous normal is reused
      if (left.length > 0) continue
      dx = 1
      dy = 0
    }
    const nx = -dy / (len || 1)
    const ny = dx / (len || 1)

    const pressure = MIN_PRESSURE_RATIO + (1 - MIN_PRESSURE_RATIO) * points[i].p
    // Taper both ends — attenuate by the distance to the nearer of start/end
    const edge = Math.min(lens[i], total - lens[i])
    const taperK = taper > 0 ? Math.min(1, edge / taper) : 1
    const r = (size / 2) * pressure * (0.25 + 0.75 * taperK)

    left.push({ x: points[i].x + nx * r, y: points[i].y + ny * r })
    right.push({ x: points[i].x - nx * r, y: points[i].y - ny * r })
  }

  if (left.length < 2) return dotOf(points[0], size)
  return { kind: 'outline', left, right }
}

/**
 * Filled outline path of one stroke (SVG path data).
 * @param flat  [x,y,pressure, ...]
 * @param size  base width (px) — the diameter at pressure 1
 */
export function strokePath(flat: number[], size: number): string {
  const o = strokeOutline(flat, size)
  if (!o) return ''
  if (o.kind === 'dot') {
    const r = round(o.r)
    const x = round(o.x)
    const y = round(o.y)
    return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`
  }

  // Join with quadratic Béziers through midpoints to remove corners.
  const curve = (pts: { x: number; y: number }[]): string => {
    let d = ''
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      d += ` Q ${round(a.x)} ${round(a.y)} ${round((a.x + b.x) / 2)} ${round((a.y + b.y) / 2)}`
    }
    d += ` L ${round(pts[pts.length - 1].x)} ${round(pts[pts.length - 1].y)}`
    return d
  }

  const { left } = o
  const rightRev = [...o.right].reverse()
  return (
    `M ${round(left[0].x)} ${round(left[0].y)}` +
    curve(left) +
    ` L ${round(rightRev[0].x)} ${round(rightRev[0].y)}` +
    curve(rightRev) +
    ' Z'
  )
}

/** Does the stroke pass within radius r of (x,y)? — eraser hit test (segment distance). */
export function strokeHit(flat: number[], x: number, y: number, r: number): boolean {
  const pts = toPoints(flat)
  if (pts.length === 0) return false
  const r2 = r * r
  if (pts.length === 1) {
    return (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2 <= r2
  }
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x
    const ay = pts[i - 1].y
    const bx = pts[i].x
    const by = pts[i].y
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0
    const px = ax + dx * t
    const py = ay + dy * t
    if ((px - x) ** 2 + (py - y) ** 2 <= r2) return true
  }
  return false
}
