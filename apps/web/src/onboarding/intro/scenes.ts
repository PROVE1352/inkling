// The intro motion (docs/adr/2382-*): four scenes drawn as SVG by pure functions of the time t in
// seconds. Nothing here reads a clock, a random source or the DOM, and the SVG has no CSS animation
// or SMIL: the same t always gives the same markup. The in-app player moves t with
// requestAnimationFrame; a headless browser can seek frame by frame through
// `window.__inklingIntro.seek(t)` to render a promo video on the 1920×1080 stage.
//
// Colors are Inkling's own tokens (var(--color-*)), so the light and dark themes both work; text uses
// the UI font (var(--font-sans)). The protagonist is the accent "ink drop": the logo's graph node,
// drawn as a drop when it moves and as a node when it rests.

export const INTRO_W = 1920
export const INTRO_H = 1080
export const SCENE_LENGTH = 6.5
export const SCENE_COUNT = 4
export const INTRO_DURATION = SCENE_LENGTH * SCENE_COUNT

/** All visible words of the intro (from i18n onboarding.ts, so the copy lives in one place). */
export interface IntroCopy {
  scenes: { title: string; body: string; alt: string }[]
  pageA: string
  pageB: string
  peer: string
  backlink: string
  views: [string, string, string]
  statuses: [string, string, string]
  rows: [string, string, string, string]
  agent: string
  clients: string
  suggestion: string
  undo: string
  server: string
  offline: string
  openSource: string
  tagline: string
}

export interface SceneInfo {
  index: number
  /** seconds since the scene started */
  local: number
}

export function sceneAt(t: number): SceneInfo {
  const tt = Math.min(Math.max(t, 0), INTRO_DURATION - 1e-6)
  const index = Math.min(SCENE_COUNT - 1, Math.floor(tt / SCENE_LENGTH))
  return { index, local: tt - index * SCENE_LENGTH }
}

export const sceneStart = (i: number): number => Math.min(Math.max(i, 0), SCENE_COUNT - 1) * SCENE_LENGTH

/** The still of each scene for reduced motion: a moment where everything of the scene is on screen. */
export const STILL_TIMES: readonly number[] = [5.6, 6.5 + 5.2, 13 + 4.4, 19.5 + 2.6]

/** Caption opacity at t (the HTML captions and the full-frame captions use the same curve). */
export function captionOpacity(t: number): number {
  const { local } = sceneAt(t)
  if (t >= INTRO_DURATION - 1e-6) return 1
  return Math.min(seg(local, 0.15, 0.6), 1 - seg(local, SCENE_LENGTH - 0.35, SCENE_LENGTH))
}

// ---------------------------------------------------------------------------
// math helpers
// ---------------------------------------------------------------------------

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a))
const lerp = (a: number, b: number, p: number) => a + (b - a) * p
const out3 = (x: number) => 1 - Math.pow(1 - clamp(x), 3)
const inOut = (x: number) => {
  const v = clamp(x)
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2
}
/** Deterministic pseudo-random in [0, 1). */
const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}
/** Hand-drawn wobble: changes six times a second ("boiling" line), at most ±amp px. */
const jit = (seed: number, i: number, t: number, amp = 1.3) => (hash(seed * 131 + i * 17 + Math.floor(t * 6) * 7.13) - 0.5) * 2 * amp
const n1 = (v: number) => Math.round(v * 10) / 10

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const C = {
  app: 'var(--color-app)',
  side: 'var(--color-side)',
  line: 'var(--color-line)',
  ink: 'var(--color-ink)',
  sub: 'var(--color-sub)',
  accent: 'var(--color-accent)',
  soft: 'var(--color-accent-soft)',
}

// ---------------------------------------------------------------------------
// drawing primitives (strings)
// ---------------------------------------------------------------------------

/** A rounded rectangle whose corners wobble a little. */
function rRect(x: number, y: number, w: number, h: number, r: number, seed: number, t: number, style: string): string {
  const j = (i: number) => jit(seed, i, t)
  const rr = Math.min(r, w / 2, h / 2)
  const d = [
    `M${n1(x + rr + j(0))},${n1(y + j(1))}`,
    `L${n1(x + w - rr + j(2))},${n1(y + j(3))}`,
    `Q${n1(x + w + j(4))},${n1(y + j(5))} ${n1(x + w + j(6))},${n1(y + rr + j(7))}`,
    `L${n1(x + w + j(8))},${n1(y + h - rr + j(9))}`,
    `Q${n1(x + w + j(10))},${n1(y + h + j(11))} ${n1(x + w - rr + j(12))},${n1(y + h + j(13))}`,
    `L${n1(x + rr + j(14))},${n1(y + h + j(15))}`,
    `Q${n1(x + j(16))},${n1(y + h + j(17))} ${n1(x + j(18))},${n1(y + h - rr + j(19))}`,
    `L${n1(x + j(20))},${n1(y + rr + j(21))}`,
    `Q${n1(x + j(22))},${n1(y + j(23))} ${n1(x + rr + j(0))},${n1(y + j(1))}`,
    'Z',
  ].join(' ')
  return `<path d="${d}" style="${style}"/>`
}

/** A slightly bowed line. */
function rLine(x1: number, y1: number, x2: number, y2: number, seed: number, t: number, style: string): string {
  const mx = (x1 + x2) / 2 + jit(seed, 1, t, 2)
  const my = (y1 + y2) / 2 + jit(seed, 2, t, 2)
  return `<path d="M${n1(x1)},${n1(y1)} Q${n1(mx)},${n1(my)} ${n1(x2)},${n1(y2)}" style="fill:none;${style}"/>`
}

/** A text bar (a line of a document) drawn from the left as p goes 0 → 1. */
function bar(x: number, y: number, w: number, p: number, seed: number, t: number, color = C.line, h = 18): string {
  if (p <= 0) return ''
  return rRect(x, y, Math.max(h, w * out3(p)), h, h / 2, seed, t, `fill:${color}`)
}

function text(x: number, y: number, s: string, size: number, style: string, anchor: 'start' | 'middle' | 'end' = 'start', weight = 400): string {
  return `<text x="${n1(x)}" y="${n1(y)}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" style="font-family:var(--font-sans);${style}">${esc(s)}</text>`
}

/**
 * The ink drop. m = 0 a drop (tip up), m = 1 a round node; squash < 1 flattens it on landing.
 */
function drop(cx: number, cy: number, r: number, m: number, squash = 1, opacity = 1): string {
  if (opacity <= 0 || r <= 0) return ''
  const tip = lerp(1.65, 1, clamp(m))
  const k = lerp(0.35, 0.55, clamp(m))
  const d = [
    `M0,${n1(-r * tip)}`,
    `C${n1(r * k)},${n1(-r * tip * 0.62)} ${n1(r)},${n1(-r * 0.55)} ${n1(r)},0`,
    `A${n1(r)},${n1(r)} 0 0 1 ${n1(-r)},0`,
    `C${n1(-r)},${n1(-r * 0.55)} ${n1(-r * k)},${n1(-r * tip * 0.62)} 0,${n1(-r * tip)}`,
    'Z',
  ].join(' ')
  return `<g transform="translate(${n1(cx)},${n1(cy)}) scale(${n1(1 / Math.sqrt(squash) * 100) / 100},${n1(squash * 100) / 100})" opacity="${n1(opacity * 100) / 100}"><path d="${d}" fill="url(#ink-drop)"/><ellipse cx="${n1(-r * 0.32)}" cy="${n1(-r * 0.3)}" rx="${n1(r * 0.18)}" ry="${n1(r * 0.28)}" style="fill:var(--color-app);opacity:0.35"/></g>`
}

/** Opacity of a scene's own elements: fade in after it starts, out before it ends. */
const sceneFade = (local: number) => Math.min(seg(local, 0, 0.45), 1 - seg(local, SCENE_LENGTH - 0.45, SCENE_LENGTH))

// ---------------------------------------------------------------------------
// the drop's path through the whole intro
// ---------------------------------------------------------------------------

interface Key {
  t: number
  x: number
  y: number
  r: number
  m: number
}

// Where the drop is at each key time (between keys: eased).
const KEYS: Key[] = [
  { t: 0, x: 560, y: -60, r: 26, m: 0 },
  { t: 0.9, x: 560, y: 200, r: 26, m: 0 },
  { t: 1.3, x: 330, y: 279, r: 12, m: 1 },
  { t: 3.3, x: 330, y: 519, r: 12, m: 1 },
  { t: 3.7, x: 324, y: 608, r: 12, m: 1 },
  { t: 4.6, x: 324, y: 608, r: 14, m: 0.6 },
  { t: 5.6, x: 1190, y: 410, r: 14, m: 0.4 },
  { t: 6.2, x: 1190, y: 410, r: 14, m: 1 },
  // scene 2: the drop marks the view in use
  { t: 7.0, x: 620, y: 244, r: 12, m: 1 },
  { t: 8.7, x: 620, y: 244, r: 12, m: 1 },
  { t: 9.3, x: 880, y: 244, r: 12, m: 1 },
  { t: 10.7, x: 880, y: 244, r: 12, m: 1 },
  { t: 11.3, x: 1140, y: 244, r: 12, m: 1 },
  { t: 12.6, x: 1140, y: 244, r: 12, m: 1 },
  // scene 3: from the agent to the page along the connection, then onto the version line
  { t: 13.4, x: 1160, y: 380, r: 14, m: 0.3 },
  { t: 14.5, x: 1160, y: 380, r: 14, m: 0.3 },
  { t: 15.5, x: 870, y: 380, r: 14, m: 0.3 },
  { t: 16.0, x: 870, y: 380, r: 10, m: 1 },
  { t: 17.4, x: 760, y: 724, r: 12, m: 1 },
  { t: 18.0, x: 760, y: 724, r: 12, m: 1 },
  { t: 18.8, x: 560, y: 724, r: 12, m: 1 },
  { t: 19.4, x: 560, y: 724, r: 12, m: 1 },
  // scene 4: home on the server, out to the laptop, then a node of the logo
  { t: 20.2, x: 760, y: 236, r: 18, m: 0.5 },
  { t: 21.6, x: 760, y: 236, r: 18, m: 1 },
  { t: 22.4, x: 1300, y: 286, r: 14, m: 0.4 },
  { t: 23.4, x: 1300, y: 286, r: 14, m: 1 },
  { t: 24.4, x: 886, y: 454, r: 34, m: 1 },
  { t: 26, x: 886, y: 454, r: 34, m: 1 },
]

export function dropAt(t: number): { x: number; y: number; r: number; m: number; squash: number } {
  let i = 0
  while (i < KEYS.length - 2 && t >= KEYS[i + 1].t) i++
  const a = KEYS[i]
  const b = KEYS[i + 1]
  const p = inOut(seg(t, a.t, b.t))
  // the first fall is gravity, not eased in and out
  const pf = i === 0 ? Math.pow(seg(t, a.t, b.t), 2) : p
  // a short squash when it lands at the end of the fall and on the server
  const land = (at: number) => Math.max(0, 1 - Math.abs(t - at) / 0.25)
  const squash = 1 - 0.28 * Math.max(land(0.95), land(20.25))
  return { x: lerp(a.x, b.x, pf), y: lerp(a.y, b.y, pf), r: lerp(a.r, b.r, p), m: lerp(a.m, b.m, p), squash }
}

// ---------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------

function card(x: number, y: number, w: number, h: number, seed: number, t: number, title: string, opacity: number): string {
  return `<g opacity="${n1(opacity * 100) / 100}">${rRect(x + 6, y + 10, w, h, 22, seed + 1, t, 'fill:var(--color-line);opacity:0.55')}${rRect(x, y, w, h, 22, seed, t, `fill:${C.app};stroke:${C.ink};stroke-width:3`)}${text(x + 48, y + 74, title, 40, `fill:${C.ink}`, 'start', 700)}</g>`
}

function scene1(t: number, c: IntroCopy): string {
  const local = t
  const f = sceneFade(local)
  if (f <= 0) return ''
  let s = `<g opacity="${n1(f * 100) / 100}">`
  s += card(260, 140, 600, 560, 11, t, c.pageA, seg(local, 0.6, 1.1))
  // blocks appear line by line as the drop writes them
  const widths = [460, 400, 470, 360, 300]
  widths.forEach((w, i) => {
    s += bar(350, 270 + i * 60, w, seg(local, 1.3 + i * 0.4, 1.7 + i * 0.4), 20 + i, t)
  })
  // a check box on the fourth line, ticked
  const cb = seg(local, 2.9, 3.2)
  if (cb > 0) {
    s += rRect(306, 448, 26, 26, 6, 31, t, `fill:none;stroke:${C.ink};stroke-width:3;opacity:${n1(cb * 100) / 100}`)
    const tick = seg(local, 3.2, 3.5)
    if (tick > 0) s += `<path d="M311,461 L318,469 L329,452" pathLength="1" style="fill:none;stroke:${C.accent};stroke-width:4;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:${n1((1 - tick) * 100) / 100}"/>`
  }
  // the [[link]] chip, typed
  const full = `[[${c.pageB}]]`
  const typed = Math.round(full.length * seg(local, 3.6, 4.5))
  if (typed > 0) {
    const w = 44 + full.length * 22
    s += rRect(350, 584, w, 52, 12, 41, t, `fill:${C.soft}`)
    s += text(372, 620, full.slice(0, typed), 30, `fill:${C.accent}`, 'start', 600)
  }
  // a teammate's cursor on the fifth line
  const peer = seg(local, 2.2, 2.6)
  if (peer > 0) {
    const px = 350 + 300 * out3(seg(local, 2.6, 4.6))
    s += `<g opacity="${n1(peer * 100) / 100}"><rect x="${n1(px)}" y="500" width="4" height="34" rx="2" style="fill:${C.sub}"/>${rRect(px + 8, 466, 30 + c.peer.length * 16, 34, 10, 51, t, `fill:${C.sub}`)}${text(px + 22, 490, c.peer, 22, `fill:${C.app}`, 'start', 600)}</g>`
  }
  // the second page and the link drawing over to it
  s += card(1160, 220, 520, 400, 61, t, c.pageB, seg(local, 4.2, 4.8))
  const lb = seg(local, 4.6, 5.6)
  if (lb > 0) {
    const sx = 350 + 44 + full.length * 22
    s += `<path d="M${sx},610 C${sx + 260},610 ${1000 + jit(71, 1, t, 3)},410 1160,410" pathLength="1" style="fill:none;stroke:${C.accent};stroke-width:5;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:${n1((1 - lb) * 100) / 100}"/>`
  }
  ;[380, 300, 340].forEach((w, i) => {
    s += bar(1208, 340 + i * 56, w, seg(local, 4.8 + i * 0.15, 5.2 + i * 0.15), 80 + i, t)
  })
  const bl = seg(local, 5.4, 5.9)
  if (bl > 0) s += `<g opacity="${n1(bl * 100) / 100}">${rLine(1208, 540, 1630, 540, 91, t, `stroke:${C.line};stroke-width:2`)}${text(1208, 584, `← ${c.backlink}: ${c.pageA}`, 24, `fill:${C.sub}`)}</g>`
  return s + '</g>'
}

function scene2(t: number, c: IntroCopy): string {
  const local = t - SCENE_LENGTH
  const f = sceneFade(local)
  if (f <= 0) return ''
  let s = `<g opacity="${n1(f * 100) / 100}">`
  // the database frame and its view tabs
  s += rRect(360, 150, 1200, 580, 24, 101, t, `fill:${C.app};stroke:${C.ink};stroke-width:3`)
  const toBoard = inOut(seg(local, 2.2, 3.0))
  const toCal = inOut(seg(local, 4.2, 5.0))
  const active = toCal > 0.5 ? 2 : toBoard > 0.5 ? 1 : 0
  c.views.forEach((v, i) => {
    const x = 560 + i * 260
    const on = i === active
    s += rRect(x - 100 + 60, 166, 200, 56, 14, 110 + i, t, on ? `fill:${C.soft}` : `fill:${C.side}`)
    s += text(x + 60, 204, v, 28, `fill:${on ? C.accent : C.sub}`, 'middle', on ? 700 : 500)
  })
  // layouts: table rows, board cards, calendar chips
  const statusOf = [0, 1, 1, 2]
  const dayOf = [1, 3, 8, 10]
  const pillColor = [C.line, C.soft, C.accent]
  const tableAlpha = 1 - toBoard
  if (tableAlpha > 0) {
    s += `<g opacity="${n1(tableAlpha * 100) / 100}">${rLine(400, 300, 1520, 300, 121, t, `stroke:${C.line};stroke-width:2`)}${rLine(960, 250, 960, 700, 122, t, `stroke:${C.line};stroke-width:2`)}</g>`
  }
  const boardAlpha = Math.min(toBoard, 1 - toCal)
  if (boardAlpha > 0) {
    c.statuses.forEach((st, i) => {
      s += `<g opacity="${n1(boardAlpha * 100) / 100}">${text(420 + i * 380, 290, st, 28, `fill:${C.sub}`, 'start', 600)}</g>`
    })
  }
  if (toCal > 0) {
    let grid = ''
    for (let col = 0; col <= 7; col++) grid += rLine(400 + col * 160, 260, 400 + col * 160, 700, 130 + col, t, `stroke:${C.line};stroke-width:2`)
    for (let row = 0; row <= 2; row++) grid += rLine(400, 260 + row * 220, 1520, 260 + row * 220, 140 + row, t, `stroke:${C.line};stroke-width:2`)
    for (let d = 0; d < 14; d++) grid += text(412 + (d % 7) * 160, 296 + Math.floor(d / 7) * 220, String(d + 1), 22, `fill:${C.sub}`)
    s += `<g opacity="${n1(toCal * 100) / 100}">${grid}</g>`
  }
  const perStatus = [0, 0, 0]
  c.rows.forEach((title, i) => {
    const appear = out3(seg(local, 0.5 + i * 0.25, 0.9 + i * 0.25))
    if (appear <= 0) return
    const st = statusOf[i]
    const slot = perStatus[st]++
    const table = { x: 420, y: 320 + i * 92, w: 1080, h: 64 }
    const board = { x: 420 + st * 380, y: 316 + slot * 100, w: 340, h: 80 }
    const day = dayOf[i]
    const cal = { x: 410 + (day % 7) * 160, y: 316 + Math.floor(day / 7) * 220, w: 140, h: 48 }
    const a = { x: lerp(table.x, board.x, toBoard), y: lerp(table.y, board.y, toBoard), w: lerp(table.w, board.w, toBoard), h: lerp(table.h, board.h, toBoard) }
    const g = { x: lerp(a.x, cal.x, toCal), y: lerp(a.y, cal.y, toCal), w: lerp(a.w, cal.w, toCal), h: lerp(a.h, cal.h, toCal) }
    const size = lerp(28, 20, toCal)
    s += `<g opacity="${n1(appear * 100) / 100}">`
    s += rRect(g.x, g.y, g.w, g.h, 12, 150 + i, t, `fill:${toBoard > 0 ? C.side : C.app};stroke:${C.line};stroke-width:2`)
    const maxChars = toCal > 0.5 ? 6 : 24
    const label = title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title
    s += text(g.x + 18, g.y + g.h / 2 + size * 0.36, label, size, `fill:${C.ink}`, 'start', 500)
    const pill = 1 - toCal
    if (pill > 0) {
      const px = lerp(980, g.x + 18, toBoard)
      const py = lerp(g.y + 16, g.y + g.h - 4, toBoard)
      if (toBoard < 0.5) {
        s += `<g opacity="${n1(pill * 100) / 100}">${rRect(px, py, 160, 34, 17, 160 + i, t, `fill:${pillColor[st]}`)}${text(px + 80, py + 24, c.statuses[st], 20, `fill:${st === 2 ? C.app : C.ink}`, 'middle', 600)}</g>`
      }
    }
    s += '</g>'
  })
  return s + '</g>'
}

function scene3(t: number, c: IntroCopy): string {
  const local = t - SCENE_LENGTH * 2
  const f = sceneFade(local)
  if (f <= 0) return ''
  let s = `<g opacity="${n1(f * 100) / 100}">`
  s += card(260, 140, 600, 520, 201, t, c.pageB, 1)
  const undone = seg(local, 5.2, 5.8)
  const sug = seg(local, 2.8, 3.4) * (1 - undone)
  ;[460, 380, 500, 320].forEach((w, i) => {
    if (i === 2 && sug > 0) {
      s += `<g opacity="${n1(sug * 100) / 100}">${rRect(334, 429, 516 * out3(sug), 44, 10, 230, t, `fill:${C.soft}`)}${rRect(670, 380, 180, 40, 12, 231, t, `fill:${C.accent}`)}${text(760, 408, c.suggestion, 22, `fill:${C.app}`, 'middle', 700)}</g>`
    }
    s += bar(350, 290 + i * 76, w, seg(local, 0.2 + i * 0.1, 0.6 + i * 0.1), 210 + i, t, i === 2 && sug > 0 ? C.accent : C.line)
  })
  // the agent's panel
  s += rRect(1160, 200, 520, 380, 22, 240, t, `fill:${C.side};stroke:${C.ink};stroke-width:3`)
  s += text(1200, 262, `MCP · ${c.agent}`, 30, `fill:${C.ink}`, 'start', 700)
  const lines = ['find_context(…)', 'read_page(…)', 'patch_section(…)']
  lines.forEach((ln, i) => {
    const p = seg(local, 0.6 + i * 0.9, 1.2 + i * 0.9)
    if (p > 0) s += text(1200, 330 + i * 60, ln.slice(0, Math.ceil(ln.length * p)), 28, `fill:${i === 2 ? C.accent : C.sub};font-family:ui-monospace,SFMono-Regular,Menlo,monospace`)
  })
  s += text(1420, 640, c.clients, 26, `fill:${C.sub}`, 'middle')
  // the connection
  s += `<path d="M1160,380 L870,380" style="fill:none;stroke:${C.accent};stroke-width:4;stroke-dasharray:10 14;stroke-dashoffset:${n1(-local * 40)}"/>`
  // the version line under the page: v1 v2 v3, then undo back to v2
  s += rLine(320, 724, 820, 724, 250, t, `stroke:${C.line};stroke-width:4`)
  ;[360, 560, 760].forEach((x, i) => {
    const p = seg(local, 3.0 + i * 0.6, 3.3 + i * 0.6)
    if (p > 0) {
      const gone = i === 2 ? undone : 0
      s += `<g opacity="${n1(p * (1 - gone * 0.6) * 100) / 100}"><circle cx="${x}" cy="724" r="12" style="fill:${C.app};stroke:${C.ink};stroke-width:3"/>${text(x, 690, `v${i + 1}`, 22, `fill:${C.sub}`, 'middle')}</g>`
    }
  })
  const arc = seg(local, 4.9, 5.7)
  if (arc > 0) {
    s += `<path d="M760,746 C730,800 590,800 566,752" pathLength="1" style="fill:none;stroke:${C.accent};stroke-width:4;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:${n1((1 - arc) * 100) / 100}"/>`
    s += `<g opacity="${n1(arc * 100) / 100}">${text(660, 820, `↶ ${c.undo}`, 24, `fill:${C.accent}`, 'middle', 700)}</g>`
  }
  return s + '</g>'
}

function scene4(t: number, c: IntroCopy): string {
  const local = t - SCENE_LENGTH * 3
  const end = seg(local, 4.0, 4.6)
  const f = Math.min(seg(local, 0, 0.45), 1 - end)
  let s = ''
  if (f > 0) {
    s += `<g opacity="${n1(f * 100) / 100}">`
    // the server
    s += rRect(620, 260, 280, 360, 26, 301, t, `fill:${C.side};stroke:${C.ink};stroke-width:3`)
    for (let i = 0; i < 3; i++) {
      s += rLine(660, 340 + i * 90, 860, 340 + i * 90, 310 + i, t, `stroke:${C.line};stroke-width:6;stroke-linecap:round`)
      const led = hash(320 + i + Math.floor(t * 3)) > 0.4
      s += `<circle cx="680" cy="${370 + i * 90}" r="7" style="fill:${led ? C.accent : C.line}"/>`
    }
    s += text(760, 676, c.server, 30, `fill:${C.ink}`, 'middle', 700)
    // devices
    const dv = seg(local, 0.4, 0.9)
    s += `<g opacity="${n1(dv * 100) / 100}">`
    s += rRect(1100, 300, 400, 250, 18, 330, t, `fill:${C.app};stroke:${C.ink};stroke-width:3`)
    s += rRect(1060, 552, 480, 24, 10, 331, t, `fill:${C.ink}`)
    ;[300, 240, 280].forEach((w, i) => (s += bar(1140, 360 + i * 50, w, 1, 340 + i, t)))
    s += rRect(1590, 330, 150, 260, 24, 350, t, `fill:${C.app};stroke:${C.ink};stroke-width:3`)
    ;[90, 70].forEach((w, i) => (s += bar(1616, 390 + i * 44, w, 1, 352 + i, t)))
    s += '</g>'
    const link = seg(local, 0.7, 1.5)
    const off = seg(local, 3.0, 3.4)
    if (link > 0) {
      const style = `fill:none;stroke:${C.accent};stroke-width:4;stroke-linecap:round;opacity:${n1((1 - off * 0.75) * 100) / 100};stroke-dasharray:${off > 0 ? '6 14' : '1'};${off > 0 ? '' : `stroke-dashoffset:${n1((1 - link) * 100) / 100}`}`
      s += `<path d="M900,420 C990,420 1010,420 1100,420" pathLength="${off > 0 ? 220 : 1}" style="${style}"/>`
    }
    if (off > 0) {
      s += `<g opacity="${n1(off * 100) / 100}">${rRect(1180, 600, 240, 46, 23, 360, t, `fill:${C.soft}`)}${text(1300, 632, `⌁ ${c.offline}`, 24, `fill:${C.accent}`, 'middle', 700)}</g>`
    }
    const os = seg(local, 1.6, 2.1)
    if (os > 0) {
      s += `<g opacity="${n1(os * 100) / 100}">${rRect(330, 400, 240, 70, 18, 370, t, `fill:${C.app};stroke:${C.ink};stroke-width:3`)}${text(450, 446, `</> ${c.openSource}`, 26, `fill:${C.ink}`, 'middle', 700)}</g>`
    }
    s += '</g>'
  }
  // the closing card: the logo's two blocks and three nodes, the name and the line under it
  if (end > 0) {
    const b1 = out3(seg(local, 4.2, 4.9))
    const b2 = out3(seg(local, 4.4, 5.1))
    const lk = seg(local, 4.9, 5.4)
    s += `<g opacity="${n1(end * 100) / 100}">`
    // icon.svg's 512-unit layout, centered: bars at (128,128) and (128,200), nodes at (182,354) (290,300) (366,372)
    s += rRect(832, 228, 256 * b1, 34, 17, 401, t, `fill:${C.ink}`)
    s += rRect(832, 300, 176 * b2, 34, 17, 402, t, `fill:${C.ink};opacity:0.55`)
    if (lk > 0) {
      s += `<path d="M886,454 L994,400 L1070,472" pathLength="1" style="fill:none;stroke:url(#ink-line);stroke-width:18;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:${n1((1 - lk) * 100) / 100}"/>`
      s += `<circle cx="994" cy="400" r="${n1(25 * out3(seg(local, 5.0, 5.4)))}" fill="url(#ink-drop)"/>`
      s += `<circle cx="1070" cy="472" r="${n1(29 * out3(seg(local, 5.2, 5.6)))}" fill="url(#ink-drop)"/>`
    }
    const wm = seg(local, 5.2, 5.8)
    if (wm > 0) {
      s += `<g opacity="${n1(wm * 100) / 100}">${text(960, 650, 'Inkling', 110, `fill:${C.ink}`, 'middle', 800)}${text(960, 720, c.tagline, 36, `fill:${C.sub}`, 'middle', 500)}</g>`
    }
    s += '</g>'
  }
  return s
}

// ---------------------------------------------------------------------------
// captions inside the frame (the export stage); the app shows them as HTML instead
// ---------------------------------------------------------------------------

/** Rough width of a string in ems: CJK and full-width ≈ 1, other characters ≈ 0.55. */
function emWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 1 : 0.55
  return w
}

export function wrapLines(s: string, maxEm: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && emWidth(next) > maxEm) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

function captions(t: number, c: IntroCopy): string {
  const { index } = sceneAt(t)
  const o = captionOpacity(t)
  if (o <= 0) return ''
  const sc = c.scenes[index]
  let s = `<g opacity="${n1(o * 100) / 100}">`
  s += text(160, 880, sc.title, 60, `fill:${C.ink}`, 'start', 800)
  wrapLines(sc.body, 1600 / 34).slice(0, 2).forEach((ln, i) => {
    s += text(160, 940 + i * 48, ln, 34, `fill:${C.sub}`, 'start', 500)
  })
  // where we are: one dot per scene
  for (let i = 0; i < SCENE_COUNT; i++) s += `<circle cx="${1680 + i * 32}" cy="868" r="8" style="fill:${i === index ? C.accent : C.line}"/>`
  return s + '</g>'
}

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** 'art' = the picture only (the app shows captions as HTML); 'full' = 1920×1080 with captions. */
  frame: 'art' | 'full'
}

/** The art occupies x 200…1760, y 110…830 of the 1920×1080 frame; the captions sit under it in the full frame. */
export const ART_VIEWBOX = '200 110 1560 720'

/** The whole frame at time t, as SVG markup. Pure: the same t, copy and options give the same string. */
export function renderIntroFrame(t: number, copy: IntroCopy, opts: RenderOptions = { frame: 'art' }): string {
  const tt = Math.min(Math.max(t, 0), INTRO_DURATION)
  const full = opts.frame === 'full'
  const vb = full ? `0 0 ${INTRO_W} ${INTRO_H}` : ART_VIEWBOX
  const d = dropAt(tt)
  // The drop fades in only at the very start and stays to the end.
  const dropO = seg(tt, 0, 0.15)
  const body = [
    tt < SCENE_LENGTH ? scene1(tt, copy) : '',
    tt >= SCENE_LENGTH && tt < SCENE_LENGTH * 2 ? scene2(tt, copy) : '',
    tt >= SCENE_LENGTH * 2 && tt < SCENE_LENGTH * 3 ? scene3(tt, copy) : '',
    tt >= SCENE_LENGTH * 3 ? scene4(tt, copy) : '',
    drop(d.x, d.y, d.r, d.m, d.squash, dropO),
    full ? captions(tt, copy) : '',
  ].join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">` +
    `<defs><linearGradient id="ink-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--color-accent);stop-opacity:0.78"/><stop offset="1" style="stop-color:var(--color-accent)"/></linearGradient>` +
    `<linearGradient id="ink-line" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--color-accent);stop-opacity:0.78"/><stop offset="1" style="stop-color:var(--color-accent)"/></linearGradient></defs>` +
    (full ? `<rect x="0" y="0" width="${INTRO_W}" height="${INTRO_H}" style="fill:${C.app}"/>` : '') +
    body +
    '</svg>'
  )
}
