import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { t as tr } from '../../i18n' // aliased: `t` is a common local name in this file
import { isMod } from '../../lib/platform'
import { colorOf, type GraphColors, type ModelLink, type ModelNode } from './graphModel'

// Canvas graph engine — d3-force simulation + <canvas> 2D rendering (modelled on Obsidian's graph view).
// Why React Flow (one DOM element per node) was dropped: with hundreds to thousands of nodes the DOM/memory cost was too heavy (Safari).
//
// Lifecycle rules (to avoid leaks):
//  - The rAF loop only runs while there is work: once the simulation has cooled (alpha<min) and there is no
//    camera animation or highlight fade, no next frame is scheduled. Input wakes it again via schedule().
//  - Nothing is scheduled while the tab is hidden or active=false (collapsed panel, etc.).
//  - destroy() cancels rAF + sim.stop() + removes every listener/observer + removes the canvas.
//  - d3's internal timer is not used (sim.stop(), then tick() from our own loop).

export type EngineSettings = {
  centerForce: number
  repelForce: number
  linkDistance: number
  linkForce: number
  nodeSize: number
  arrows: boolean
  colorGroups: boolean
}

type SimNode = ModelNode & {
  x: number
  y: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
  index?: number
  r: number
  /** Label (ellipsized) + cached measured width */
  short: string
  labelW: number
  color: string
  lower: string
}

type SimLink = { source: SimNode; target: SimNode }

type Callbacks = {
  onOpen: (id: string) => void
}

type Cam = { k: number; x: number; y: number }

const MIN_K = 0.05
const MAX_K = 6
const LABEL_MAX = 24 // truncate with … beyond this many characters
const DIM = 0.12 // opacity of the other nodes while highlighting

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function truncate(s: string): string {
  const arr = [...s] // safe for emoji / surrogate pairs
  return arr.length > LABEL_MAX ? arr.slice(0, LABEL_MAX - 1).join('') + '…' : s
}

export class GraphEngine {
  private host: HTMLElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cb: Callbacks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sim: any
  private nodes: SimNode[] = []
  private links: SimLink[] = []
  private byId = new Map<string, SimNode>()
  private neighbors = new Map<string, Set<string>>()
  /** Label priority (by degree, descending) */
  private labelOrder: SimNode[] = []
  /** Top-degree nodes whose labels are shown even when zoomed out */
  private topIds = new Set<string>()

  private settings: EngineSettings
  private colors: GraphColors
  private fontFamily: string
  private fontSize: number

  private w = 0
  private h = 0
  private dpr = 1
  private cam: Cam = { k: 1, x: 0, y: 0 }
  private camTarget: Cam | null = null
  /** Stop auto-fitting once the user has moved the camera themselves */
  private userMoved = false
  /** Whether auto-fit targets the area around the focus node (the fit button fits everything) */
  private focusFit = true

  private raf = 0
  private simRunning = false
  private active = true
  private destroyed = false

  private hoverId: string | null = null
  /** Touch: node "armed" (highlighted) by the first tap — the second tap opens it */
  private armedId: string | null = null
  private selected = new Set<string>()
  private focusId: string | null = null
  private search: Set<string> | null = null
  /** Highlight fade 0→1 */
  private hlT = 0
  private hlId: string | null = null

  // Pointer state
  private pointers = new Map<number, { x: number; y: number }>()
  private drag: {
    id: number
    node: SimNode | null
    sx: number
    sy: number
    moved: boolean
    lastX: number
    lastY: number
    type: string
  } | null = null
  private pinch: { d: number; mx: number; my: number } | null = null
  private gestureK = 1

  private ro: ResizeObserver
  private cleanups: (() => void)[] = []

  /** Instrumentation (read by verification scripts): total frames drawn */
  frames = 0

  constructor(host: HTMLElement, settings: EngineSettings, colors: GraphColors, cb: Callbacks, opts?: { fontSize?: number }) {
    this.host = host
    this.cb = cb
    this.settings = settings
    this.colors = colors
    this.fontSize = opts?.fontSize ?? 12
    this.fontFamily = getComputedStyle(host).fontFamily || 'sans-serif'

    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block;cursor:grab'
    canvas.setAttribute('aria-label', tr('graph.canvasAria'))
    host.appendChild(canvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!

    this.sim = forceSimulation([])
      .force('link', forceLink([]).id((d: SimNode) => d.id))
      .force('charge', forceManyBody().theta(0.9))
      .force('x', forceX(0))
      .force('y', forceY(0))
      .force('collide', forceCollide((d: SimNode) => d.r + 2).strength(0.6).iterations(1))
      .stop()
    this.applyForces()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.bindEvents()
  }

  // --- Public API -------------------------------------------------------------

  setData(nodes: ModelNode[], links: ModelLink[]): void {
    const prev = this.byId
    const next = new Map<string, SimNode>()
    const out: SimNode[] = []
    for (const n of nodes) {
      const old = prev.get(n.id)
      const s = (old ?? { x: NaN, y: NaN, labelW: -1 }) as SimNode
      if (old && old.label !== n.label) s.labelW = -1
      Object.assign(s, n)
      s.short = truncate(n.label)
      s.lower = n.label.toLowerCase()
      next.set(n.id, s)
      out.push(s)
    }
    const sl: SimLink[] = []
    const nb = new Map<string, Set<string>>()
    for (const n of out) nb.set(n.id, new Set())
    for (const l of links) {
      const s = next.get(l.source)
      const t = next.get(l.target)
      if (!s || !t) continue
      sl.push({ source: s, target: t })
      nb.get(s.id)!.add(t.id)
      nb.get(t.id)!.add(s.id)
    }
    // Initial position of new nodes: near an already-settled neighbour (so toggles that add nodes don't jump).
    // Without a neighbour, leave NaN so d3 uses its default placement (Fibonacci spiral) — never start everything at (0,0)
    // (overlapping nodes made repulsion explode and flung isolated nodes thousands of px away).
    const hadAny = prev.size > 0
    for (const n of out) {
      if (!Number.isNaN(n.x)) continue
      if (!hadAny) continue
      for (const id of nb.get(n.id)!) {
        const m = next.get(id)!
        if (!Number.isNaN(m.x)) {
          n.x = m.x + (Math.random() - 0.5) * 30
          n.y = m.y + (Math.random() - 0.5) * 30
          break
        }
      }
    }
    for (const n of out) {
      if (Number.isNaN(n.x)) {
        // d3 only initializes nodes whose x is NaN
        delete (n as Partial<SimNode>).x
        delete (n as Partial<SimNode>).y
      }
    }
    for (const id of [...this.selected]) if (!next.has(id)) this.selected.delete(id)
    this.nodes = out
    this.links = sl
    this.byId = next
    this.neighbors = nb
    this.labelOrder = [...out].sort((a, b) => b.degree - a.degree)
    this.topIds = new Set(this.labelOrder.slice(0, Math.max(5, Math.min(12, Math.round(out.length / 60)))).map((n) => n.id))
    this.updateRadiiAndColors()

    this.sim.nodes(out)
    this.sim.force('link').links(sl)
    this.applyForces()
    const first = !hadAny
    this.sim.alpha(first ? 1 : 0.6)
    if (first) {
      // Short synchronous warm-up (max ~40ms) so the first frame isn't a tangle — the rest cools down animated.
      const t0 = performance.now()
      for (let i = 0; i < 60 && performance.now() - t0 < 40; i++) this.sim.tick()
      this.fitNow()
    }
    this.simRunning = true
    this.schedule()
  }

  setSettings(s: EngineSettings): void {
    const prev = this.settings
    this.settings = s
    const forcesChanged =
      prev.centerForce !== s.centerForce ||
      prev.repelForce !== s.repelForce ||
      prev.linkDistance !== s.linkDistance ||
      prev.linkForce !== s.linkForce ||
      prev.nodeSize !== s.nodeSize
    this.updateRadiiAndColors()
    if (forcesChanged) {
      this.applyForces()
      this.reheat(0.4)
    }
    this.schedule()
  }

  setColors(c: GraphColors): void {
    this.colors = c
    this.updateRadiiAndColors()
    this.schedule()
  }

  setFocus(id: string | null): void {
    if (id === this.focusId) return
    this.focusId = id
    if (id && this.byId.has(id)) {
      // When focus moves to another page, re-fit around it
      this.focusFit = true
      this.userMoved = false
      const t = this.fitTarget()
      if (t) this.camTarget = t
    }
    this.schedule()
  }

  /** Search query — dims nodes that don't match */
  setSearch(q: string): void {
    const t = q.trim().toLowerCase()
    if (!t) this.search = null
    else {
      this.search = new Set()
      for (const n of this.nodes) if (n.lower.includes(t)) this.search.add(n.id)
    }
    this.schedule()
  }

  /** false while hidden (collapsed panel, modal, ...) — stops the loop entirely */
  setActive(a: boolean): void {
    this.active = a
    if (!a) this.cancel()
    else this.schedule()
  }

  /** Move the camera so every visible node fits (animated) */
  fit(animate = true): void {
    this.focusFit = false
    const t = this.fitTarget()
    if (!t) return
    this.userMoved = false
    if (animate) this.camTarget = t
    else this.cam = t
    this.schedule()
  }

  /** Move the camera to a specific node */
  centerOn(id: string, k?: number): void {
    const n = this.byId.get(id)
    if (!n || n.x == null) return
    const kk = clamp(k ?? Math.max(this.cam.k, 1.2), MIN_K, MAX_K)
    this.camTarget = { k: kk, x: this.w / 2 - n.x * kk, y: this.h / 2 - n.y * kk }
    this.userMoved = true
    this.schedule()
  }

  isRunning(): boolean {
    return this.raf !== 0
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
    this.sim.stop()
    this.sim.nodes([])
    this.sim.force('link').links([])
    this.ro.disconnect()
    for (const c of this.cleanups) c()
    this.cleanups = []
    this.canvas.width = 0
    this.canvas.height = 0
    this.canvas.remove()
    this.nodes = []
    this.links = []
    this.byId.clear()
    this.neighbors.clear()
    this.labelOrder = []
    this.topIds.clear()
  }

  // --- Internal: forces/radii ---------------------------------------------------

  private applyForces(): void {
    const s = this.settings
    // Weak centering force (forceX/Y) — keeps isolated nodes from drifting away without clumping them.
    const c = clamp(s.centerForce, 0, 1) * 0.12
    this.sim.force('x').strength(c)
    this.sim.force('y').strength(c)
    this.sim.force('charge').strength(-clamp(s.repelForce, 0, 20) * 18).distanceMax(1200)
    const link = this.sim.force('link')
    link.distance(s.linkDistance)
    // Link force: 0.5 = d3 default (1/min(degree)) as is; 0..1 maps to 0..2x.
    const mult = clamp(s.linkForce, 0, 1) * 2
    const count = new Map<string, number>()
    for (const l of this.links) {
      count.set(l.source.id, (count.get(l.source.id) ?? 0) + 1)
      count.set(l.target.id, (count.get(l.target.id) ?? 0) + 1)
    }
    link.strength(
      (l: SimLink) =>
        (mult / Math.min(count.get(l.source.id) ?? 1, count.get(l.target.id) ?? 1)) || 0,
    )
    this.sim.force('collide').radius((d: SimNode) => d.r + 2)
  }

  private updateRadiiAndColors(): void {
    const s = this.settings
    for (const n of this.nodes) {
      // sqrt scale on degree — hubs stand out without blowing up.
      const base = n.isTag ? 3 : 4
      n.r = (base + Math.sqrt(n.degree) * 2.2) * clamp(s.nodeSize, 0.3, 3)
      n.color = colorOf(n.gi, this.colors, s.colorGroups)
    }
  }

  private reheat(a: number): void {
    if (this.sim.alpha() < a) this.sim.alpha(a)
    this.simRunning = true
    this.schedule()
  }

  // --- Internal: loop ------------------------------------------------------------

  private schedule(): void {
    if (this.raf || this.destroyed || !this.active) return
    if (typeof document !== 'undefined' && document.hidden) return
    this.raf = requestAnimationFrame(this.frame)
  }

  private cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private frame = (): void => {
    this.raf = 0
    if (this.destroyed || !this.active) return
    this.frames++
    let more = false

    if (this.simRunning) {
      this.sim.tick()
      if (this.sim.alpha() < this.sim.alphaMin() && this.sim.alphaTarget() === 0) {
        this.simRunning = false
        // Fit once more after cooling (only if the user hasn't moved the camera)
        if (!this.userMoved && !this.camTarget) {
          const t = this.fitTarget()
          if (t) this.camTarget = t
        }
      } else more = true
      // During the initial spread the view smoothly follows the layout
      if (!this.userMoved && this.simRunning && !this.drag) {
        const t = this.fitTarget()
        if (t) this.camTarget = t
      }
    }

    if (this.camTarget) {
      const a = this.cam
      const b = this.camTarget
      const f = 0.2
      a.k += (b.k - a.k) * f
      a.x += (b.x - a.x) * f
      a.y += (b.y - a.y) * f
      if (Math.abs(b.k - a.k) < 1e-3 * b.k && Math.abs(b.x - a.x) < 0.5 && Math.abs(b.y - a.y) < 0.5) {
        this.cam = { ...b }
        this.camTarget = null
      } else more = true
    }

    // Highlight fade
    const want = this.hoverId ?? this.armedId
    if (want) this.hlId = want
    const target = want ? 1 : 0
    if (this.hlT !== target) {
      this.hlT += (target - this.hlT) * 0.25
      if (Math.abs(target - this.hlT) < 0.02) this.hlT = target
      else more = true
    }
    if (this.hlT === 0) this.hlId = null

    this.draw()
    if (more) this.schedule()
  }

  private fitTarget(): Cam | null {
    if (!this.nodes.length || !this.w || !this.h) return null
    if (this.focusFit && this.focusId && this.byId.has(this.focusId) && this.nodes.length > 40) {
      // In large graphs with a focus, fit around the focus instead of everything
      const n = this.byId.get(this.focusId)!
      const k = 1.1
      return { k, x: this.w / 2 - n.x * k, y: this.h / 2 - n.y * k }
    }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const n of this.nodes) {
      if (n.x == null || Number.isNaN(n.x)) continue
      x0 = Math.min(x0, n.x - n.r)
      y0 = Math.min(y0, n.y - n.r)
      x1 = Math.max(x1, n.x + n.r)
      y1 = Math.max(y1, n.y + n.r)
    }
    if (!Number.isFinite(x0)) return null
    const pad = Math.min(60, Math.min(this.w, this.h) * 0.12)
    const bw = Math.max(x1 - x0, 1)
    const bh = Math.max(y1 - y0, 1)
    const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), MIN_K, 1.6)
    return { k, x: this.w / 2 - ((x0 + x1) / 2) * k, y: this.h / 2 - ((y0 + y1) / 2) * k }
  }

  private fitNow(): void {
    const t = this.fitTarget()
    if (t) this.cam = t
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    if (w === this.w && h === this.h && dpr === this.dpr) return
    // Keep centered
    if (this.w && this.h) {
      this.cam.x += (w - this.w) / 2
      this.cam.y += (h - this.h) / 2
    }
    this.w = w
    this.h = h
    this.dpr = dpr
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    if (!this.userMoved) this.fitNow()
    this.schedule()
  }

  // --- Internal: drawing ---------------------------------------------------------

  private draw(): void {
    const { ctx, dpr, w, h, colors: c, settings: s } = this
    const { k, x: tx, y: ty } = this.cam
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!this.nodes.length) return

    const hl = this.hlId
    const hlSet = hl ? this.neighbors.get(hl) : undefined
    const f = this.hlT
    const search = this.search
    const dimOf = (n: SimNode): number => {
      let a = 1
      if (hl && hlSet && n.id !== hl && !hlSet.has(n.id)) a *= 1 - (1 - DIM) * f
      if (search && !search.has(n.id)) a *= 0.18
      return a
    }

    // Off-screen culling bounds (world coordinates)
    const vx0 = -tx / k
    const vy0 = -ty / k
    const vx1 = (w - tx) / k
    const vy1 = (h - ty) / k

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty)

    // --- Links: regular ones in one batch, highlighted ones separately ---
    // Like Obsidian, line width follows zoom too (otherwise nodes grew while lines stayed 1px and looked like threads).
    // Screen width = 1.1·k clamped to [0.6, 2.6]px → world width = screen width / k.
    // Lines stop at the edges of both nodes — otherwise they showed through dimmed (translucent) nodes
    // and piled up into a smudge at hub centers.
    const screenW = clamp(1.1 * k, 0.6, 2.6)
    const lw = screenW / k
    const seg = (a: SimNode, b: SimNode, gap: number) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      if (len <= a.r + b.r + gap * 2) return
      const ux = dx / len
      const uy = dy / len
      ctx.moveTo(a.x + ux * (a.r + gap), a.y + uy * (a.r + gap))
      ctx.lineTo(b.x - ux * (b.r + gap), b.y - uy * (b.r + gap))
    }
    const gap = 1.5 / k
    ctx.lineCap = 'round'
    ctx.lineWidth = lw
    ctx.strokeStyle = c.sub
    ctx.globalAlpha = (search ? 0.14 : 0.42) * (hl ? 1 - 0.8 * f : 1)
    ctx.beginPath()
    for (const l of this.links) {
      const a = l.source
      const b = l.target
      if (hl && f > 0 && (a.id === hl || b.id === hl)) continue
      if ((a.x < vx0 && b.x < vx0) || (a.x > vx1 && b.x > vx1) || (a.y < vy0 && b.y < vy0) || (a.y > vy1 && b.y > vy1)) continue
      seg(a, b, gap)
    }
    ctx.stroke()
    if (hl && f > 0) {
      ctx.globalAlpha = 0.4 + 0.5 * f
      ctx.strokeStyle = c.accent
      ctx.lineWidth = Math.max(lw * 1.5, 1.4 / k)
      ctx.beginPath()
      for (const l of this.links) {
        if (l.source.id !== hl && l.target.id !== hl) continue
        seg(l.source, l.target, gap)
      }
      ctx.stroke()
    }
    ctx.lineCap = 'butt'

    // --- Arrows (direction) — skipped at zoom levels where they would be too small ---
    if (s.arrows && k > 0.35) {
      const size = 5 / Math.max(k, 0.8)
      ctx.globalAlpha = (search ? 0.2 : 0.55) * (hl ? 1 - 0.7 * f : 1)
      ctx.fillStyle = c.sub
      ctx.beginPath()
      for (const l of this.links) {
        const a = l.source
        const b = l.target
        if (b.x < vx0 || b.x > vx1 || b.y < vy0 || b.y > vy1) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.hypot(dx, dy)
        if (len < b.r + size) continue
        const ux = dx / len
        const uy = dy / len
        const px = b.x - ux * (b.r + 1 / k)
        const py = b.y - uy * (b.r + 1 / k)
        ctx.moveTo(px, py)
        ctx.lineTo(px - ux * size * 1.6 - uy * size * 0.8, py - uy * size * 1.6 + ux * size * 0.8)
        ctx.lineTo(px - ux * size * 1.6 + uy * size * 0.8, py - uy * size * 1.6 - ux * size * 0.8)
        ctx.closePath()
      }
      ctx.fill()
    }

    // --- Nodes: batch same color/opacity into one path and fill once (cheap even for thousands) ---
    const buckets = new Map<string, SimNode[]>()
    for (const n of this.nodes) {
      if (n.x + n.r < vx0 || n.x - n.r > vx1 || n.y + n.r < vy0 || n.y - n.r > vy1) continue
      const a = dimOf(n)
      const col = hl && f > 0.5 && n.id === hl ? c.accent : n.color
      const key = `${col}|${a.toFixed(2)}`
      let arr = buckets.get(key)
      if (!arr) buckets.set(key, (arr = []))
      arr.push(n)
    }
    for (const [key, arr] of buckets) {
      const [col, a] = key.split('|')
      ctx.globalAlpha = Number(a)
      ctx.fillStyle = col
      ctx.beginPath()
      for (const n of arr) {
        ctx.moveTo(n.x + n.r, n.y)
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      }
      ctx.fill()
    }

    // Rings for pinned (selected) node and current page
    ctx.globalAlpha = 1
    ctx.lineWidth = 2 / k
    for (const id of this.selected) {
      const n = this.byId.get(id)
      if (!n) continue
      ctx.strokeStyle = c.ink
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3 / k, 0, Math.PI * 2)
      ctx.stroke()
    }
    const fo = this.focusId ? this.byId.get(this.focusId) : undefined
    if (fo) {
      ctx.strokeStyle = c.accent
      ctx.lineWidth = 2.5 / k
      ctx.beginPath()
      ctx.arc(fo.x, fo.y, fo.r + 4 / k, 0, Math.PI * 2)
      ctx.stroke()
    }

    this.drawLabels(dimOf)
    ctx.globalAlpha = 1
  }

  private drawLabels(dimOf: (n: SimNode) => number): void {
    const { ctx, dpr, w, h, colors: c } = this
    const { k, x: tx, y: ty } = this.cam
    const fs = this.fontSize
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = `${fs}px ${this.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 4 // background-colored stroke behind labels so passing lines don't cut through the text
    ctx.strokeStyle = c.bg

    const hl = this.hlId
    const hlSet = hl ? this.neighbors.get(hl) : undefined
    const f = this.hlT

    // Priority: hovered/armed → its neighbours → current page/selected → search matches → by degree
    const forced: SimNode[] = []
    const add = (n: SimNode | undefined) => n && forced.push(n)
    if (hl && f > 0.3) {
      add(this.byId.get(hl))
      for (const id of hlSet ?? []) add(this.byId.get(id))
    }
    if (this.focusId) add(this.byId.get(this.focusId))
    for (const id of this.selected) add(this.byId.get(id))
    const forcedIds = new Set(forced.map((n) => n.id))

    // Spatial hash (64px cells) for simple collision checks
    const CELL = 64
    const grid = new Map<number, number[][]>()
    const hit = (x0: number, y0: number, x1: number, y1: number): boolean => {
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const cell = grid.get(gx * 100003 + gy)
          if (!cell) continue
          for (const r of cell) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return true
        }
      return false
    }
    const put = (x0: number, y0: number, x1: number, y1: number) => {
      const r = [x0, y0, x1, y1]
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const key = gx * 100003 + gy
          let cell = grid.get(key)
          if (!cell) grid.set(key, (cell = []))
          cell.push(r)
        }
    }

    let drawn = 0
    const MAX_LABELS = 350
    const tryDraw = (n: SimNode, forcedLabel: boolean) => {
      if (drawn >= MAX_LABELS) return
      const sx = n.x * k + tx
      const sy = n.y * k + ty + n.r * k + 3
      if (sx < -150 || sx > w + 150 || sy < -20 || sy > h + 20) return
      let a: number
      if (forcedLabel) a = 1
      else {
        // Text fade: labels appear as on-screen node size (which reflects degree) grows → hubs first.
        const sr = n.r * k
        a = clamp((sr - 4.5) / 3, 0, 1)
        if (this.search?.has(n.id)) a = Math.max(a, 1)
        // Even zoomed out, a few top hubs keep their names (like big cities on a map)
        if (n.degree >= 3 && this.topIds.has(n.id)) a = Math.max(a, 0.9)
        if (a <= 0.03) return
        const d = dimOf(n)
        if (d < 0.5) return // skip labels of dimmed nodes (less noise)
        a *= d
      }
      if (n.labelW < 0) n.labelW = ctx.measureText(n.short).width
      const x0 = sx - n.labelW / 2 - 2
      const x1 = sx + n.labelW / 2 + 2
      const y1 = sy + fs + 2
      if (hit(x0, sy, x1, y1)) return
      put(x0, sy, x1, y1)
      ctx.globalAlpha = a
      ctx.strokeText(n.short, sx, sy)
      ctx.fillStyle = c.ink
      ctx.fillText(n.short, sx, sy)
      drawn++
    }
    for (const n of forced) tryDraw(n, true)
    if (this.search) for (const id of this.search) {
      const n = this.byId.get(id)
      if (n && !forcedIds.has(id)) tryDraw(n, false)
    }
    for (const n of this.labelOrder) {
      if (drawn >= MAX_LABELS) break
      if (forcedIds.has(n.id) || this.search?.has(n.id)) continue
      tryDraw(n, false)
    }
  }

  // --- Internal: input -----------------------------------------------------------

  private toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private hitTest(sx: number, sy: number, slop: number): SimNode | null {
    const { k, x: tx, y: ty } = this.cam
    const wx = (sx - tx) / k
    const wy = (sy - ty) / k
    let best: SimNode | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy)
      const lim = n.r + slop / k
      if (d <= lim && d < bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const base = this.camTarget ?? this.cam
    const k = clamp(base.k * factor, MIN_K, MAX_K)
    const wx = (sx - base.x) / base.k
    const wy = (sy - base.y) / base.k
    this.camTarget = null
    this.cam = { k, x: sx - wx * k, y: sy - wy * k }
    this.userMoved = true
    this.schedule()
  }

  private setHover(id: string | null): void {
    if (this.hoverId === id) return
    this.hoverId = id
    this.canvas.style.cursor = id ? 'pointer' : this.drag ? 'grabbing' : 'grab'
    this.schedule()
  }

  private bindEvents(): void {
    const cv = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window | Document,
      type: K | string,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts)
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts))
    }

    on(cv, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      const p = this.toLocal(e)
      this.pointers.set(e.pointerId, p)
      try {
        cv.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      if (this.pointers.size === 2) {
        // Pinch start — cancel any drag in progress
        this.endDrag(false)
        const [a, b] = [...this.pointers.values()]
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
        return
      }
      if (this.pointers.size > 2) return
      const slop = e.pointerType === 'touch' ? 14 : 4
      const node = this.hitTest(p.x, p.y, slop)
      this.drag = { id: e.pointerId, node, sx: p.x, sy: p.y, moved: false, lastX: p.x, lastY: p.y, type: e.pointerType }
      this.camTarget = null
    })

    on(cv, 'pointermove', (e: PointerEvent) => {
      const p = this.toLocal(e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)

      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        // Pan (two-finger midpoint) + zoom
        this.cam.x += mx - this.pinch.mx
        this.cam.y += my - this.pinch.my
        if (this.pinch.d > 0) this.zoomAt(mx, my, d / this.pinch.d)
        this.pinch = { d, mx, my }
        this.userMoved = true
        this.schedule()
        return
      }

      const dr = this.drag
      if (!dr || dr.id !== e.pointerId) {
        // Mouse hover (touch has no hover)
        if (e.pointerType !== 'touch' && this.pointers.size === 0) {
          const n = this.hitTest(p.x, p.y, 4)
          this.setHover(n ? n.id : null)
        }
        return
      }
      if (!dr.moved && Math.hypot(p.x - dr.sx, p.y - dr.sy) > (dr.type === 'touch' ? 8 : 3)) {
        dr.moved = true
        if (dr.node) {
          this.sim.alphaTarget(0.25)
          this.reheat(0.25)
        }
        cv.style.cursor = 'grabbing'
      }
      if (!dr.moved) return
      if (dr.node) {
        const { k, x: tx, y: ty } = this.cam
        dr.node.fx = (p.x - tx) / k
        dr.node.fy = (p.y - ty) / k
        if (e.pointerType === 'touch') this.armedId = dr.node.id
      } else {
        this.cam.x += p.x - dr.lastX
        this.cam.y += p.y - dr.lastY
        this.userMoved = true
      }
      dr.lastX = p.x
      dr.lastY = p.y
      this.schedule()
    })

    const up = (e: PointerEvent, cancelled: boolean) => {
      this.pointers.delete(e.pointerId)
      if (this.pointers.size < 2) this.pinch = null
      const dr = this.drag
      if (!dr || dr.id !== e.pointerId) return
      if (!dr.moved && !cancelled) this.handleTap(dr.node, e)
      this.endDrag(true)
    }
    on(cv, 'pointerup', (e: PointerEvent) => up(e, false))
    on(cv, 'pointercancel', (e: PointerEvent) => up(e, true))
    on(cv, 'pointerleave', (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && !this.drag) this.setHover(null)
    })

    const hasGesture = typeof window !== 'undefined' && 'GestureEvent' in window
    on(
      cv,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault()
        // Safari trackpad pinch is handled via gesture* events (avoids double-handling with ctrl+wheel)
        if (hasGesture && e.ctrlKey) return
        const p = this.toLocal(e)
        let dy = e.deltaY
        if (e.deltaMode === 1) dy *= 16
        else if (e.deltaMode === 2) dy *= this.h
        const speed = e.ctrlKey ? 0.01 : 0.0022
        this.zoomAt(p.x, p.y, Math.exp(-dy * speed))
      },
      { passive: false },
    )
    if (hasGesture) {
      type GE = Event & { scale: number; clientX: number; clientY: number }
      on(cv, 'gesturestart', (e: Event) => {
        e.preventDefault()
        this.gestureK = 1
      })
      on(cv, 'gesturechange', (e: Event) => {
        e.preventDefault()
        const g = e as GE
        const p = this.toLocal(g)
        this.zoomAt(p.x, p.y, g.scale / this.gestureK)
        this.gestureK = g.scale
      })
      on(cv, 'gestureend', (e: Event) => e.preventDefault())
    }

    on(document, 'visibilitychange', () => {
      if (document.hidden) this.cancel()
      else this.schedule()
    })
    on(window, 'resize', () => this.resize()) // handle DPR changes (window moved to another monitor)
  }

  private endDrag(release: boolean): void {
    const dr = this.drag
    this.drag = null
    if (!dr) return
    if (dr.node && dr.moved) {
      this.sim.alphaTarget(0)
      if (release && !this.selected.has(dr.node.id)) {
        dr.node.fx = null
        dr.node.fy = null
      }
      this.reheat(0.1)
    }
    this.canvas.style.cursor = this.hoverId ? 'pointer' : 'grab'
  }

  private handleTap(node: SimNode | null, e: PointerEvent): void {
    const mod = isMod(e)
    if (!node) {
      if (this.armedId) {
        this.armedId = null
        this.schedule()
      }
      return
    }
    if (mod) {
      // ⌘/Ctrl-click: select + pin position (does not open). Click again to release.
      if (this.selected.has(node.id)) {
        this.selected.delete(node.id)
        node.fx = null
        node.fy = null
        this.reheat(0.1)
      } else {
        this.selected.add(node.id)
        node.fx = node.x
        node.fy = node.y
      }
      this.schedule()
      return
    }
    if (node.isTag) {
      // Tag nodes have no page to open → only toggle the highlight
      this.armedId = this.armedId === node.id ? null : node.id
      this.schedule()
      return
    }
    if (e.pointerType === 'touch' && this.armedId !== node.id) {
      // Phones have no hover: first tap = highlight, second tap on the same node = open
      this.armedId = node.id
      this.schedule()
      return
    }
    this.cb.onOpen(node.id)
  }
}
