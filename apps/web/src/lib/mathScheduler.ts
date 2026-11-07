import { flushSync } from 'react-dom'

// Keeps KaTeX off the critical path (docs/adr/0998-math-render-scheduling.md):
//  - an LRU cache of rendered HTML per (displayMode, latex), bounded by entries and characters;
//  - a render queue drained in slices of FRAME_BUDGET_MS, yielding to the browser in between
//    (scheduler.yield() where supported, otherwise a macrotask);
//  - deferred rendering of off-screen formulas, only when the page has at least LAZY_THRESHOLD of
//    them. Placeholders keep the LaTeX source as text (find in page, screen readers) and reserve the
//    expected size. Nothing here touches the editor's contenteditable structure: math nodes are
//    atoms whose node view is contenteditable=false, and only its inner content changes
//    (contrast docs/adr/0850-*, where content-visibility on editor blocks lost keystrokes);
//  - print: `beforeprint` renders every pending formula synchronously.

/** One frame's worth of rendering work before yielding (16.7 ms frame, half for the browser). */
export const FRAME_BUDGET_MS = 8
/** Pages with fewer formulas render all of them at once; measured in docs/PERFORMANCE.md. */
export const LAZY_THRESHOLD = 300
/** Render ahead of the viewport: about two screens above and below. */
export const LAZY_ROOT_MARGIN = '200% 0px'
/** Safety net: a deferred formula renders after this long even if no observer ever fired. */
export const MAX_DEFER_MS = 5_000

const CACHE_MAX_ENTRIES = 2_000
const CACHE_MAX_CHARS = 8_000_000

// ---------------------------------------------------------------------------
// measurement switches (localStorage), only for the comparison in docs/PERFORMANCE.md:
//   'inkling:math-mode'   a = render in React render, no cache, no pacing (the first version)
//                         b = time-sliced queue, memory cache, paced insertion
//                         e = b with deferral of off-screen formulas on every page
//                         unset = the shipped default (b, deferral only from LAZY_THRESHOLD)
//   'inkling:math-evict'  off | lru | distance (default distance), 'inkling:math-cap' a number
//   'inkling:math-output' mathml = KaTeX `output: 'mathml'` instead of 'htmlAndMathml'
// ---------------------------------------------------------------------------

export type MathMode = 'a' | 'b' | 'e' | 'auto'
function readSetting(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}
export const mathMode: MathMode = (() => {
  const v = readSetting('inkling:math-mode')
  return v === 'a' || v === 'b' || v === 'e' ? v : 'auto'
})()
export const mathOutput: 'htmlAndMathml' | 'mathml' = readSetting('inkling:math-output') === 'mathml' ? 'mathml' : 'htmlAndMathml'

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

export class RenderCache<V extends { size: number }> {
  private map = new Map<string, V>()
  private chars = 0
  constructor(
    private maxEntries = CACHE_MAX_ENTRIES,
    private maxChars = CACHE_MAX_CHARS,
  ) {}
  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, v: V): void {
    const old = this.map.get(key)
    if (old) {
      this.chars -= old.size
      this.map.delete(key)
    }
    this.map.set(key, v)
    this.chars += v.size
    while (this.map.size > this.maxEntries || (this.chars > this.maxChars && this.map.size > 1)) {
      const [k, first] = this.map.entries().next().value as [string, V]
      this.map.delete(k)
      this.chars -= first.size
    }
  }
  get size(): number {
    return this.map.size
  }
}

// ---------------------------------------------------------------------------
// time-sliced queue
// ---------------------------------------------------------------------------

type Job = { run: () => void; cancelled: boolean }
const queue: Job[] = []
let draining = false

function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof s?.yield === 'function') return s.yield()
  return new Promise((r) => setTimeout(r, 0))
}

async function drain(): Promise<void> {
  draining = true
  try {
    while (queue.length) {
      const start = performance.now()
      while (queue.length && performance.now() - start < FRAME_BUDGET_MS) {
        const job = queue.shift()!
        if (!job.cancelled) job.run()
      }
      if (queue.length) await yieldToMain()
    }
  } finally {
    draining = false
  }
}

/** Runs `run` in a later slice; returns a cancel function. */
export function scheduleRender(run: () => void): () => void {
  const job: Job = { run, cancelled: false }
  queue.push(job)
  if (!draining) void drain()
  return () => {
    job.cancelled = true
  }
}

// ---------------------------------------------------------------------------
// deferred rendering of off-screen formulas
// ---------------------------------------------------------------------------

type Entry = { el: Element; start: () => void; started: boolean; timer: number }
const live = new Set<Entry>()
let fresh: Entry[] = []
let flushQueued = false
let firstBatchDone = false
let observer: IntersectionObserver | null = null

function startEntry(e: Entry): void {
  if (e.started) return
  e.started = true
  observer?.unobserve(e.el)
  window.clearTimeout(e.timer)
  e.start()
}

function getObserver(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === 'undefined') return observer
  observer = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        if (!r.isIntersecting) continue
        for (const e of live) if (e.el === r.target) startEntry(e)
      }
    },
    { rootMargin: LAZY_ROOT_MARGIN },
  )
  return observer
}

/** Called when a page starts deferring (katex.ts preloads main-thread KaTeX for printing). */
export const whenDeferring: (() => void)[] = []

/** Whether pages with `count` formulas defer the off-screen ones. */
export function shouldDefer(count: number, mode: MathMode = mathMode): boolean {
  if (mode === 'e') return true
  if (mode !== 'auto') return false
  return count >= LAZY_THRESHOLD
}

function flush(): void {
  flushQueued = false
  const batch = fresh
  fresh = []
  // Formulas that appear after the page's first batch (typed, pasted, a collaborator's edit) are
  // where the user is working: never deferred.
  const defer = !firstBatchDone && shouldDefer(live.size)
  firstBatchDone = true
  const io = defer ? getObserver() : null
  if (io) whenDeferring.forEach((fn) => fn())
  for (const e of batch) {
    if (!live.has(e)) continue
    if (!io) {
      startEntry(e)
      continue
    }
    io.observe(e.el)
    e.timer = window.setTimeout(() => startEntry(e), MAX_DEFER_MS)
  }
}

/**
 * Registers a formula element that needs rendering; `start` is called when it should be rendered
 * (at once, when it nears the viewport, at print, or after MAX_DEFER_MS). Returns an unregister.
 */
export function requestMathRender(el: Element, start: () => void): () => void {
  const e: Entry = { el, start, started: false, timer: 0 }
  live.add(e)
  fresh.push(e)
  if (!flushQueued) {
    flushQueued = true
    requestAnimationFrame(flush)
  }
  return () => {
    live.delete(e)
    observer?.unobserve(e.el)
    window.clearTimeout(e.timer)
    // every formula gone (another page opened): the next page's first batch may be deferred again
    if (live.size === 0) firstBatchDone = false
  }
}

// ---------------------------------------------------------------------------
// print: render everything first
// ---------------------------------------------------------------------------

const printListeners = new Set<() => void>()
let printing = false

/** True from `beforeprint` until `afterprint`: render synchronously, skip deferral and slicing. */
export function isPrinting(): boolean {
  return printing
}

export function onPrint(fn: () => void): () => void {
  printListeners.add(fn)
  return () => printListeners.delete(fn)
}

/**
 * Renders every registered formula now and synchronously (print, PDF export): the listeners
 * render inside one flushSync, so the DOM is complete when the browser takes its print snapshot.
 */
export function renderAllMathNow(): void {
  printing = true
  for (const e of [...live]) {
    e.started = true
    observer?.unobserve(e.el)
    window.clearTimeout(e.timer)
  }
  flushSync(() => {
    for (const fn of [...printListeners]) fn()
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', renderAllMathNow)
  window.addEventListener('afterprint', () => {
    printing = false
  })
}

// ---------------------------------------------------------------------------
// reserved size of placeholders
// ---------------------------------------------------------------------------

const sizes = new RenderCache<{ w: number; h: number; size: number }>(5_000, 5_000 * 64)

/** Remembers the rendered size of a formula, so its next placeholder reserves exactly that. */
export function rememberSize(key: string, el: Element): void {
  const r = el.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) sizes.set(key, { w: r.width, h: r.height, size: 64 })
}

/**
 * Size a placeholder reserves: the remembered size, else an estimate from the source (rows from
 * `\\` and `\begin`, fractions add height; width from the visible characters).
 */
export function placeholderStyle(key: string, latex: string, display: boolean): Record<string, string> {
  const known = sizes.get(key)
  // a display formula seen before gets exactly its old box, so evicting and re-inserting it does not
  // move anything (the source text inside is clipped, still findable and readable)
  if (known) return display ? { height: `${known.h}px`, overflow: 'hidden' } : { display: 'inline-block', minWidth: `${known.w}px` }
  const rows = (latex.match(/\\\\/g)?.length ?? 0) + 1
  const tall = /\\(?:frac|dfrac|sum|int|prod|sqrt|binom|over)/.test(latex) ? 1.4 : 1
  if (display) return { minHeight: `${(1.2 * rows * tall + 1).toFixed(2)}em` }
  const visible = latex.replace(/\\[a-zA-Z]+|[{}^_\s]/g, 'x').length
  return { display: 'inline-block', minWidth: `${Math.min(30, visible * 0.45).toFixed(2)}em` }
}

// ---------------------------------------------------------------------------
// resident cap: at most MATH_DOM_CAP rendered display formulas in the DOM (docs/adr/0998-*).
// Only display formulas are evicted: they carry most of KaTeX's DOM, and their placeholder can
// keep the exact box. An inline placeholder cannot keep the baseline, so evicting inline formulas
// would shift the text line.
// Beyond it, formulas far from the viewport go back to their placeholder (LaTeX source as text,
// last measured size reserved); their HTML stays in the memory cache, so showing one again is an
// insertion, not a KaTeX render. Never evicted: visible formulas, formulas in or next to the
// block with the caret, inside the selection, or being edited.
// ---------------------------------------------------------------------------

function numberSetting(key: string): number | null {
  const n = Number(readSetting(key))
  return Number.isFinite(n) && n > 0 ? n : null
}
export type EvictPolicy = 'lru' | 'distance' | 'off'
export const MATH_DOM_CAP = numberSetting('inkling:math-cap') ?? 100
export const evictPolicy: EvictPolicy = (() => {
  const v = readSetting('inkling:math-evict')
  return v === 'lru' || v === 'off' || v === 'distance' ? v : mathMode === 'a' ? 'off' : 'distance'
})()

/** Counters read by the measurement script (window.__inklingMath when 'inkling:math-stats' is set). */
export const mathStats = { inserts: 0, evictions: 0, trace: [] as number[] }
if (typeof window !== 'undefined' && readSetting('inkling:math-stats')) {
  ;(window as unknown as { __inklingMath: typeof mathStats }).__inklingMath = mathStats
}
const tracing = typeof window !== 'undefined' && !!readSetting('inkling:math-stats')

type Resident = { id: number; el: Element; lastSeen: number; visible: boolean; evicted: boolean; evict: () => void; wake: (now: boolean) => void }
const residents = new Map<Element, Resident>()
let residentIds = 0
let renderedCount = 0
let enforceQueued = false
let residentObserver: IntersectionObserver | null = null

function residentIO(): IntersectionObserver | null {
  if (residentObserver || typeof IntersectionObserver === 'undefined') return residentObserver
  residentObserver = new IntersectionObserver(
    (records) => {
      const now = performance.now()
      for (const rec of records) {
        const r = residents.get(rec.target)
        if (!r) continue
        r.visible = rec.isIntersecting
        if (!rec.isIntersecting) continue
        r.lastSeen = now
        if (tracing) mathStats.trace.push(r.id)
        if (r.evicted) {
          r.evicted = false
          renderedCount++
          r.wake(false)
        }
      }
      queueEnforce()
    },
    { rootMargin: LAZY_ROOT_MARGIN },
  )
  return residentObserver
}

function isPinned(el: Element): boolean {
  if (el.closest('.nd-math-editing, .nd-math-active')) return true
  const sel = typeof document !== 'undefined' ? document.getSelection() : null
  if (!sel || !sel.rangeCount) return false
  if (sel.containsNode(el, true)) return true
  const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
  const caretBlock = anchor?.closest('.bn-block-outer')
  const block = el.closest('.bn-block-outer')
  if (!caretBlock || !block) return false
  return block === caretBlock || block === caretBlock.previousElementSibling || block === caretBlock.nextElementSibling ||
    caretBlock.contains(block) || block.contains(caretBlock)
}

function queueEnforce(): void {
  if (enforceQueued || evictPolicy === 'off' || renderedCount <= MATH_DOM_CAP) return
  enforceQueued = true
  requestAnimationFrame(enforce)
}

/** Evicts down to the cap: by distance from the viewport (ties: least recently seen) or pure LRU. */
function enforce(): void {
  enforceQueued = false
  if (printing) return
  let over = renderedCount - MATH_DOM_CAP
  if (over <= 0) return
  const candidates = [...residents.values()].filter((r) => !r.evicted && !r.visible && !isPinned(r.el))
  if (evictPolicy === 'distance') {
    const mid = window.innerHeight / 2
    const dist = new Map(candidates.map((r) => [r, Math.abs(r.el.getBoundingClientRect().top - mid)]))
    candidates.sort((a, b) => dist.get(b)! - dist.get(a)! || a.lastSeen - b.lastSeen)
  } else {
    candidates.sort((a, b) => a.lastSeen - b.lastSeen)
  }
  for (const r of candidates) {
    if (over <= 0) break
    r.evicted = true
    renderedCount--
    over--
    mathStats.evictions++
    r.evict()
  }
}

/**
 * Tracks a rendered formula element for the cap. `evict` turns it back into its placeholder,
 * `wake` renders it again from the cache when it nears the viewport (`now`: synchronously, for print). Returns an untrack function.
 */
export function trackResident(el: Element, evict: () => void, wake: (now: boolean) => void): () => void {
  const r: Resident = { id: residentIds++, el, lastSeen: performance.now(), visible: true, evicted: false, evict, wake }
  residents.set(el, r)
  renderedCount++
  residentIO()?.observe(el)
  queueEnforce()
  return () => {
    if (residents.get(el) !== r) return
    residents.delete(el)
    if (!r.evicted) renderedCount--
    residentObserver?.unobserve(el)
  }
}

/** Element identity for traces: stable id of a tracked element (measurement only). */
export function residentId(el: Element): number | undefined {
  return residents.get(el)?.id
}

/** Print / PDF: every evicted formula comes back before the snapshot. */
onPrint(() => {
  for (const r of residents.values()) {
    if (!r.evicted) continue
    r.evicted = false
    renderedCount++
    r.wake(true) // inside renderAllMathNow's flushSync
  }
})
