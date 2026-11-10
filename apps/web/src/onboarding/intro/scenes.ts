// The intro motion (docs/adr/2382-*, 2385-*): four scenes drawn as SVG by pure functions of the time t
// in seconds. Nothing here reads a clock, a random source or the DOM, and the SVG has no CSS animation
// or SMIL: the same t (and the same options) always gives the same markup. The in-app player moves t
// with requestAnimationFrame; a headless browser can seek frame by frame through
// `window.__inklingIntro.seek(t)` to render a promo video on the 1920×1080 stage.
//
// Each scene is drawn in its own 1920×1080 "world"; a camera (a viewBox per scene, eased between keys)
// pushes in on the scene's protagonist and pulls back out. Scenes change with an ink wipe that spreads
// from where the drop lands. The drop (the logo's accent node, with two eyes) hops between the things
// that matter and ends as a node of the logo.
//
// Colors are Inkling's own tokens (var(--color-*), the select option colours included), so the light
// and dark themes both work; text uses the UI font (var(--font-sans)), tool names the system monospace.

export const INTRO_W = 1920
export const INTRO_H = 1080
export const SCENE_LENGTH = 6.5
export const SCENE_COUNT = 4
export const INTRO_DURATION = SCENE_LENGTH * SCENE_COUNT

/** Every word drawn inside the pictures; the i18n key of each is `intro.<word>` (i18n onboarding.ts). */
export const INTRO_WORDS = [
  'pageA', 'pageB', 'peer1', 'peer2', 'goal', 'todo1', 'todo2', 'todo3', 'backlink', 'db', 'viewTable', 'viewBoard',
  'colName', 'colStatus', 'colOwner', 'todo', 'doing', 'done', 'row1', 'row2', 'row3', 'row4', 'agent', 'question',
  'secGoal', 'secDecision', 'secOverview', 'secSchedule', 'secOwner', 'schedule', 'decision', 'answer', 'clients',
  'notice', 'review', 'sugBadge', 'mode', 'by', 'added', 'accept', 'reject', 'undo', 'server', 'offline', 'synced',
] as const
export type IntroWord = (typeof INTRO_WORDS)[number]

/** All visible words of the intro (from i18n onboarding.ts, so the copy lives in one place). */
export interface IntroCopy {
  scenes: { title: string; body: string; alt: string }[]
  w: Record<IntroWord, string>
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

/** The still of each scene for reduced motion: the wide shot where everything of the scene is on screen. */
export const STILL_TIMES: readonly number[] = [6.15, 6.5 + 6.15, 13 + 6.15, 19.5 + 3.35]

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
/** Ease out with a small overshoot (chips and buttons pop). */
const back = (x: number) => {
  const v = clamp(x) - 1
  return 1 + 2.70158 * v * v * v + 1.70158 * v * v
}
/** Pop-in scale from time a: 0 before, overshoots a little, then 1. */
const popAt = (L: number, a: number, d = 0.3) => (L < a ? 0 : back(seg(L, a, a + d)))
/** Deterministic pseudo-random in [0, 1). */
const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}
/** Rough-ink wobble: changes twelve times a second ("boiling" line), at most ±amp. */
const jit = (seed: number, i: number, t: number, amp: number) => (hash(seed * 131 + i * 17 + Math.floor(t * 12) * 7.13) - 0.5) * 2 * amp
const n1 = (v: number) => Math.round(v * 10) / 10
const f2 = (v: number) => Math.round(v * 100) / 100

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
/** Status colours: the app's select option colours (lib/optionColors.ts dots): to do, in progress, done. */
const OPT = ['gray-400', 'orange-500', 'green-500']
const optBg = (k: number) => `color-mix(in srgb,var(--color-${OPT[k]}) 24%,var(--color-app))`
const optFg = (k: number) => `color-mix(in srgb,var(--color-${OPT[k]}) 62%,var(--color-ink))`
/** The two people's cursor colours. */
const P1 = 'var(--color-pink-500)'
const P2 = 'var(--color-blue-500)'
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace'

// ---------------------------------------------------------------------------
// drawing primitives (strings)
// ---------------------------------------------------------------------------

function op(o: number, inner: string): string {
  if (o <= 0.005 || !inner) return ''
  return o >= 0.995 ? inner : `<g opacity="${f2(o)}">${inner}</g>`
}
/** Scale `inner` about (cx, cy). */
function sc(cx: number, cy: number, s: number, inner: string): string {
  if (s <= 0.002 || !inner) return ''
  return Math.abs(s - 1) < 0.003 ? inner : `<g transform="translate(${n1(cx)},${n1(cy)}) scale(${f2(s)}) translate(${n1(-cx)},${n1(-cy)})">${inner}</g>`
}
const box = (x: number, y: number, w: number, h: number, rx: number, style: string) =>
  `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(Math.max(0, w))}" height="${n1(Math.max(0, h))}" rx="${n1(rx)}" style="${style}"/>`
const dot = (x: number, y: number, r: number, style: string) => `<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(r)}" style="${style}"/>`

interface TextOpts {
  a?: 'start' | 'middle' | 'end'
  w?: number
  mono?: boolean
  deco?: string
}
function text(x: number, y: number, s: string, size: number, fill: string, o: TextOpts = {}): string {
  if (!s) return ''
  const font = o.mono ? MONO : 'var(--font-sans)'
  return `<text x="${n1(x)}" y="${n1(y)}" font-size="${size}" font-weight="${o.w ?? 400}" text-anchor="${o.a ?? 'start'}" style="font-family:${font};fill:${fill}${o.deco ? `;text-decoration:${o.deco}` : ''}">${esc(s)}</text>`
}

/** Rough width of a string in ems: CJK and full-width ≈ 1, other characters ≈ 0.55. */
function emWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 1 : 0.55
  return w
}
const tw = (s: string, size: number, mono = false) => (mono ? Array.from(s).length * 0.6 : emWidth(s)) * size
/** The first p (0…1) of a string, by characters (typing). */
const typed = (s: string, p: number) => {
  const a = Array.from(s)
  return a.slice(0, Math.round(a.length * clamp(p))).join('')
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

/** A path drawn on as p goes 0 → 1. */
const drawOn = (d: string, p: number, style: string) =>
  p <= 0 ? '' : `<path d="${d}" pathLength="1" style="fill:none;${style};stroke-dasharray:1;stroke-dashoffset:${f2(1 - clamp(p))}"/>`

/** A rounded rectangle whose corners wobble by up to amp (the rough ink sketch). */
function roughRect(x: number, y: number, w: number, h: number, r: number, seed: number, t: number, amp: number, style: string): string {
  const j = (i: number) => jit(seed, i, t, amp)
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
    `Q${n1(x + j(22))},${n1(y + j(23))} ${n1(x + rr + j(0) + 6)},${n1(y + j(1) - 3)}`,
  ].join(' ')
  return `<path d="${d}" style="${style}"/>`
}

/**
 * The one protagonist per scene that is a rough ink sketch for a moment before it settles into the
 * tidy UI at time `at`: two boiling outlines that fade as the element (opacity `tidyAt`) fades in.
 */
function sketch(x: number, y: number, w: number, h: number, L: number, at: number, seed: number, t: number): string {
  const o = Math.min(seg(L, at - 0.32, at - 0.22), 1 - seg(L, at - 0.04, at + 0.12))
  if (o <= 0) return ''
  const st = (k: number) => `fill:none;stroke:${C.ink};stroke-width:${4 - k * 1.5};stroke-linecap:round;stroke-linejoin:round`
  return op(o, roughRect(x, y, w, h, 24, seed, t, 9, st(0)) + roughRect(x + 4, y - 3, w - 6, h + 4, 30, seed + 7, t, 13, st(1)))
}
const tidyAt = (L: number, at: number) => seg(L, at - 0.12, at + 0.04)

/** A page card: shadow, paper, border. */
const card = (x: number, y: number, w: number, h: number, fill = C.app) =>
  box(x + 3, y + 8, w, h, 22, `fill:${C.line};opacity:0.55`) + box(x, y, w, h, 22, `fill:${fill};stroke:${C.line};stroke-width:2.5`)

/** A status chip (select option look: tinted pill, coloured dot, label). Returns its width too. */
function statusChip(x: number, y: number, k: number, label: string, size: number): { s: string; w: number } {
  const h = size * 1.55
  const w = tw(label, size) + h * 1.25
  return {
    w,
    s: box(x, y, w, h, h / 2, `fill:${optBg(k)}`) + dot(x + h * 0.5, y + h / 2, size * 0.24, `fill:var(--color-${OPT[k]})`) + text(x + h * 0.85, y + h * 0.72, label, size, optFg(k), { w: 600 }),
  }
}

/** A remote person's text caret with their name tag. */
function caret(x: number, base: number, size: number, name: string, color: string, o: number): string {
  const top = base - size * 0.95
  const tagW = tw(name, 18) + 18
  return op(o, box(x, top, 3, size * 1.25, 1.5, `fill:${color}`) + box(x, top - 28, tagW, 27, 6, `fill:${color}`) + text(x + 9, top - 8, name, 18, C.app, { w: 700 }))
}

const avatar = (x: number, y: number, r: number, name: string, color: string) =>
  dot(x, y, r, `fill:${color}`) + text(x, y + r * 0.36, Array.from(name)[0] ?? '', r, C.app, { a: 'middle', w: 700 })

/** A tool call line in the agent panel, typed. */
const toolLine = (x: number, y: number, s: string, p: number, size: number, color = C.accent) => text(x, y, typed(s, p), size, color, { mono: true })

/** The agent panel's frame and title. */
const agentPanel = (x: number, y: number, w: number, h: number, title: string, size: number) =>
  box(x, y, w, h, 22, `fill:${C.side};stroke:${C.line};stroke-width:2.5`) +
  dot(x + 30, y + size * 1.55 - size * 0.34, 7, `fill:${C.accent}`) +
  text(x + 48, y + size * 1.55, title, size, C.ink, { w: 700 }) +
  box(x + 20, y + size * 2.3, w - 40, 2, 1, `fill:${C.line}`)

/** A point on the hop from a to b at eased progress e: a straight line lifted into an arc. */
function arcPt(ax: number, ay: number, bx: number, by: number, e: number): { x: number; y: number } {
  const lift = Math.min(170, Math.abs(bx - ax) * 0.28 + Math.abs(by - ay) * 0.08)
  return { x: lerp(ax, bx, e), y: lerp(ay, by, e) - lift * 4 * e * (1 - e) }
}

// ---------------------------------------------------------------------------
// the drop: one path per scene (world coordinates of that scene)
// ---------------------------------------------------------------------------

interface DropKey {
  t: number
  x: number
  y: number
  r?: number
  m?: number
  /** how it gets here from the key before: 'fall' (gravity), 'ride' (carried, no hop), default a hop */
  e?: 'fall' | 'ride'
}

// Logo geometry (public/icon.svg's 512-unit layout) placed in scene 4's world.
const LK = 0.9
const LX = 960 - 261.5 * LK
const LY = 450 - 264.5 * LK
const lg = (x: number, y: number) => ({ x: LX + x * LK, y: LY + y * LK })
const NODE = lg(182, 354)

const SCENE_DROP: DropKey[][] = [
  // 1: lands by the title, watches the tick, then the link, rides it to the linked page, then the view tabs
  [
    { t: 0.35, x: 200, y: 166 },
    { t: 1.15, x: 200, y: 166 },
    { t: 1.45, x: 200, y: 330 },
    { t: 1.85, x: 200, y: 330 },
    { t: 2.15, x: 200, y: 540 },
    { t: 3.2, x: 200, y: 540 },
    { t: 3.75, x: 1252, y: 335, m: 0.5 },
    { t: 4.05, x: 1252, y: 335 },
    { t: 4.75, x: 1040, y: 640 },
    { t: 6.2, x: 1040, y: 640 },
  ],
  // 2: lands on the agent's first tool call, jumps on the first section and rides it into the panel
  [
    { t: 0.35, x: 1090, y: 302 },
    { t: 2.1, x: 1090, y: 302 },
    { t: 2.4, x: 128, y: 286 },
    { t: 2.45, x: 128, y: 286 },
    { t: 3.25, x: 1072, y: 380 },
    { t: 3.45, x: 1072, y: 380 },
    { t: 3.7, x: 1090, y: 556 },
    { t: 4.0, x: 1090, y: 556 },
    { t: 4.35, x: 1090, y: 628 },
    { t: 6.2, x: 1090, y: 628 },
  ],
  // 3: the patch_section call, the review card, the new version, update_row, then rides the card
  [
    { t: 0.35, x: 974, y: 206 },
    { t: 1.3, x: 974, y: 206 },
    { t: 1.65, x: 180, y: 384 },
    { t: 2.75, x: 180, y: 384 },
    { t: 3.1, x: 520, y: 604 },
    { t: 4.0, x: 520, y: 604 },
    { t: 4.45, x: 140, y: 826 },
    { t: 4.85, x: 140, y: 826 },
    { t: 5.55, x: 402, y: 910, e: 'ride' },
    { t: 6.2, x: 402, y: 910 },
  ],
  // 4: home on the server, over to the laptop as the connection drops, then a node of the logo
  [
    { t: 0.35, x: 340, y: 218 },
    { t: 2.55, x: 340, y: 218 },
    { t: 2.95, x: 1040, y: 238 },
    { t: 4.7, x: 1040, y: 238 },
    { t: 5.25, x: NODE.x, y: NODE.y, r: 34 * LK, m: 1 },
    { t: SCENE_LENGTH, x: NODE.x, y: NODE.y, r: 34 * LK, m: 1 },
  ],
]
const DROP_R = 22
/** Every scene's keys with the fall in at the start and the leap out at the end. */
const DROP_KEYS: DropKey[][] = SCENE_DROP.map((k, i) => {
  const a = k[0]
  const z = k[k.length - 1]
  const out: DropKey[] = [{ t: 0, x: a.x, y: a.y - 760, m: 0 }, { ...a, e: 'fall' }, ...k.slice(1)]
  if (i < SCENE_COUNT - 1) out.push({ t: SCENE_LENGTH, x: z.x + 30, y: z.y - 900, m: 0, e: 'fall' })
  return out
})

/** The drop at t, in the world coordinates of the scene at t. */
export function dropAt(t: number): { x: number; y: number; r: number; m: number; squash: number } {
  const { index, local } = sceneAt(Math.min(Math.max(t, 0), INTRO_DURATION))
  const L = t >= INTRO_DURATION ? SCENE_LENGTH : local
  const keys = DROP_KEYS[index]
  let i = 0
  while (i < keys.length - 2 && L >= keys[i + 1].t) i++
  const a = keys[i]
  const b = keys[i + 1]
  const p = seg(L, a.t, b.t)
  const e = b.e === 'fall' ? (a.y > b.y ? 1 - (1 - p) * (1 - p) * (1 - p) : p * p) : inOut(p)
  const pt = b.e === 'fall' || b.e === 'ride' ? { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) } : arcPt(a.x, a.y, b.x, b.y, e)
  // landing: the latest key reached after a move squashes it and lets it wobble back
  let squash = 1
  for (let k = 1; k < keys.length; k++) {
    const kk = keys[k]
    if (kk.t > L) break
    const moved = Math.hypot(kk.x - keys[k - 1].x, kk.y - keys[k - 1].y) > 4 && kk.e !== 'ride'
    const d = L - kk.t
    if (moved && kk.y >= keys[k - 1].y - 400 && d < 0.42) squash = 1 - 0.3 * (1 - d / 0.42) * Math.cos(d * 17)
  }
  return {
    x: pt.x,
    y: pt.y,
    r: lerp(a.r ?? DROP_R, b.r ?? DROP_R, e),
    m: lerp(a.m ?? 1, b.m ?? 1, e),
    squash,
  }
}

/** Outline of the drop: m = 0 a drop (tip up), m = 1 a round node. */
function dropPath(r: number, m: number): string {
  const tip = lerp(1.65, 1, clamp(m))
  const k = lerp(0.35, 0.55, clamp(m))
  // at m = 1 the control points are a circle's (0.55 r), so the logo's node is round
  const ky = -r * tip * lerp(0.62, 1, clamp(m))
  return `M0,${n1(-r * tip)} C${n1(r * k)},${n1(ky)} ${n1(r)},${n1(-r * 0.55)} ${n1(r)},0 A${n1(r)},${n1(r)} 0 0 1 ${n1(-r)},0 C${n1(-r)},${n1(-r * 0.55)} ${n1(-r * k)},${n1(ky)} 0,${n1(-r * tip)} Z`
}

/** The drop in screen units: squash and stretch, a short ink tail, two eyes that look where it goes and blink. */
function dropMarkup(t: number, toS: (x: number, y: number) => { x: number; y: number }, s: number, eyes: number): string {
  const d = dropAt(t)
  const p = toS(d.x, d.y)
  const r = d.r * s
  if (r <= 0.5 || p.y < -6 * r) return ''
  const a = dropAt(t - 0.03)
  const b = dropAt(t + 0.03)
  const pa = toS(a.x, a.y)
  const pb = toS(b.x, b.y)
  const vx = (pb.x - pa.x) / 0.06
  const vy = (pb.y - pa.y) / 0.06
  const speed = Math.hypot(vx, vy)
  const fast = seg(speed, 300, 1600)
  let out = ''
  // the tail: where it was a moment ago, smaller and fainter
  if (fast > 0) {
    for (let k = 1; k <= 4; k++) {
      const q = dropAt(t - k * 0.028)
      const pq = toS(q.x, q.y)
      out += dot(pq.x, pq.y, r * (0.62 - k * 0.12), `fill:${C.accent};opacity:${f2(fast * (0.42 - k * 0.08))}`)
    }
  }
  // stretch along the way it moves (tip trailing), squash when it lands
  const rot = fast > 0 ? (Math.atan2(-vy, -vx) * 180) / Math.PI + 90 : 0
  const sy = d.squash * (1 + 0.32 * fast)
  const sx = 1 / Math.sqrt(sy)
  const m = d.m * (1 - fast * 0.7)
  const ground = fast > 0 ? 0 : r * (1 - sy)
  out +=
    `<g transform="translate(${n1(p.x)},${n1(p.y + ground)}) rotate(${n1(fast > 0 ? rot * fast : 0)}) scale(${f2(sx)},${f2(sy)})">` +
    `<path d="${dropPath(r, m)}" fill="url(#ink-drop)"/>` +
    `<ellipse cx="${n1(-r * 0.36)}" cy="${n1(-r * 0.42)}" rx="${n1(r * 0.13)}" ry="${n1(r * 0.2)}" style="fill:${C.app};opacity:0.4"/></g>`
  if (eyes > 0.01 && r > 7) {
    const v = Math.max(speed, 1)
    const gx = speed > 60 ? vx / v : 0.35
    const gy = speed > 60 ? vy / v : 0.2
    // blinks: a short close every 2.3 s, offset per scene
    const ph = (t + 0.8) % 2.3
    const blink = Math.max(0, 1 - Math.abs(ph - 2.1) / 0.07)
    const ex = r * 0.34
    const ry = Math.max(r * 0.17 * (1 - 0.88 * blink), r * 0.025)
    const rx = r * 0.13
    const ox = gx * r * 0.13
    const oy = -r * 0.04 + gy * r * 0.1 + ground * 0.6
    let e = ''
    for (const side of [-1, 1]) {
      e += `<ellipse cx="${n1(side * ex + ox)}" cy="${n1(oy)}" rx="${n1(rx)}" ry="${n1(ry)}" style="fill:${C.app}"/>`
      if (blink < 0.5) e += dot(side * ex + ox + rx * 0.3, oy - ry * 0.35, rx * 0.34, `fill:${C.ink}`)
    }
    out += op(eyes, `<g transform="translate(${n1(p.x)},${n1(p.y)})">${e}</g>`)
  }
  return out
}

// ---------------------------------------------------------------------------
// the camera: per scene, rectangles of that scene's world to show, eased between keys
// ---------------------------------------------------------------------------

type Rect = [number, number, number, number]
interface CamKey {
  /** move from the previous key during [a, b] (scene-local seconds) */
  a: number
  b: number
  r: Rect
  /** the point a narrow (phone) frame centres on */
  f: [number, number]
}
const CAMS: CamKey[][] = [
  [
    { a: 0, b: 0, r: [150, 80, 1040, 560], f: [520, 330] },
    { a: 1.75, b: 2.15, r: [150, 200, 1060, 520], f: [520, 500] },
    { a: 3.05, b: 3.45, r: [150, 110, 1700, 560], f: [1520, 380] },
    { a: 4.35, b: 4.85, r: [150, 600, 1030, 420], f: [500, 800] },
    { a: 5.75, b: 6.1, r: [120, 70, 1740, 960], f: [500, 800] },
  ],
  [
    { a: 0, b: 0, r: [1040, 90, 800, 560], f: [1440, 330] },
    { a: 1.75, b: 2.2, r: [90, 80, 1760, 880], f: [500, 430] },
    { a: 2.95, b: 3.35, r: [90, 80, 1760, 880], f: [1440, 420] },
    { a: 3.9, b: 4.35, r: [1080, 520, 760, 440], f: [1450, 680] },
    { a: 5.75, b: 6.1, r: [80, 70, 1780, 920], f: [1440, 680] },
  ],
  [
    { a: 0, b: 0, r: [80, 70, 1290, 660], f: [1150, 260] },
    { a: 0.95, b: 1.4, r: [90, 90, 1180, 640], f: [470, 330] },
    { a: 1.45, b: 1.8, r: [90, 90, 1180, 640], f: [500, 530] },
    { a: 2.7, b: 3.05, r: [90, 90, 1180, 620], f: [470, 470] },
    { a: 3.95, b: 4.4, r: [80, 700, 1290, 360], f: [470, 880] },
    { a: 5.75, b: 6.1, r: [60, 60, 1320, 1000], f: [470, 880] },
  ],
  [
    { a: 0, b: 0, r: [140, 180, 1680, 660], f: [340, 480] },
    { a: 1.0, b: 1.5, r: [140, 180, 1680, 660], f: [1040, 460] },
    { a: 2.45, b: 2.9, r: [560, 200, 860, 560], f: [1040, 460] },
    { a: 4.6, b: 5.3, r: [620, 190, 680, 590], f: [960, 480] },
  ],
]
/** Frames narrower than this aspect are "phone" frames: they centre on f instead of fitting the rect. */
const NARROW = 1.3
/** The widest piece of the world a phone frame shows (so the words in it stay readable). */
const PHONE_W = 700

function camAt(i: number, L: number): { r: Rect; f: [number, number] } {
  const ks = CAMS[i]
  let r = ks[0].r
  let f = ks[0].f
  for (let k = 1; k < ks.length; k++) {
    const p = inOut(seg(L, ks[k].a, ks[k].b))
    if (p <= 0) break
    r = r.map((v, j) => lerp(v, ks[k].r[j], p)) as Rect
    f = [lerp(f[0], ks[k].f[0], p), lerp(f[1], ks[k].f[1], p)]
  }
  return { r, f }
}

/** The world rectangle shown in a frame of aspect A (width / height). */
function viewRect(c: { r: Rect; f: [number, number] }, A: number): Rect {
  const [x, y, w, h] = c.r
  let vw = Math.max(w, h * A)
  let cx = x + w / 2
  let cy = y + h / 2
  if (A < NARROW) {
    vw = Math.min(PHONE_W, vw)
    cx = clamp(c.f[0], vw / 2, INTRO_W - vw / 2)
    cy = c.f[1]
  }
  const vh = vw / A
  return [cx - vw / 2, cy - vh / 2, vw, vh]
}

// ---------------------------------------------------------------------------
// scene 1: notes you write together (a page, two people, a [[link]], a database view in the page)
// ---------------------------------------------------------------------------

const S1_ROWS: { w: IntroWord; k: number; who: 1 | 2 }[] = [
  { w: 'row1', k: 1, who: 2 },
  { w: 'row2', k: 2, who: 1 },
  { w: 'row3', k: 0, who: 2 },
  { w: 'row4', k: 0, who: 1 },
]
const STATUS: IntroWord[] = ['todo', 'doing', 'done']

/** A board card with the row's title, its status chip and its owner. */
function boardCard(x: number, y: number, w: number, h: number, title: string, k: number, label: string, who: string, color: string): string {
  return (
    box(x, y, w, h, 12, `fill:${C.side};stroke:${C.line};stroke-width:2`) +
    text(x + 16, y + 30, title, 22, C.ink, { w: 600 }) +
    statusChip(x + 16, y + 40, k, label, 15).s +
    avatar(x + w - 24, y + 24, 13, who, color)
  )
}

function scene1(L: number, t: number, c: IntroCopy): string {
  const w = c.w
  const X = 240
  let s = sketch(160, 80, 1000, 910, L, 0.5, 11, t)
  let pg = card(160, 80, 1000, 910)
  pg += text(X, 178, w.pageA, 52, C.ink, { w: 800 })
  // who is here
  pg += avatar(1060, 140, 20, w.peer1, P1) + avatar(1104, 140, 20, w.peer2, P2)

  // the first person types the goal line
  const goalP = seg(L, 0.6, 1.7)
  const goalNow = typed(w.goal, goalP)
  pg += text(X, 262, goalNow, 32, C.ink)

  // three to-dos; the second person ticks the first
  const tick = seg(L, 1.3, 1.55)
  const strike = seg(L, 1.5, 1.75)
  ;(['todo1', 'todo2', 'todo3'] as const).forEach((k, i) => {
    const y = 336 + i * 58
    const done = i === 0 ? tick : 0
    pg += box(X, y - 24, 28, 28, 7, done > 0 ? `fill:${C.accent};stroke:${C.accent};stroke-width:2` : `fill:none;stroke:${C.sub};stroke-width:2`)
    if (done > 0) pg += drawOn(`M${X + 6},${y - 10} L${X + 12},${y - 3} L${X + 23},${y - 17}`, done, `stroke:${C.app};stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round`)
    pg += text(X + 46, y, w[k], 30, i === 0 && strike > 0.5 ? C.sub : C.ink)
    if (i === 0 && strike > 0) pg += drawOn(`M${X + 44},${y - 10} L${n1(X + 48 + tw(w[k], 30))},${y - 10}`, strike, `stroke:${C.sub};stroke-width:2.5`)
  })

  // the second person types a [[link: the menu offers the page, then it is a link
  const linkY = 548
  const prefix = Array.from(w.pageB).slice(0, Math.max(1, Math.ceil(Array.from(w.pageB).length / 2))).join('')
  const typing = `[[${prefix}`
  const tp = seg(L, 1.9, 2.3)
  const linked = L >= 3.15
  if (!linked && tp > 0) pg += text(X, linkY, typed(typing, tp), 30, C.ink)
  const menu = Math.min(popAt(L, 2.35, 0.25), 1 - seg(L, 3.1, 3.2))
  if (menu > 0 && !linked) {
    const mx = X + tw(typing, 30) - 30
    const mw = Math.max(280, tw(w.pageB, 26) + 96)
    pg += sc(mx, 566, menu, box(mx, 566, mw, 68, 12, `fill:${C.app};stroke:${C.line};stroke-width:2`) + box(mx + 8, 574, mw - 16, 52, 9, `fill:${C.soft}`) + box(mx + 24, 588, 18, 24, 3, `fill:none;stroke:${C.sub};stroke-width:2`) + text(mx + 56, 609, w.pageB, 26, C.ink, { w: 600 }))
  }
  const linkW = tw(w.pageB, 30)
  if (linked) {
    const lp = popAt(L, 3.15, 0.3)
    const glow = 1 - seg(L, 3.5, 4.2)
    pg += sc(X + linkW / 2, linkY - 10, lp, op(glow, box(X - 6, linkY - 30, linkW + 12, 42, 8, `fill:${C.soft}`)) + text(X, linkY, w.pageB, 30, C.accent, { w: 600 }) + `<path d="M${X},${linkY + 7} L${n1(X + linkW)},${linkY + 7}" style="stroke:${C.accent};stroke-width:2;stroke-dasharray:5 4;opacity:0.7"/>`)
  }

  // the carets: the first person at the end of the goal, the second at the to-do, then at the link
  const c1x = X + tw(goalNow, 32) + 4
  pg += caret(c1x, 262, 32, w.peer1, P1, seg(L, 0.55, 0.7))
  const onLink = L >= 1.85
  const c2x = onLink ? X + (linked ? linkW + 6 : tw(typed(typing, tp), 30) + 4) : X + 46 + tw(w.todo1, 30) + 6
  pg += caret(c2x, onLink ? linkY : 336, 30, w.peer2, P2, Math.min(seg(L, 0.75, 0.9), 1 - seg(L, 1.75, 1.8) + seg(L, 1.85, 1.9)))

  // the database view inside the page: a table that turns into a board
  const dbY = 652
  pg += box(X, dbY - 26, 26, 22, 4, `fill:none;stroke:${C.sub};stroke-width:2`) + `<path d="M${X},${dbY - 18} H${X + 26} M${X + 9},${dbY - 26} V${dbY - 4}" style="stroke:${C.sub};stroke-width:2"/>`
  pg += text(X + 40, dbY - 4, w.db, 30, C.ink, { w: 700 })
  const toBoard = inOut(seg(L, 5.0, 5.35))
  const tabX = [820, 820 + tw(w.viewTable, 24) + 40]
  pg += text(tabX[0], dbY - 6, w.viewTable, 24, toBoard < 0.5 ? C.ink : C.sub, { w: toBoard < 0.5 ? 700 : 500 })
  pg += text(tabX[1], dbY - 6, w.viewBoard, 24, toBoard >= 0.5 ? C.ink : C.sub, { w: toBoard >= 0.5 ? 700 : 500 })
  const ulX = lerp(tabX[0], tabX[1], toBoard)
  const ulW = lerp(tw(w.viewTable, 24), tw(w.viewBoard, 24), toBoard)
  pg += box(ulX, dbY + 4, ulW, 4, 2, `fill:${C.accent}`)
  const tableO = 1 - seg(L, 4.95, 5.2)
  pg += op(tableO, text(X + 16, dbY + 44, w.colName, 20, C.sub, { w: 600 }) + text(620, dbY + 44, w.colStatus, 20, C.sub, { w: 600 }) + text(900, dbY + 44, w.colOwner, 20, C.sub, { w: 600 }) + box(X, dbY + 56, 880, 2, 1, `fill:${C.line}`))
  const counts = [0, 0, 0]
  S1_ROWS.forEach((r) => counts[r.k]++)
  pg += op(
    seg(L, 5.5, 5.75),
    STATUS.map((k, i) => statusChip(X + i * 300, dbY + 26, i, w[k], 17).s + text(X + i * 300 + statusChip(0, 0, i, w[k], 17).w + 12, dbY + 46, String(counts[i]), 18, C.sub)).join(''),
  )
  const slot = [0, 0, 0]
  S1_ROWS.forEach((r, i) => {
    const p = inOut(seg(L, 5.0 + i * 0.07, 5.55 + i * 0.07))
    const sl = slot[r.k]++
    const tb = { x: X, y: dbY + 62 + i * 60, w: 880, h: 56 }
    const bd = { x: X + r.k * 300, y: dbY + 76 + sl * 86, w: 284, h: 74 }
    const x = lerp(tb.x, bd.x, p)
    const y = lerp(tb.y, bd.y, p) - Math.sin(Math.PI * p) * 26
    const ww = lerp(tb.w, bd.w, p)
    const hh = lerp(tb.h, bd.h, p)
    const who = r.who === 1 ? w.peer1 : w.peer2
    const col = r.who === 1 ? P1 : P2
    if (p <= 0) {
      pg += box(x, y, ww, hh, 0, `fill:${C.app}`) + box(x, y + hh - 2, ww, 2, 1, `fill:${C.line}`)
      pg += text(x + 16, y + 36, w[r.w], 24, C.ink) + statusChip(620, y + 13, r.k, w[STATUS[r.k]], 16).s + avatar(914, y + 28, 14, who, col)
    } else if (p >= 1) pg += boardCard(x, y, ww, hh, w[r.w], r.k, w[STATUS[r.k]], who, col)
    else {
      // in flight: the card's frame grows around the moving title, chip and owner
      pg += box(x, y, ww, hh, lerp(0, 12, p), `fill:${C.side};stroke:${C.line};stroke-width:2;opacity:${f2(0.4 + 0.6 * p)}`)
      pg += text(x + 16, y + lerp(36, 30, p), w[r.w], lerp(24, 22, p), C.ink, { w: p > 0.5 ? 600 : 400 })
      pg += op(1 - 0.85 * Math.sin(Math.PI * p), statusChip(lerp(620, x + 16, p), y + lerp(13, 40, p), r.k, w[STATUS[r.k]], lerp(16, 15, p)).s)
      pg += avatar(lerp(914, x + ww - 24, p), y + lerp(28, 24, p), lerp(14, 13, p), who, col)
    }
  })
  s += op(tidyAt(L, 0.5), pg)

  // the linked page, the link drawn over to it, and its backlink
  const bp = popAt(L, 3.35, 0.32)
  if (bp > 0) {
    let b = card(1250, 150, 580, 430)
    b += text(1290, 224, w.pageB, 40, C.ink, { w: 800 })
    b += text(1290, 292, w.secSchedule, 26, C.ink, { w: 700 }) + text(1290, 332, w.schedule, 24, C.ink)
    b += box(1290, 356, 340, 12, 6, `fill:${C.line}`)
    b += op(seg(L, 3.6, 3.85), box(1290, 470, 500, 2, 1, `fill:${C.line}`) + text(1290, 510, `← ${w.backlink}`, 22, C.sub) + text(1290, 548, w.pageA, 26, C.accent, { w: 600 }))
    s += sc(1540, 365, bp, b)
  }
  const lk = seg(L, 3.2, 3.7)
  if (lk > 0) {
    const sx = X + linkW + 12
    s += drawOn(`M${n1(sx)},${linkY - 10} C${n1(sx + 360)},${linkY - 10} 1060,335 1250,335`, lk, `stroke:${C.accent};stroke-width:5;stroke-linecap:round`)
  }
  return s
}

// ---------------------------------------------------------------------------
// scene 2: the agent reads (find_context picks sections, not pages)
// ---------------------------------------------------------------------------

interface Sect {
  /** the section block on the page */
  x: number
  y: number
  head: IntroWord
  body: IntroWord
  page: IntroWord
  /** where it lands in the agent panel */
  ty: number
  at: number
}
const S2_SECTS: Sect[] = [
  { x: 140, y: 276, head: 'secSchedule', body: 'schedule', page: 'pageB', ty: 336, at: 2.45 },
  { x: 140, y: 736, head: 'secDecision', body: 'decision', page: 'pageA', ty: 434, at: 2.6 },
]
const SECT_W = 800
const SLOT = { x: 1084, w: 712, h: 88 }

function scene2(L: number, t: number, c: IntroCopy): string {
  const w = c.w
  let s = ''
  const hi = seg(L, 2.0, 2.35)
  const dim = 1 - 0.55 * hi
  // the pages
  const pages = (pg: IntroWord, y: number, h: number, secs: [IntroWord, IntroWord | null][]) => {
    let p = card(120, y, 840, h)
    p += text(160, y + 66, w[pg], 40, C.ink, { w: 800 })
    secs.forEach(([head, body], i) => {
      const sy = y + 130 + i * 112
      const inHi = body !== null
      let block = text(160, sy, w[head], 26, C.ink, { w: 700 })
      block += body ? text(160, sy + 40, w[body], 26, C.ink) : box(160, sy + 22, 420 - i * 60, 13, 6.5, `fill:${C.line}`) + box(160, sy + 46, 300, 13, 6.5, `fill:${C.line}`)
      if (inHi) p += op(hi, box(140, sy - 34, SECT_W, 90, 12, `fill:${C.soft}`) + box(140, sy - 34, 6, 90, 3, `fill:${C.accent}`))
      p += op(inHi ? 1 : dim, block)
    })
    return p
  }
  let left = pages('pageB', 100, 440, [
    ['secOverview', null],
    ['secSchedule', 'schedule'],
    ['secOwner', null],
  ])
  left += pages('pageA', 590, 400, [
    ['secGoal', null],
    ['secDecision', 'decision'],
  ])
  s += op(seg(L, 0.45, 0.75), left)

  // the agent panel
  const PX = 1060
  s += sketch(PX, 90, 760, 860, L, 0.5, 21, t)
  let pn = agentPanel(PX, 90, 760, 860, `MCP · ${w.agent}`, 28)
  // the person's question
  const qW = Math.min(680, tw(w.question, 26) + 44)
  const qp = popAt(L, 0.55, 0.25)
  pn += sc(1800 - qW / 2, 230, qp, box(1800 - qW, 200, qW, 58, 18, `fill:${C.soft}`) + text(1800 - qW + 22, 238, typed(w.question, seg(L, 0.6, 1.35)), 26, C.ink))
  pn += toolLine(1124, 312, 'find_context(…)', seg(L, 1.45, 1.9), 26)
  // the sections, once landed
  S2_SECTS.forEach((sc0, i) => {
    if (L < sc0.at + 0.8) return
    pn += sectBlock(SLOT.x, sc0.ty, SLOT.w, i, sc0, w, 1)
  })
  pn += toolLine(1120, 566, 'read_page(…)', seg(L, 3.5, 3.85), 26, C.sub)
  // the answer, with where it came from
  const ans = wrapLines(w.answer, 640 / 26)
  const ansO = seg(L, 4.1, 4.25)
  const ansH = 34 + ans.length * 38
  const total = Array.from(w.answer).length
  let used = 0
  let at = ''
  ans.forEach((ln, i) => {
    const n = Array.from(ln).length
    const p = clamp((seg(L, 4.2, 5.0) * total - used) / n)
    used += n + 1
    at += text(1124, 636 + i * 38, typed(ln, p), 26, C.ink)
  })
  pn += op(ansO, box(1084, 596, 712, ansH, 16, `fill:${C.app};stroke:${C.line};stroke-width:2`) + at)
  let cx = 1090
  S2_SECTS.forEach((sc0, i) => {
    const label = `[${i + 1}] ${w[sc0.page]} › ${w[sc0.head]}`
    const cw = tw(label, 20) + 28
    const p = popAt(L, 5.0 + i * 0.12, 0.28)
    pn += sc(cx + cw / 2, 620 + ansH, p, box(cx, 600 + ansH, cw, 38, 19, `fill:${C.app};stroke:${C.accent};stroke-width:2`) + text(cx + 14, 626 + ansH, label, 20, C.accent, { w: 600 }))
    cx += cw + 12
  })
  s += op(tidyAt(L, 0.5), pn)
  s += op(seg(L, 0.7, 1.0), text(1440, 1010, w.clients, 26, C.sub, { a: 'middle' }))

  // the sections in flight: from their page into the panel
  S2_SECTS.forEach((sc0, i) => {
    const p = inOut(seg(L, sc0.at, sc0.at + 0.8))
    if (p <= 0 || p >= 1) return
    const pt = arcPt(sc0.x, sc0.y - 34, SLOT.x, sc0.ty, p)
    s += `<g opacity="${f2(0.6 + 0.4 * p)}">${sectBlock(pt.x, pt.y, lerp(SECT_W, SLOT.w, p), i, sc0, w, p)}</g>`
  })
  return s
}

/** A section as the agent receives it: "[n] Page › Heading" and its text, on an accent band. */
function sectBlock(x: number, y: number, bw: number, i: number, sc0: Sect, w: Record<IntroWord, string>, p: number): string {
  return (
    box(x, y, bw, SLOT.h, 12, `fill:${C.soft}`) +
    box(x, y, 6, SLOT.h, 3, `fill:${C.accent}`) +
    op(p, text(x + 22, y + 30, `[${i + 1}] ${w[sc0.page]} › ${w[sc0.head]}`, 20, C.accent, { w: 600 })) +
    text(x + 22, y + 68, w[sc0.body], 24, C.ink)
  )
}

// ---------------------------------------------------------------------------
// scene 3: the agent edits, a person decides (a suggestion accepted; a row moved by update_row)
// ---------------------------------------------------------------------------

const S3_BOARD = [
  { w: 'row3' as IntroWord, k: 0, who: 2 },
  { w: 'row4' as IntroWord, k: 0, who: 1 },
  { w: 'row1' as IntroWord, k: 1, who: 2 },
  { w: 'row2' as IntroWord, k: 2, who: 1 },
]

function scene3(L: number, t: number, c: IntroCopy): string {
  const w = c.w
  let s = ''
  // the page: a suggestion arrives (the notice and the section's badge), a person reviews it
  let pg = card(100, 90, 800, 620)
  const sug = Math.min(popAt(L, 1.05, 0.28), 1 - seg(L, 2.75, 2.95))
  const press1 = Math.max(0, 1 - Math.abs(L - 1.42) / 0.08)
  pg += sc(500, 140, sug, box(126, 112, 748, 52, 12, `fill:${C.soft};stroke:${C.accent};stroke-width:1.5;stroke-opacity:0.45`) + text(150, 146, `✎  ${w.notice}`, 22, C.ink) + sc(830, 140, 1 - 0.1 * press1, text(850, 146, w.review, 22, C.accent, { a: 'end', w: 700 })))
  pg += text(140, 240, w.pageB, 44, C.ink, { w: 800 })
  pg += text(140, 314, w.secSchedule, 30, C.ink, { w: 700 })
  const bx = 140 + tw(w.secSchedule, 30) + 18
  const bw = tw(w.sugBadge, 18) + 24
  pg += sc(bx + bw / 2, 303, sug, box(bx, 288, bw, 30, 15, `fill:${C.soft}`) + text(bx + 12, 309, w.sugBadge, 18, C.accent, { w: 700 }))
  pg += text(140, 362, w.schedule, 26, C.ink)
  // accepted: the sentence is in the page, its highlight settles
  const acc = seg(L, 2.8, 3.0)
  if (acc > 0) {
    const glow = 1 - seg(L, 3.6, 4.4)
    pg += op(acc, op(glow, box(128, 384, Math.min(756, tw(w.added, 26) + 24), 46, 8, `fill:${C.soft}`)) + text(140, 416, w.added, 26, C.ink))
  }
  pg += box(140, 470, 380, 13, 6.5, `fill:${C.line}`) + box(140, 500, 300, 13, 6.5, `fill:${C.line}`)
  // versions: v1, v2, then v3 when the suggestion is accepted, and Revert for a moment
  pg += box(140, 638, 680, 3, 1.5, `fill:${C.line}`)
  ;[200, 360, 520].forEach((x, i) => {
    const p = i < 2 ? 1 : popAt(L, 3.0, 0.3)
    pg += sc(x, 639, p, dot(x, 639, 12, i === 2 ? `fill:${C.accent}` : `fill:${C.app};stroke:${C.sub};stroke-width:3`) + text(x, 676, `v${i + 1}`, 22, C.sub, { a: 'middle' }))
  })
  const uw = tw(w.undo, 22) + 58
  const up = Math.min(popAt(L, 3.15, 0.3), 1 - seg(L, 4.5, 4.7))
  pg += sc(580 + uw / 2, 639, up, box(580, 619, uw, 40, 20, `fill:${C.soft}`) + `<path d="M603,646 a10,10 0 1 0 -2,-12 M597,630 l4,5 l5,-4" style="fill:none;stroke:${C.accent};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>` + text(622, 647, w.undo, 22, C.accent, { w: 700 }))
  s += pg

  // the review (a dialog over the page): the suggested sentence, Reject and Accept
  const RX = 170
  const RY = 392
  const rc = Math.min(tidyAt(L, 1.6), 1 - seg(L, 2.65, 2.9))
  s += sketch(RX, RY, 660, 330, L, 1.6, 31, t)
  if (rc > 0) {
    let r = box(RX + 4, RY + 12, 660, 330, 22, `fill:${C.ink};opacity:0.16`) + box(RX, RY, 660, 330, 22, `fill:${C.app};stroke:${C.line};stroke-width:2.5`)
    r += text(RX + 26, RY + 46, `${w.secSchedule} · ${w.mode}`, 22, C.ink, { w: 700 })
    r += text(RX + 26, RY + 78, w.by, 19, C.sub)
    r += box(RX + 20, RY + 98, 620, 118, 10, `fill:${C.soft}`) + text(RX + 38, RY + 140, '+', 26, C.accent, { w: 700 })
    const lines = wrapLines(w.added, 540 / 24).slice(0, 3)
    const total = Array.from(w.added).length
    let used = 0
    lines.forEach((ln, i) => {
      const n = Array.from(ln).length
      const p = clamp((seg(L, 1.7, 2.05) * total - used) / n)
      used += n + 1
      r += text(RX + 66, RY + 140 + i * 36, typed(ln, p), 24, C.ink)
    })
    const press = Math.max(0, 1 - Math.abs(L - 2.52) / 0.1)
    r += box(RX + 380, RY + 254, 120, 52, 10, `fill:${C.app};stroke:${C.line};stroke-width:2`) + text(RX + 440, RY + 288, w.reject, 22, C.ink, { a: 'middle', w: 600 })
    r += sc(RX + 576, RY + 280, 1 - 0.07 * press, box(RX + 514, RY + 254, 124, 52, 10, `fill:${C.accent}`) + text(RX + 576, RY + 288, w.accept, 22, C.app, { a: 'middle', w: 700 }))
    s += op(rc, r)
  }
  // the person's pointer: Review in the notice, then Accept
  const m1 = inOut(seg(L, 1.0, 1.35))
  const m2 = inOut(seg(L, 1.95, 2.4))
  const po = Math.min(seg(L, 0.95, 1.05), 1 - seg(L, 2.75, 2.9))
  const px = lerp(lerp(700, 836, m1), RX + 586, m2)
  const py = lerp(lerp(300, 142, m1), RY + 288, m2)
  s += op(po, `<path d="M${n1(px)},${n1(py)} l0,34 l9,-8 l7,15 l7,-3 l-7,-15 l12,-1 Z" style="fill:${C.ink};stroke:${C.app};stroke-width:2;stroke-linejoin:round"/>`)

  // the agent panel: patch_section, later update_row
  s += agentPanel(950, 90, 400, 950, `MCP · ${w.agent}`, 24)
  s += toolLine(1000, 214, 'patch_section(…)', seg(L, 0.45, 1.0), 24)
  s += toolLine(1000, 834, 'update_row(…)', seg(L, 4.2, 4.62), 24)

  // the board from scene 1: update_row moves a card to "in progress"
  s += card(100, 730, 800, 310)
  s += text(126, 776, `${w.db} · ${w.viewBoard}`, 24, C.ink, { w: 700 })
  STATUS.forEach((k, i) => (s += statusChip(120 + i * 262, 794, i, w[k], 16).s))
  const mv = inOut(seg(L, 4.85, 5.55))
  const changed = L >= 4.95
  const CW = 248
  let moved = ''
  S3_BOARD.forEach((r, i) => {
    const who = r.who === 1 ? w.peer1 : w.peer2
    const col = r.who === 1 ? P1 : P2
    if (i === 0) {
      const x = lerp(120, 382, mv)
      const y = lerp(834, 918, mv)
      const k = changed ? 1 : 0
      moved = sc(x + CW / 2, y + 37, 1 + 0.05 * Math.sin(Math.PI * mv), boardCard(x, y, CW, 74, w[r.w], k, w[STATUS[k]], who, col))
      const flash = Math.max(0, 1 - Math.abs(L - 5.0) / 0.25)
      if (flash > 0) moved += op(flash, box(x - 4, y - 4, CW + 8, 82, 14, `fill:none;stroke:${C.accent};stroke-width:3`))
      return
    }
    // the card under the moved one closes the gap
    const y = r.k === 0 ? 834 + 84 * (1 - mv) : 834
    s += boardCard(120 + r.k * 262, y, CW, 74, w[r.w], r.k, w[STATUS[r.k]], who, col)
  })
  return s + moved
}

// ---------------------------------------------------------------------------
// scene 4: on your own server (sync, offline, back in sync), then the logo
// ---------------------------------------------------------------------------

function scene4(L: number, t: number, c: IntroCopy): string {
  const w = c.w
  const away = 1 - seg(L, 4.55, 4.95)
  let s = ''
  if (away > 0) {
    let a = ''
    // the server, yours (a lock: your data)
    a += sketch(160, 240, 360, 520, L, 0.5, 41, t)
    let sv = box(160, 240, 360, 520, 26, `fill:${C.side};stroke:${C.ink};stroke-width:2.5`)
    for (let i = 0; i < 3; i++) {
      sv += box(200, 300 + i * 130, 280, 90, 12, `fill:${C.app};stroke:${C.line};stroke-width:2`)
      const on = hash(320 + i + Math.floor(t * 4)) > 0.35
      sv += dot(232, 345 + i * 130, 8, `fill:${on ? C.accent : C.line}`) + box(260, 340 + i * 130, 180, 10, 5, `fill:${C.line}`)
    }
    sv += box(470, 212, 44, 36, 7, `fill:${C.ink}`) + `<path d="M480,214 v-10 a12,12 0 0 1 24,0 v10" style="fill:none;stroke:${C.ink};stroke-width:5"/>` + dot(492, 228, 5, `fill:${C.side}`)
    sv += text(340, 820, w.server, 34, C.ink, { a: 'middle', w: 700 })
    a += op(tidyAt(L, 0.5), sv)
    // the laptop and the phone, each with the page
    const dv = popAt(L, 0.6, 0.35)
    let lp = box(720, 260, 640, 400, 20, `fill:${C.app};stroke:${C.ink};stroke-width:2.5`) + box(680, 660, 720, 26, 12, `fill:${C.ink}`)
    lp += text(760, 326, w.pageB, 34, C.ink, { w: 800 }) + text(760, 384, w.secSchedule, 24, C.ink, { w: 700 }) + text(760, 420, w.schedule, 24, C.ink)
    lp += text(760, 462, w.added, 20, C.sub) + box(760, 490, 360, 12, 6, `fill:${C.line}`) + box(760, 516, 280, 12, 6, `fill:${C.line}`)
    a += sc(1040, 470, dv, lp)
    let ph = box(1500, 280, 260, 460, 30, `fill:${C.app};stroke:${C.ink};stroke-width:2.5`) + box(1590, 296, 80, 8, 4, `fill:${C.line}`)
    ph += text(1526, 350, w.pageB, 24, C.ink, { w: 800 }) + text(1526, 388, w.secSchedule, 18, C.ink, { w: 700 })
    ph += box(1526, 404, 190, 10, 5, `fill:${C.line}`) + box(1526, 426, 160, 10, 5, `fill:${C.line}`) + box(1526, 448, 180, 10, 5, `fill:${C.line}`)
    a += sc(1630, 510, popAt(L, 0.72, 0.35), ph)
    // the connections and what travels on them
    const ln = seg(L, 0.85, 1.25)
    const off = L >= 2.6 && L < 3.7
    const L1 = 'M520,470 L720,470'
    const L2 = 'M1360,500 L1500,500'
    if (off) {
      a += `<path d="${L1}" style="fill:none;stroke:${C.sub};stroke-width:4;stroke-dasharray:8 12;opacity:0.7"/>`
      a += sc(620, 470, popAt(L, 2.6, 0.25), `<path d="M606,452 l28,36 M634,452 l-28,36" style="stroke:${C.ink};stroke-width:4;stroke-linecap:round"/>`)
    } else a += drawOn(L1, L >= 3.7 ? seg(L, 3.7, 3.85) : ln, `stroke:${C.accent};stroke-width:4;stroke-linecap:round`)
    a += drawOn(L2, ln, `stroke:${off ? C.sub : C.accent};stroke-width:4;stroke-linecap:round${off ? ';opacity:0.6' : ''}`)
    const pulses: [number, number, number, number, number][] = [
      // [start, end, x from, x to, y]
      [1.25, 1.65, 520, 720, 470],
      [1.55, 1.85, 1360, 1500, 500],
      [1.9, 2.2, 1500, 1360, 500],
      [2.15, 2.5, 720, 520, 470],
      [3.8, 4.15, 520, 720, 470],
    ]
    for (const [a0, a1, x0, x1, y] of pulses) {
      const p = seg(L, a0, a1)
      if (p > 0 && p < 1) a += dot(lerp(x0, x1, inOut(p)), y, 9, `fill:${C.accent}`) + dot(lerp(x0, x1, inOut(p)), y, 16, `fill:${C.accent};opacity:0.25`)
    }
    // offline: the page stays; back online: synced
    const chip = (label: string, at: number, end: number, accent: boolean) => {
      const cw = tw(label, 24) + 52
      const p = Math.min(popAt(L, at, 0.3), 1 - seg(L, end, end + 0.15))
      return sc(1330 - cw / 2, 300, p, box(1330 - cw, 280, cw, 44, 22, accent ? `fill:${C.soft}` : `fill:${C.side};stroke:${C.sub};stroke-width:2`) + dot(1330 - cw + 22, 302, 6, `fill:${accent ? C.accent : C.sub}`) + text(1330 - cw + 38, 310, label, 24, accent ? C.accent : C.ink, { w: 700 }))
    }
    a += chip(w.offline, 2.7, 3.7, false)
    a += chip(w.synced, 3.95, 9, true)
    s += op(away, a)
  }

  // the logo: two blocks, the graph, the name
  if (L > 4.75) {
    const b1 = out3(seg(L, 4.85, 5.35))
    const b2 = out3(seg(L, 5.0, 5.5))
    const p1 = lg(128, 128)
    const p2 = lg(128, 200)
    s += box(p1.x, p1.y, 256 * LK * b1, 34 * LK, 17 * LK, `fill:${C.ink};opacity:0.92`)
    s += box(p2.x, p2.y, 176 * LK * b2, 34 * LK, 17 * LK, `fill:${C.ink};opacity:0.5`)
    const n2 = lg(290, 300)
    const n3 = lg(366, 372)
    s += drawOn(`M${n1(NODE.x)},${n1(NODE.y)} L${n1(n2.x)},${n1(n2.y)} L${n1(n3.x)},${n1(n3.y)}`, seg(L, 5.25, 5.6), `stroke:url(#ink-line);stroke-width:${n1(18 * LK)};stroke-linecap:round;stroke-linejoin:round`)
    s += dot(n2.x, n2.y, 25 * LK * popAt(L, 5.4, 0.3), 'fill:url(#ink-drop)') + dot(n3.x, n3.y, 29 * LK * popAt(L, 5.55, 0.3), 'fill:url(#ink-drop)')
    const wm = seg(L, 5.55, 5.95)
    s += op(wm, `<g transform="translate(0,${n1((1 - out3(wm)) * 24)})">${text(960, 720, 'Inkling', 110, C.ink, { a: 'middle', w: 800 })}</g>`)
  }
  return s
}

const SCENES = [scene1, scene2, scene3, scene4]

// ---------------------------------------------------------------------------
// the ink wipe between scenes
// ---------------------------------------------------------------------------

/** A wobbly round blob of radius R around (cx, cy). */
function blob(cx: number, cy: number, R: number, seed: number): string {
  const N = 22
  const pts: [number, number][] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const k = 1 + 0.06 * Math.sin(a * 3 + seed) + 0.04 * Math.sin(a * 7 + seed * 2) + 0.03 * (hash(i * 2.7 + seed * 5) - 0.5)
    pts.push([cx + Math.cos(a) * R * k, cy + Math.sin(a) * R * k])
  }
  let d = ''
  for (let i = 0; i <= N; i++) {
    const p = pts[i % N]
    const q = pts[(i + 1) % N]
    const mx = (p[0] + q[0]) / 2
    const my = (p[1] + q[1]) / 2
    d += i === 0 ? `M${n1(mx)},${n1(my)}` : ` Q${n1(p[0])},${n1(p[1])} ${n1(mx)},${n1(my)}`
  }
  return d + ' Z'
}

const WIPE_A = 0.35
const WIPE_B = 0.95

// ---------------------------------------------------------------------------
// captions inside the frame (the export stage); the app shows them as HTML instead
// ---------------------------------------------------------------------------

function captions(t: number, c: IntroCopy): string {
  const { index } = sceneAt(t)
  const o = captionOpacity(t)
  if (o <= 0) return ''
  const sc0 = c.scenes[index]
  let s = text(160, 916, sc0.title, 60, C.ink, { w: 800 })
  wrapLines(sc0.body, 1600 / 34)
    .slice(0, 2)
    .forEach((ln, i) => (s += text(160, 976 + i * 46, ln, 34, C.sub, { w: 500 })))
  for (let i = 0; i < SCENE_COUNT; i++) s += dot(1680 + i * 32, 900, 8, `fill:${i === index ? C.accent : C.line}`)
  return op(o, s)
}

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** 'art' = the picture only (the app shows captions as HTML); 'full' = 1920×1080 with captions. */
  frame: 'art' | 'full'
  /** 'art' only: width / height of the box the picture fills (the camera frames for it). Default 2. */
  aspect?: number
}

/** Height of the picture on the 1920×1080 full frame; the captions sit under it. */
const FULL_ART_H = 860

/** The whole frame at time t, as SVG markup. Pure: the same t, copy and options give the same string. */
export function renderIntroFrame(t: number, copy: IntroCopy, opts: RenderOptions = { frame: 'art' }): string {
  const tt = Math.min(Math.max(t, 0), INTRO_DURATION)
  const full = opts.frame === 'full'
  const A = full ? INTRO_W / FULL_ART_H : clamp(opts.aspect && Number.isFinite(opts.aspect) ? opts.aspect : 2, 0.4, 3.5)
  const FW = full ? INTRO_W : 1600
  const FH = full ? FULL_ART_H : Math.round(FW / A)
  const { index, local } = sceneAt(tt)
  const L = tt >= INTRO_DURATION ? SCENE_LENGTH : local
  const vr = viewRect(camAt(index, L), A)
  const s = FW / vr[2]
  const toS = (x: number, y: number) => ({ x: (x - vr[0]) * s, y: (y - vr[1]) * s })
  const layer = (i: number, li: number, r: Rect) =>
    `<svg x="0" y="0" width="${FW}" height="${FH}" viewBox="${r.map(n1).join(' ')}" preserveAspectRatio="xMidYMid slice">${SCENES[i](li, i * SCENE_LENGTH + li, copy)}</svg>`

  let art = ''
  if (L < WIPE_B) {
    // under the ink: the scene before, held on its last frame
    if (index > 0) art += layer(index - 1, SCENE_LENGTH - 1e-3, viewRect(camAt(index - 1, SCENE_LENGTH), A))
    const p = seg(L, WIPE_A, WIPE_B)
    if (p > 0) {
      const k0 = SCENE_DROP[index][0]
      const c0 = toS(k0.x, k0.y)
      const far = Math.max(Math.hypot(c0.x, c0.y), Math.hypot(FW - c0.x, c0.y), Math.hypot(c0.x, FH - c0.y), Math.hypot(FW - c0.x, FH - c0.y)) * 1.12
      const R = far * (1 - Math.pow(1 - p, 2.2))
      art += `<path d="${blob(c0.x, c0.y, R + 30 * (1 - p) + 6, index + 1)}" style="fill:${C.accent};opacity:0.9"/>`
      art += `<clipPath id="ink-wipe"><path d="${blob(c0.x, c0.y, R, index + 1)}"/></clipPath><g clip-path="url(#ink-wipe)"><rect width="${FW}" height="${FH}" style="fill:${C.app}"/>${layer(index, L, vr)}</g>`
      // a splash where it lands
      const sp = seg(L, WIPE_A, WIPE_A + 0.45)
      if (sp < 1) {
        for (let i = 0; i < 7; i++) {
          const a = -Math.PI * (0.1 + 0.8 * (i / 6)) + (hash(i + index * 9) - 0.5) * 0.4
          const dist = (40 + 70 * hash(i + 11)) * out3(sp) * s * 1.6
          art += dot(c0.x + Math.cos(a) * dist, c0.y + Math.sin(a) * dist * 0.8 + 60 * sp * sp * s, (3 + 5 * hash(i + 23)) * (1 - sp) * s * 1.4, 'fill:url(#ink-drop)')
        }
      }
    }
  } else art += layer(index, L, vr)
  // eyes close as it becomes the logo's node
  const eyes = index === SCENE_COUNT - 1 ? 1 - seg(L, 5.05, 5.3) : 1
  art += dropMarkup(tt >= INTRO_DURATION ? INTRO_DURATION - 1e-6 : tt, toS, s, eyes)

  const defs =
    `<defs><linearGradient id="ink-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--color-accent);stop-opacity:0.78"/><stop offset="1" style="stop-color:var(--color-accent)"/></linearGradient>` +
    `<linearGradient id="ink-line" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--color-accent);stop-opacity:0.78"/><stop offset="1" style="stop-color:var(--color-accent)"/></linearGradient></defs>`
  if (full) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${INTRO_W} ${INTRO_H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${defs}` +
      `<rect x="0" y="0" width="${INTRO_W}" height="${INTRO_H}" style="fill:${C.app}"/><svg x="0" y="0" width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}">${art}</svg>${captions(tt, copy)}</svg>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FW} ${FH}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${defs}${art}</svg>`
}
