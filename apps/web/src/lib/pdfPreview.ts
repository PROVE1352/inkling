// The PDF preview under a file block (docs/adr/2480-*, 2481-*): the pure parts of the preview chunk —
// when the bytes are fetched without a click, which pages are drawn, the zoom steps, which links inside a
// PDF survive and the per-viewer "collapsed" memory. Which blocks get a preview is lib/pdfFile.ts (the
// editor's part). No DOM, no pdf.js: tested in Node.

/**
 * Files up to this size load as soon as the preview comes near the screen; larger ones wait for a press
 * on "Load preview (25.1 MB)". 10 MB (docs/adr/2482-*): the /files route answers no byte ranges, so page 1
 * waits for the whole file; measured at 20 Mbit/s that is about 4 s for 10 MB and 6.5 s for 15 MB, and a
 * page opened only to read its text should not spend more than that on mobile data without being asked.
 */
export const AUTO_LOAD_MAX_BYTES = 10 * 1024 * 1024

export function isPdfMime(mime: string | undefined | null): boolean {
  return (mime ?? '').split(';')[0].trim().toLowerCase() === 'application/pdf'
}

/**
 * Should the bytes be fetched without a press? A size the server did not give counts as large, and a
 * browser in data-saver mode (`navigator.connection.saveData`) always asks.
 */
export function autoLoads(size: number | null | undefined, max = AUTO_LOAD_MAX_BYTES, saveData = false): boolean {
  if (saveData) return false
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 && size <= max
}

/** The browser's data-saver flag (Chromium's Network Information API; false elsewhere). */
export function prefersSavingData(): boolean {
  try {
    return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  } catch {
    return false
  }
}

/** "25.1 MB", "840 KB": the size on the "Load preview" button. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A link inside a PDF that the preview keeps: http and https only, as an absolute address. Every other
 * scheme (javascript:, file:, data:, mailto:, launch actions) is dropped.
 */
export function safeLinkUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4096) return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
}

// ── zoom ──────────────────────────────────────────────────────────────────────────────────────────
/** Zoom is a factor of the page's actual size (1 = 100%, 72 pt = 96 CSS px). */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

/** The next step up (dir 1) or down (-1) from `z`, which may lie between steps (fit width). */
export function stepZoom(z: number, dir: 1 | -1): number {
  const cur = clampZoom(z)
  if (dir > 0) return STEPS.find((s) => s > cur + 0.001) ?? MAX_ZOOM
  for (let i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] < cur - 0.001) return STEPS[i]
  return MIN_ZOOM
}

/** The zoom at which a page `pageWidthCss` wide (at 100%) fills `available` CSS px. */
export function fitWidthZoom(pageWidthCss: number, available: number): number {
  if (!(pageWidthCss > 0) || !(available > 0)) return 1
  return clampZoom(available / pageWidthCss)
}

export function percent(z: number): string {
  return `${Math.round(z * 100)}%`
}

// ── which pages are drawn ─────────────────────────────────────────────────────────────────────────
export type Slots = { tops: number[]; heights: number[] }

/** Page tops from the page heights (CSS px at the current zoom) and the gap between pages. */
export function layoutSlots(heights: number[], gap: number, pad: number): Slots & { total: number } {
  const tops: number[] = []
  let y = pad
  for (const h of heights) {
    tops.push(y)
    y += h + gap
  }
  const total = heights.length ? y - gap + pad : 0
  return { tops, heights, total }
}

/**
 * The pages in view for a scroll position: `first`..`last` intersect the viewport (0-based), `current`
 * is the one showing the most of itself (the earlier one on a tie). Empty documents give -1s.
 */
export function visiblePages(slots: Slots, scrollTop: number, viewport: number): { first: number; last: number; current: number } {
  const n = slots.tops.length
  if (n === 0) return { first: -1, last: -1, current: -1 }
  const top = scrollTop
  const bottom = scrollTop + Math.max(1, viewport)
  // binary search for the first page whose bottom is below the viewport's top
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (slots.tops[mid] + slots.heights[mid] <= top) lo = mid + 1
    else hi = mid
  }
  const first = lo
  let last = first
  while (last + 1 < n && slots.tops[last + 1] < bottom) last++
  let current = first
  let best = -1
  for (let i = first; i <= last; i++) {
    const seen = Math.min(bottom, slots.tops[i] + slots.heights[i]) - Math.max(top, slots.tops[i])
    if (seen > best + 0.5) {
      best = seen
      current = i
    }
  }
  return { first, last, current }
}

/**
 * Pages to draw (in view plus `ahead` on each side) and pages whose canvases are kept: drawn ones plus
 * one more on each side, so a small scroll back does not redraw. Everything else is released.
 */
export function renderWindow(first: number, last: number, count: number, ahead = 1): { draw: [number, number]; keep: [number, number] } {
  if (count <= 0 || first < 0) return { draw: [0, -1], keep: [0, -1] }
  const draw: [number, number] = [Math.max(0, first - ahead), Math.min(count - 1, last + ahead)]
  const keep: [number, number] = [Math.max(0, draw[0] - 1), Math.min(count - 1, draw[1] + 1)]
  return { draw, keep }
}

/** A typed page number ("12", " 3 ") as a 1-based page within 1..count, or null. */
export function parsePageNumber(input: string, count: number): number | null {
  const s = input.trim()
  if (!/^\d{1,6}$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= count ? n : null
}

/** One page canvas holds at most this many pixels (32 MiB of RGBA) and this many on a side. */
export const MAX_CANVAS_PIXELS = 8_388_608
export const MAX_CANVAS_SIDE = 8192
/** Below this factor a canvas would show nothing readable: the page keeps its place, undrawn. */
const MIN_OUTPUT_SCALE = 0.05

/**
 * The canvas resolution factor for a page drawn `cssWidth` x `cssHeight` CSS px: the device pixel ratio,
 * lowered until the canvas fits MAX_CANVAS_PIXELS and MAX_CANVAS_SIDE. 0 means "do not draw" (the page
 * would need a factor under 0.05, or its size is not a finite positive number).
 */
export function outputScale(cssWidth: number, cssHeight: number, dpr: number, maxPixels = MAX_CANVAS_PIXELS, maxSide = MAX_CANVAS_SIDE): number {
  if (!(cssWidth > 0) || !(cssHeight > 0) || !Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return 0
  const want = Math.max(1, Number.isFinite(dpr) ? dpr : 1)
  const s = Math.min(want, Math.sqrt(maxPixels / (cssWidth * cssHeight)), maxSide / cssWidth, maxSide / cssHeight)
  return s >= MIN_OUTPUT_SCALE ? s : 0
}

/** A page is laid out at most this many CSS px on its longer side at 100% (A0 is about 4,500). */
export const MAX_PAGE_CSS = 5000
/** The size a page gets in the layout at 100%, and the factor `k` its drawing is scaled by to get there. */
export type PageBox = { w: number; h: number; k: number }
const LETTER: PageBox = { w: 816, h: 1056, k: 1 }

/**
 * Bounds a page's size at 100% (CSS px, user unit included): pages larger than MAX_PAGE_CSS on their
 * longer side are scaled down as a whole, sides under 1 px become 1 px in the layout, and a size that is
 * not a finite positive number becomes US Letter.
 */
export function pageBox(w: number, h: number): PageBox {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { ...LETTER }
  const k = Math.min(1, MAX_PAGE_CSS / Math.max(w, h))
  return { w: Math.max(1, w * k), h: Math.max(1, h * k), k }
}

// ── page count ────────────────────────────────────────────────────────────────────────────────────
/**
 * The preview opens PDFs of at most this many pages. pdf.js takes the page count from the file's page
 * tree (/Count), which a 1 KB file can set to millions; the layout keeps one size per page.
 */
export const PDF_MAX_PAGES = 5000

export type PageCountCheck = { ok: true; count: number } | { ok: false; reason: 'invalid' | 'tooManyPages'; count: number }

export function checkPageCount(n: unknown, max = PDF_MAX_PAGES): PageCountCheck {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return { ok: false, reason: 'invalid', count: 0 }
  if (n > max) return { ok: false, reason: 'tooManyPages', count: n }
  return { ok: true, count: n }
}

/**
 * At most this many pages are drawn per pass over the view. Pages of ordinary size never reach it (a view
 * shows 1-3 of them, plus one each side); a file of hair-thin pages would otherwise start hundreds of
 * renders at once. Pages past it stay blank until scrolled to.
 */
export const MAX_DRAW_PER_PASS = 8

/** renderWindow with the drawn range cut to MAX_DRAW_PER_PASS pages from the first one in view. */
export function cappedWindow(first: number, last: number, count: number, max = MAX_DRAW_PER_PASS): { draw: [number, number]; keep: [number, number] } {
  // one page ahead on each side is part of the drawn range, so the pages in view are cut to max - 2
  return renderWindow(first, Math.min(last, first + Math.max(1, max - 2) - 1), count, 1)
}

/** The widest page (no spread: the array may be thousands long). */
export function widestOf(sizes: readonly { w: number }[]): number {
  let m = 0
  for (const s of sizes) if (s.w > m) m = s.w
  return m
}

// ── per-viewer "collapsed" memory (localStorage, never the document) ───────────────────────────────
export const COLLAPSED_KEY = 'inkling-pdf-collapsed'
const COLLAPSED_CAP = 300

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function readList(storage: StorageLike | null | undefined): string[] {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-COLLAPSED_CAP) : []
  } catch {
    return []
  }
}

export function isCollapsed(storage: StorageLike | null | undefined, fileId: string): boolean {
  return readList(storage).includes(fileId)
}

/** Remembers (or forgets) a collapsed preview; the newest 300 are kept. Storage errors are ignored. */
export function setCollapsed(storage: StorageLike | null | undefined, fileId: string, collapsed: boolean): void {
  const list = readList(storage).filter((x) => x !== fileId)
  if (collapsed) list.push(fileId)
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(list.slice(-COLLAPSED_CAP)))
  } catch {
    // private mode, quota, blocked storage: the choice lasts for this view only
  }
}

/** localStorage, or null where reading it throws (blocked site data). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
