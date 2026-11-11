// The PDF preview under a file block (docs/adr/2480-*, 2481-*). A lazy chunk: PdfFileBlock.tsx imports it
// when a PDF block comes near the screen; pdf.js itself (pdfDocument.ts) is a second lazy chunk, imported
// only when the bytes are fetched.
//
// - Small files load on sight, larger ones (lib/pdfPreview.ts AUTO_LOAD_MAX_BYTES) wait for a press on
//   "Load preview (25.1 MB)"; the size and type come from /api/files/<id>/meta, never from the file.
// - Pages scroll inside an area at most 70% of the screen tall. Only the pages in view and one on each
//   side are drawn; canvases further away are released, so a 500-page file holds a handful of canvases.
// - Text layer (select and copy), links (http/https only, new tab; links inside the document jump to
//   their page), page number, zoom steps, fit width, a full-screen view, download, collapse.
// - The preview is view state: nothing here writes to the document. Collapsing is remembered per viewer
//   in localStorage; page and zoom are remembered per block for this tab, so a node view rebuilt after a
//   prop change comes back where it was.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t, useT } from '../../i18n'
import {
  autoLoads,
  browserStorage,
  cappedWindow,
  checkPageCount,
  fitWidthZoom,
  formatSize,
  isCollapsed,
  isPdfMime,
  layoutSlots,
  outputScale,
  pageBox,
  parsePageNumber,
  percent,
  prefersSavingData,
  safeLinkUrl,
  setCollapsed,
  stepZoom,
  visiblePages,
  widestOf,
  type PageBox,
} from '../../lib/pdfPreview'
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, ExpandIcon, WidthIcon, XIcon } from '../Icons'
import type { PdfHost } from './PdfFileBlock'
import type { LoadError, PDFDocumentProxy, PDFPageProxy, RenderTask } from './pdfDocument'
import './pdfPreview.css'

export type PdfPreviewProps = { host: PdfHost; readOnly: boolean }

type PdfLib = typeof import('./pdfDocument')
let lib: PdfLib | null = null
function loadLib(): Promise<PdfLib> {
  return import('./pdfDocument').then((m) => (lib = m))
}

/** 72 pt (a PDF inch) = 96 CSS px: the size at 100%. */
const PDF_TO_CSS = 96 / 72
const GAP = 12
const PAD = 12

type ZoomMode = 'fit' | number
type Saved = { page: number; zoom: ZoomMode }
/** Page and zoom per block and file, for this tab (node views are rebuilt on every prop change). */
const saved = new Map<string, Saved>()
/**
 * Also per tab, because a node view is rebuilt whenever its block's props change (another member adds a
 * caption): the server's meta for a minute, files that are not readable PDFs for half a minute, and the
 * large files the reader already asked for.
 */
const metaCache = new Map<string, { at: number; size: number | null; mime: string | null }>()
const failedCache = new Map<string, { at: number; reason: ErrorReason; count?: number }>()
const asked = new Set<string>()
const META_MS = 60_000
const FAILED_MS = 30_000
const fresh = <T extends { at: number }>(m: Map<string, T>, k: string, ms: number): T | undefined => {
  const v = m.get(k)
  if (v && Date.now() - v.at < ms) return v
  m.delete(k)
  return undefined
}

type ErrorReason = LoadError | 'chunk' | 'tooManyPages' | 'stalled'
type Phase =
  | { kind: 'meta' }
  | { kind: 'none' }
  | { kind: 'gate'; size: number | null }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'ready'; doc: PDFDocumentProxy; count: number }
  /** far from the screen for a while: the document is let go, the box keeps its height */
  | { kind: 'parked'; height: number }
  | { kind: 'error'; reason: ErrorReason; count?: number }

/** A download that has not moved for this long is given up (docs/adr/2483-*). */
const STALL_MS = 30_000
/** Further than this from the screen, a preview's canvases are let go… */
const FAR_MARGIN = '1200px 0px'
/** …and after this long far away, its document too. */
const PARK_MS = 10_000

const ERROR_TEXT = {
  password: 'pdfPreview.error.password',
  invalid: 'pdfPreview.error.invalid',
  missing: 'pdfPreview.error.missing',
  network: 'pdfPreview.error.network',
  other: 'pdfPreview.error.other',
  chunk: 'pdfPreview.chunkFailed',
  tooManyPages: 'pdfPreview.error.tooManyPages',
  stalled: 'pdfPreview.error.stalled',
} as const

const BTN =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40'

export function PdfPreview({ host }: PdfPreviewProps) {
  const t = useT()
  const { url, fileId, name, blockId } = host
  const viewKey = `${blockId}|${url}`
  const [collapsed, setCollapsedState] = useState(() => isCollapsed(browserStorage(), fileId))
  const [phase, setPhase] = useState<Phase>({ kind: 'meta' })
  const [wanted, setWanted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [size, setSize] = useState<number | null>(null)
  const [full, setFull] = useState(false)
  const [jumpTo, setJumpTo] = useState<{ page: number } | null>(null)

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(browserStorage(), fileId, next)
    setCollapsedState(next)
  }

  // the server's size and type: decides "is it a PDF" for names without an extension, and auto vs press
  useEffect(() => {
    if (collapsed) return
    let live = true
    const decide = (sz: number | null, mime: string | null) => {
      if (host.byName === 'unknown' && !isPdfMime(mime)) return setPhase({ kind: 'none' })
      setSize(sz)
      const failed = fresh(failedCache, url, FAILED_MS)
      if (failed) return setPhase({ kind: 'error', reason: failed.reason, count: failed.count })
      const go = wanted || asked.has(url) || autoLoads(sz, undefined, prefersSavingData())
      setPhase(go ? { kind: 'loading', loaded: 0, total: sz ?? 0 } : { kind: 'gate', size: sz })
    }
    const known = fresh(metaCache, fileId, META_MS)
    if (known) {
      decide(known.size, known.mime)
      return
    }
    setPhase({ kind: 'meta' })
    fetch(`/api/files/${encodeURIComponent(fileId)}/meta`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!live) return
        if (res.status === 404 || res.status === 403) return setPhase({ kind: 'error', reason: 'missing' })
        if (!res.ok) return setPhase({ kind: 'error', reason: 'network' })
        const body = (await res.json()) as { file?: { size?: number; mime?: string } }
        if (!live) return
        const mime = body.file?.mime ?? null
        const sz = typeof body.file?.size === 'number' ? body.file.size : null
        metaCache.set(fileId, { at: Date.now(), size: sz, mime })
        decide(sz, mime)
      })
      .catch(() => live && setPhase({ kind: 'error', reason: 'network' }))
    return () => {
      live = false
    }
    // `wanted` is read once: a press moves the phase itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, fileId, host.byName, attempt])

  const retry = () => {
    metaCache.delete(fileId)
    failedCache.delete(url)
    setAttempt((a) => a + 1)
  }

  const loading = phase.kind === 'loading'
  // the bytes: pdf.js chunk, then the shared document
  useEffect(() => {
    if (!loading || collapsed) return
    let live = true
    let acquired = false
    // a download that stops moving (a server or proxy that holds the connection open) ends in an error
    // with a retry instead of a progress bar forever
    let stall: ReturnType<typeof setTimeout> | undefined
    let seen = -1
    const arm = () => {
      clearTimeout(stall)
      stall = setTimeout(() => {
        if (live) setPhase({ kind: 'error', reason: 'stalled' })
      }, STALL_MS)
    }
    arm()
    const onProgress = (loaded: number, total: number) => {
      if (!live) return
      if (loaded !== seen) {
        seen = loaded
        arm()
      }
      setPhase((p) => (p.kind === 'loading' ? { kind: 'loading', loaded, total: total || size || 0 } : p))
    }
    loadLib().then(
      (m) => {
        if (!live) return
        acquired = true
        m.acquire(url, onProgress).then(
          (doc) => {
            clearTimeout(stall)
            if (!live) return
            // the page count comes from the file: a hostile /Count must not size anything (docs/adr/2483-*)
            const c = checkPageCount(doc.numPages)
            if (!c.ok) {
              failedCache.set(url, { at: Date.now(), reason: c.reason, count: c.count })
              return setPhase({ kind: 'error', reason: c.reason, count: c.count })
            }
            setPhase({ kind: 'ready', doc, count: c.count })
          },
          (e) => {
            clearTimeout(stall)
            const reason = m.errorKind(e)
            // a file that is not a readable PDF stays so: do not fetch it again on every rebuild
            if (reason === 'password' || reason === 'invalid') failedCache.set(url, { at: Date.now(), reason })
            if (live) setPhase({ kind: 'error', reason })
          },
        )
      },
      () => {
        clearTimeout(stall)
        if (live) setPhase({ kind: 'error', reason: 'chunk' })
      },
    )
    return () => {
      live = false
      clearTimeout(stall)
      if (acquired) lib?.release(url, onProgress)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, collapsed, url])

  // a ready document is held until the preview goes away (the loading effect above let go of its claim
  // when the phase moved on, so take one of our own)
  const doc = phase.kind === 'ready' ? phase.doc : null
  useEffect(() => {
    if (!doc || !lib) return
    const m = lib
    void m.acquire(url)
    return () => m.release(url)
  }, [doc, url])

  // Far from the screen: canvases go at once, the document after PARK_MS (the box keeps its height, so
  // nothing below moves). Coming back loads it again (from the shared document while it is still kept)
  // at the page and zoom it had. A full-screen view is never parked.
  const [near, setNear] = useState(true)
  const fullRef = useRef(full)
  fullRef.current = full
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1]
      if (e) setNear(e.isIntersecting)
    }, { rootMargin: FAR_MARGIN })
    io.observe(host.el)
    return () => io.disconnect()
  }, [host.el])
  useEffect(() => {
    if (near || phase.kind !== 'ready') return
    const timer = setTimeout(() => {
      if (fullRef.current) return
      setPhase({ kind: 'parked', height: Math.round(host.el.getBoundingClientRect().height) })
    }, PARK_MS)
    return () => clearTimeout(timer)
  }, [near, phase.kind, host.el])
  useEffect(() => {
    if (near && phase.kind === 'parked') setPhase({ kind: 'loading', loaded: 0, total: size ?? 0 })
  }, [near, phase.kind, size])

  const download = (
    <a href={url} download={name || ''} className={BTN} title={t('pdfPreview.download')} aria-label={t('pdfPreview.download')} data-testid="pdf-download">
      <DownloadIcon size={16} />
    </a>
  )

  if (phase.kind === 'none') return <div className="nd-pdf nd-pdf-none" data-testid="pdf-preview" data-state="none" hidden />

  if (collapsed) {
    return (
      <Shell state="collapsed">
        <div className="flex items-center gap-1 px-1.5 py-1">
          <button type="button" className={`${BTN} gap-1 px-2 text-xs`} onClick={toggleCollapsed} aria-expanded={false} data-testid="pdf-expand">
            <ChevronRightIcon size={14} />
            {t('pdfPreview.expand')}
          </button>
          <span className="flex-1" />
          {download}
        </div>
      </Shell>
    )
  }

  if (phase.kind === 'parked') {
    // the frame stays as tall as the drawn preview was, so the page around it does not move
    return <Shell state="parked" height={phase.height} />
  }

  const fatal = () => setPhase({ kind: 'error', reason: 'other' })

  if (phase.kind === 'ready') {
    return (
      <Shell state="ready">
        <PdfView
          key={viewKey}
          doc={phase.doc}
          count={phase.count}
          active={near || full}
          onFatal={fatal}
          url={url}
          name={name}
          viewKey={viewKey}
          variant="inline"
          jumpTo={jumpTo}
          onCollapse={toggleCollapsed}
          onFullscreen={() => setFull(true)}
          download={download}
        />
        {full && (
          <Overlay
            onClose={(page) => {
              setFull(false)
              if (page) setJumpTo({ page })
            }}
          >
            {(close) => (
              <PdfView
                doc={phase.doc}
                count={phase.count}
                onFatal={fatal}
                url={url}
                name={name}
                viewKey={`${viewKey}|full`}
                variant="overlay"
                initialPage={saved.get(viewKey)?.page}
                onClose={close}
                download={download}
              />
            )}
          </Overlay>
        )}
      </Shell>
    )
  }

  const bar = (
    <div className="flex items-center gap-1 px-1.5 py-1">
      <button type="button" className={`${BTN} gap-1 px-2 text-xs`} onClick={toggleCollapsed} aria-expanded={true} data-testid="pdf-collapse" title={t('pdfPreview.collapse')}>
        <ChevronDownIcon size={14} />
        <span className="max-sm:hidden">{t('pdfPreview.collapse')}</span>
      </button>
      <span className="flex-1" />
      {download}
    </div>
  )

  if (phase.kind === 'error') {
    return (
      <Shell state="error">
        {bar}
        <div className="px-3 pb-3 text-sm" role="alert" data-testid="pdf-error" data-reason={phase.reason}>
          <p className="text-ink">{t(ERROR_TEXT[phase.reason], { count: (phase.count ?? 0).toLocaleString() })}</p>
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            <a href={url} download={name || ''} className="text-accent underline underline-offset-2" data-testid="pdf-error-download">
              {t('pdfPreview.downloadFile', { name: name || 'PDF' })}
            </a>
            {(phase.reason === 'network' || phase.reason === 'chunk' || phase.reason === 'other' || phase.reason === 'stalled') && (
              <button type="button" className="text-sub underline underline-offset-2 hover:text-ink" onClick={retry}>
                {t('pdfPreview.retry')}
              </button>
            )}
          </p>
        </div>
      </Shell>
    )
  }

  if (phase.kind === 'gate') {
    return (
      <Shell state="gate">
        {bar}
        <div className="flex flex-col items-center gap-1.5 px-3 pb-4 pt-2 text-center">
          <button
            type="button"
            className="rounded-md border border-line bg-app px-3 py-1.5 text-sm text-ink hover:bg-hover"
            onClick={() => {
              asked.add(url)
              setWanted(true)
              setPhase({ kind: 'loading', loaded: 0, total: phase.size ?? 0 })
            }}
            data-testid="pdf-load"
          >
            {phase.size !== null ? t('pdfPreview.loadSized', { size: formatSize(phase.size) }) : t('pdfPreview.load')}
          </button>
          <span className="text-xs text-sub">{t('pdfPreview.largeHint')}</span>
        </div>
      </Shell>
    )
  }

  // meta or loading
  const total = phase.kind === 'loading' ? phase.total : 0
  const loaded = phase.kind === 'loading' ? phase.loaded : 0
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null
  return (
    <Shell state={phase.kind}>
      {bar}
      <div className="px-3 pb-4 pt-1" aria-live="polite">
        <p className="mb-1.5 text-xs text-sub">
          {phase.kind === 'loading' && total > 0
            ? t('pdfPreview.loadingBytes', { loaded: formatSize(loaded), total: formatSize(total) })
            : t('pdfPreview.loading')}
        </p>
        <div
          className="nd-pdf-progress h-1.5 overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-label={t('pdfPreview.loading')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          data-testid="pdf-progress"
        >
          <div className={`h-full rounded-full bg-accent ${pct === null ? 'nd-pdf-indeterminate w-1/3' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      </div>
    </Shell>
  )
}

function Shell({ state, children, height }: { state: string; children?: ReactNode; height?: number }) {
  return (
    <div
      className="nd-pdf rounded-md border border-line bg-app"
      data-testid="pdf-preview"
      data-state={state}
      style={height ? { height } : undefined}
      role="region"
      aria-label={t('pdfPreview.region')}
      tabIndex={-1}
    >
      {children}
    </div>
  )
}

// ── the pages ─────────────────────────────────────────────────────────────────────────────────────
type Drawn = {
  zoom: number
  gen: number
  canvas?: HTMLCanvasElement
  task?: RenderTask
  text?: { layer: InstanceType<PdfLib['TextLayer']>; div: HTMLDivElement }
  links?: HTMLDivElement
  linksStarted?: boolean
}

type PdfViewProps = {
  doc: PDFDocumentProxy
  /** doc.numPages, checked against PDF_MAX_PAGES before the view is made */
  count: number
  url: string
  name: string
  viewKey: string
  variant: 'inline' | 'overlay'
  /** false while the preview is far from the screen: every canvas is let go, nothing is drawn */
  active?: boolean
  initialPage?: number
  jumpTo?: { page: number } | null
  onCollapse?: () => void
  onFullscreen?: () => void
  onClose?: (page: number) => void
  /** the document cannot be drawn at all (page 1 failed): the preview shows an error */
  onFatal?: () => void
  download: ReactNode
}

/** A page that failed to draw is tried again after this long, on the next pass over it. */
const RETRY_MS = 3000

function PdfView({ doc, count, viewKey, variant, active = true, initialPage, jumpTo, onCollapse, onFullscreen, onClose, onFatal, download }: PdfViewProps) {
  const t = useT()
  const start = saved.get(viewKey)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const slotEls = useRef(new Map<number, HTMLDivElement>())
  const drawn = useRef(new Map<number, Drawn>())
  const pages = useRef(new Map<number, PDFPageProxy>())
  const failedAt = useRef(new Map<number, number>())
  // page boxes at 100% in CSS px (bounded, lib/pdfPreview.ts pageBox); every page assumed as large as
  // page 1 until it is fetched
  const [sizes, setSizes] = useState<PageBox[] | null>(null)
  const [zoomMode, setZoomMode] = useState<ZoomMode>(start?.zoom ?? 'fit')
  const [avail, setAvail] = useState(0)
  const [current, setCurrent] = useState(Math.max(1, Math.min(count, initialPage ?? start?.page ?? 1)))
  const [pageInput, setPageInput] = useState<string | null>(null)
  // only the slots near the view are in the DOM (a 5,000-page file keeps a handful)
  const [mounted, setMounted] = useState<[number, number]>([0, -1])
  const firstJump = useRef<number | null>(initialPage ?? start?.page ?? null)
  const fatal = useRef(onFatal)
  fatal.current = onFatal

  // page 1's size for every slot
  useEffect(() => {
    let live = true
    doc.getPage(1).then(
      (p) => {
        if (!live) return
        pages.current.set(0, p)
        const box = pageBox(p.getViewport({ scale: PDF_TO_CSS }).width, p.getViewport({ scale: PDF_TO_CSS }).height)
        const all: PageBox[] = new Array(count)
        for (let i = 0; i < count; i++) all[i] = box
        setSizes(all)
      },
      () => live && fatal.current?.(),
    )
    return () => {
      live = false
    }
  }, [doc, count])

  // available width (fit width follows the area)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = () => setAvail(Math.max(0, el.clientWidth - 2 * PAD))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const widest = useMemo(() => (sizes ? widestOf(sizes) : 0), [sizes])
  const zoom = zoomMode === 'fit' ? fitWidthZoom(widest, avail) : zoomMode
  const slots = useMemo(() => {
    const heights = new Array<number>(sizes?.length ?? 0)
    if (sizes) for (let i = 0; i < sizes.length; i++) heights[i] = Math.floor(sizes[i].h * zoom)
    return layoutSlots(heights, GAP, PAD)
  }, [sizes, zoom])
  const innerWidth = Math.max(avail + 2 * PAD, Math.floor(widest * zoom) + 2 * PAD)

  useEffect(() => {
    saved.set(viewKey, { page: current, zoom: zoomMode })
  }, [viewKey, current, zoomMode])

  // ── drawing ──
  const releasePage = useCallback((i: number) => {
    const d = drawn.current.get(i)
    if (!d) return
    d.task?.cancel()
    d.text?.layer.cancel()
    if (d.canvas) {
      d.canvas.width = 0
      d.canvas.height = 0
      d.canvas.remove()
    }
    d.text?.div.remove()
    d.links?.remove()
    drawn.current.delete(i)
    pages.current.get(i)?.cleanup()
  }, [])

  const jumpRef = useRef<(page: number) => void>(() => {})

  const drawPage = useCallback(
    async (i: number, z: number) => {
      const slot = slotEls.current.get(i)
      const m = lib
      if (!slot || !m) return
      let d = drawn.current.get(i)
      if (d && d.zoom === z) return
      const failed = failedAt.current.get(i)
      if (!d && failed !== undefined && Date.now() - failed < RETRY_MS) return
      const gen = (d?.gen ?? 0) + 1
      if (d) {
        d.task?.cancel()
        d.zoom = z
        d.gen = gen
      } else {
        d = { zoom: z, gen }
        drawn.current.set(i, d)
      }
      const mine = d
      const stale = () => drawn.current.get(i) !== mine || mine.gen !== gen
      // a page that could not be drawn is left for a later pass (not blank until scrolled away and back)
      const fail = () => {
        if (drawn.current.get(i) === mine && mine.gen === gen && !mine.canvas) {
          drawn.current.delete(i)
          failedAt.current.set(i, Date.now())
          slot.setAttribute('data-failed', '')
        }
      }
      let page = pages.current.get(i)
      if (!page) {
        try {
          page = await doc.getPage(i + 1)
        } catch {
          if (i === 0) fatal.current?.()
          return fail()
        }
        pages.current.set(i, page)
      }
      if (stale()) return
      const at100 = page.getViewport({ scale: PDF_TO_CSS })
      const box = pageBox(at100.width, at100.height)
      const vp = page.getViewport({ scale: z * PDF_TO_CSS * box.k })
      // a page of another size than assumed: fix its slot (the next layout redraws it)
      setSizes((prev) => {
        if (!prev || !prev[i]) return prev
        if (Math.abs(prev[i].w - box.w) < 0.5 && Math.abs(prev[i].h - box.h) < 0.5 && prev[i].k === box.k) return prev
        const next = prev.slice()
        next[i] = box
        return next
      })
      slot.style.setProperty('--scale-factor', String(vp.scale))
      slot.style.setProperty('--user-unit', String(page.userUnit || 1))
      const os = outputScale(vp.width, vp.height, window.devicePixelRatio || 1)
      if (os === 0) {
        // too large to draw at any sensible resolution: the page keeps its place, blank
        slot.setAttribute('data-undrawn', '')
        return
      }
      const canvas = document.createElement('canvas')
      canvas.className = 'nd-pdf-canvas'
      canvas.width = Math.max(1, Math.floor(vp.width * os))
      canvas.height = Math.max(1, Math.floor(vp.height * os))
      canvas.setAttribute('aria-hidden', 'true')
      const task = page.render({ canvas, viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : undefined })
      mine.task = task
      try {
        await task.promise
      } catch (e) {
        canvas.width = 0
        canvas.height = 0
        // a cancelled render (zoom, release) is not a failure
        if ((e as { name?: string } | null)?.name !== 'RenderingCancelledException') fail()
        return
      }
      if (stale()) {
        canvas.width = 0
        canvas.height = 0
        return
      }
      if (mine.canvas) {
        mine.canvas.width = 0
        mine.canvas.height = 0
        mine.canvas.remove()
      }
      mine.canvas = canvas
      failedAt.current.delete(i)
      slot.removeAttribute('data-failed')
      slot.prepend(canvas)
      slot.setAttribute('data-drawn', String(z))

      // text layer: built once per page, then scaled
      if (mine.text) {
        mine.text.layer.update({ viewport: vp })
      } else {
        const div = document.createElement('div')
        div.className = 'textLayer'
        const layer = new m.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: div, viewport: vp })
        mine.text = { layer, div }
        slot.appendChild(div)
        try {
          await layer.render()
        } catch {
          // cancelled (released) or a broken text stream: the picture stays
        }
      }
      // links: positions in % of the page, so a zoom does not move them; built once per drawn entry
      if (!mine.linksStarted) {
        mine.linksStarted = true
        const layer = await linkLayer(doc, page, (p) => jumpRef.current(p))
        if (layer && drawn.current.get(i) === mine) {
          mine.links = layer
          slot.appendChild(layer)
        }
      }
    },
    [doc],
  )

  // What is at the top of the view (page and how far into it), so a new layout (zoom, fit width after a
  // resize, a page found to have another size) shows the same place.
  const anchor = useRef<{ page: number; frac: number } | null>(firstJump.current && firstJump.current > 1 ? { page: firstJump.current, frac: 0 } : null)
  const laidOut = useRef<typeof slots | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  /** Which pages are in view: the page number, the anchor and which slots are in the DOM. */
  const measureView = useCallback(() => {
    const el = scrollerRef.current
    if (!el || !sizes) return null
    const v = visiblePages(slots, el.scrollTop, el.clientHeight)
    if (v.current >= 0) setCurrent(v.current + 1)
    if (v.first >= 0) anchor.current = { page: v.first + 1, frac: (el.scrollTop - slots.tops[v.first]) / Math.max(1, slots.heights[v.first]) }
    const w = cappedWindow(v.first, v.last, count)
    setMounted((prev) => (prev[0] === w.keep[0] && prev[1] === w.keep[1] ? prev : w.keep))
    return w
  }, [sizes, slots, count])

  /** Draws what is in view and lets go of the rest (after the slots of `measureView` are in the DOM). */
  const drawWindow = useCallback(() => {
    const el = scrollerRef.current
    if (!el || !sizes) return
    if (!activeRef.current) {
      for (const i of Array.from(drawn.current.keys())) releasePage(i)
      return
    }
    const v = visiblePages(slots, el.scrollTop, el.clientHeight)
    const w = cappedWindow(v.first, v.last, count)
    for (let i = w.draw[0]; i <= w.draw[1]; i++) void drawPage(i, zoom)
    for (const i of Array.from(drawn.current.keys())) if (i < w.keep[0] || i > w.keep[1]) releasePage(i)
  }, [sizes, slots, count, zoom, drawPage, releasePage])

  const sync = useCallback(() => {
    measureView()
    drawWindow()
  }, [measureView, drawWindow])

  // after React has put the slots of a new window in the DOM, draw into them
  useLayoutEffect(() => {
    drawWindow()
  }, [mounted, drawWindow, active])

  // scroll: one sync per frame
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [sync])

  const goTo = useCallback(
    (page: number) => {
      const el = scrollerRef.current
      const n = Math.max(1, Math.min(count, page))
      if (!el || !slots.tops.length) return
      el.scrollTop = Math.max(0, slots.tops[n - 1] - PAD / 2)
      setCurrent(n)
      anchor.current = { page: n, frac: (el.scrollTop - slots.tops[n - 1]) / Math.max(1, slots.heights[n - 1]) }
      sync()
    },
    [count, slots, sync],
  )
  jumpRef.current = goTo

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !sizes) return
    const a = anchor.current
    if (a && laidOut.current !== slots && a.page <= slots.tops.length) {
      const i = a.page - 1
      el.scrollTop = Math.max(0, slots.tops[i] + a.frac * slots.heights[i])
    }
    laidOut.current = slots
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, sizes])

  const setZoom = (next: ZoomMode) => setZoomMode(next)

  useEffect(() => {
    if (jumpTo) goTo(jumpTo.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo])

  // let go of every canvas when the view goes away
  useEffect(
    () => () => {
      for (const i of Array.from(drawn.current.keys())) releasePage(i)
    },
    [releasePage],
  )

  // overlay keys (the dialog takes them in the capture phase, see Overlay)
  const onKeys = useRef<(e: KeyboardEvent) => boolean>(() => false)
  onKeys.current = (e) => {
    if (e.target instanceof HTMLInputElement) return false
    if (e.key === '+' || e.key === '=') setZoom(stepZoom(zoom, 1))
    else if (e.key === '-' || e.key === '_') setZoom(stepZoom(zoom, -1))
    else if (e.key === '0') setZoom('fit')
    else return false
    return true
  }
  useEffect(() => {
    if (variant !== 'overlay') return
    const el = scrollerRef.current
    el?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      if (onKeys.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [variant])

  const submitPage = (e: FormEvent) => {
    e.preventDefault()
    const n = parsePageNumber(pageInput ?? '', count)
    setPageInput(null)
    if (n) goTo(n)
  }

  const slotNodes: ReactNode[] = []
  if (sizes) {
    for (let i = Math.max(0, mounted[0]); i <= Math.min(count - 1, mounted[1]); i++) {
      const w = Math.floor(sizes[i].w * zoom)
      slotNodes.push(
        <div
          key={i}
          ref={(el) => {
            if (el) slotEls.current.set(i, el)
            else slotEls.current.delete(i)
          }}
          className="nd-pdf-page"
          data-page={i + 1}
          style={{ width: w, height: slots.heights[i], top: slots.tops[i], left: Math.max(PAD, Math.floor((innerWidth - w) / 2)) }}
        />,
      )
    }
  }

  const overlay = variant === 'overlay'
  const tb = overlay ? `${BTN} !text-white/85 hover:!bg-white/15 hover:!text-white` : BTN
  return (
    <>
      <div className={`flex flex-wrap items-center gap-0.5 px-1.5 py-1 ${overlay ? 'nd-pdf-bar text-white' : 'border-b border-line'}`} data-testid="pdf-toolbar">
        {!overlay && onCollapse && (
          <button type="button" className={`${tb} gap-1 px-2 text-xs`} onClick={onCollapse} aria-expanded={true} title={t('pdfPreview.collapse')} data-testid="pdf-collapse">
            <ChevronDownIcon size={14} />
            <span className="max-sm:hidden">{t('pdfPreview.collapse')}</span>
          </button>
        )}
        <form onSubmit={submitPage} className="flex items-center gap-1 px-1 text-xs tabular-nums">
          <input
            type="text"
            inputMode="numeric"
            enterKeyHint="go"
            aria-label={t('pdfPreview.pageNumber')}
            className={`h-7 w-11 rounded border px-1 text-center text-xs ${overlay ? 'border-white/30 bg-white/10 text-white' : 'border-line bg-app text-ink'}`}
            value={pageInput ?? String(current)}
            onFocus={(e) => {
              setPageInput(String(current))
              e.currentTarget.select()
            }}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => setPageInput(null)}
            data-testid="pdf-page-input"
          />
          <span className={overlay ? 'text-white/70' : 'text-sub'} data-testid="pdf-page-count">
            {t('pdfPreview.ofPages', { total: count })}
          </span>
        </form>
        <span className="flex-1" />
        <button type="button" className={tb} onClick={() => setZoom(stepZoom(zoom, -1))} aria-label={t('pdfPreview.zoomOut')} title={t('pdfPreview.zoomOut')} data-testid="pdf-zoom-out">
          <span aria-hidden="true" className="text-base leading-none">−</span>
        </button>
        <span className={`w-11 text-center text-xs tabular-nums ${overlay ? 'text-white/85' : 'text-sub'}`} data-testid="pdf-zoom" data-zoom={zoom.toFixed(4)} data-mode={zoomMode === 'fit' ? 'fit' : 'fixed'}>
          {percent(zoom)}
        </span>
        <button type="button" className={tb} onClick={() => setZoom(stepZoom(zoom, 1))} aria-label={t('pdfPreview.zoomIn')} title={t('pdfPreview.zoomIn')} data-testid="pdf-zoom-in">
          <span aria-hidden="true" className="text-base leading-none">+</span>
        </button>
        <button
          type="button"
          className={tb}
          onClick={() => setZoom('fit')}
          aria-label={t('pdfPreview.fitWidth')}
          title={t('pdfPreview.fitWidth')}
          aria-pressed={zoomMode === 'fit'}
          data-testid="pdf-fit-width"
        >
          <WidthIcon size={16} />
        </button>
        {!overlay && onFullscreen && (
          <button type="button" className={tb} onClick={onFullscreen} aria-label={t('pdfPreview.fullscreen')} title={t('pdfPreview.fullscreen')} data-testid="pdf-fullscreen">
            <ExpandIcon size={16} />
          </button>
        )}
        {download}
        {overlay && onClose && (
          <button type="button" className={tb} onClick={() => onClose(current)} aria-label={t('pdfPreview.close')} title={t('pdfPreview.close')} data-testid="pdf-close">
            <XIcon size={18} />
          </button>
        )}
      </div>
      <div
        ref={scrollerRef}
        className={`nd-pdf-scroll ${overlay ? 'nd-pdf-scroll-full' : ''}`}
        tabIndex={0}
        aria-label={t('pdfPreview.pages')}
        data-testid="pdf-scroller"
        data-current={current}
      >
        <div className="nd-pdf-pages" style={{ height: slots.total || undefined, width: innerWidth }}>
          {slotNodes}
        </div>
      </div>
    </>
  )
}

/** The page's links: http/https as new-tab anchors, links inside the document as buttons. */
async function linkLayer(doc: PDFDocumentProxy, page: PDFPageProxy, jump: (page: number) => void): Promise<HTMLDivElement | undefined> {
  let annots: { subtype?: string; rect?: number[]; url?: string; dest?: unknown }[]
  try {
    annots = (await page.getAnnotations({ intent: 'display' })) as typeof annots
  } catch {
    return undefined
  }
  const links = annots.filter((a) => a.subtype === 'Link' && Array.isArray(a.rect) && a.rect.length === 4)
  if (links.length === 0) return undefined
  const vp = page.getViewport({ scale: 1 })
  const layer = document.createElement('div')
  layer.className = 'nd-pdf-links'
  for (const a of links) {
    const [x1, y1] = vp.convertToViewportPoint(a.rect![0], a.rect![1]) as number[]
    const [x2, y2] = vp.convertToViewportPoint(a.rect![2], a.rect![3]) as number[]
    const box = {
      left: `${(Math.min(x1, x2) / vp.width) * 100}%`,
      top: `${(Math.min(y1, y2) / vp.height) * 100}%`,
      width: `${(Math.abs(x2 - x1) / vp.width) * 100}%`,
      height: `${(Math.abs(y2 - y1) / vp.height) * 100}%`,
    }
    const href = safeLinkUrl(a.url)
    let el: HTMLElement | null = null
    if (href) {
      const link = document.createElement('a')
      link.href = href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.title = href
      link.setAttribute('data-pdf-link', 'external')
      el = link
    } else if (a.dest && !a.url) {
      const target = await destPage(doc, a.dest)
      if (target) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute('aria-label', t('pdfPreview.goToPage', { n: target }))
        btn.setAttribute('data-pdf-link', 'internal')
        btn.addEventListener('click', () => jump(target))
        el = btn
      }
    }
    if (!el) continue
    el.className = 'nd-pdf-link'
    Object.assign(el.style, box)
    layer.appendChild(el)
  }
  return layer.childElementCount ? layer : undefined
}

/** 1-based page of a link's destination inside the document, or null. */
async function destPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit.length === 0) return null
    const ref = explicit[0]
    const index = typeof ref === 'object' && ref !== null ? await doc.getPageIndex(ref as never) : Number.isInteger(ref) ? (ref as number) : -1
    return index >= 0 && index < doc.numPages ? index + 1 : null
  } catch {
    return null
  }
}

// ── full screen ───────────────────────────────────────────────────────────────────────────────────
/**
 * The full-screen view: a dialog on <body> over everything (the rest of the body is inert, the page
 * does not scroll). Esc, the close button and browser Back close it; the inline preview then shows the
 * page the dialog was on. Keys are taken in the capture phase so the editor and the app's shortcuts do
 * not see them (as in the image viewer, docs/adr/2386-*).
 */
function Overlay({ onClose, children }: { onClose: (page: number | null) => void; children: (close: (page: number) => void) => ReactNode }) {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.setAttribute('data-pdf-viewer-root', '')
    return el
  })
  const dialogRef = useRef<HTMLDivElement>(null)
  const closed = useRef(false)
  const lastPage = useRef<number | null>(null)
  const close = useCallback(
    (page: number | null) => {
      if (closed.current) return
      closed.current = true
      onClose(page)
    },
    [onClose],
  )

  useLayoutEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const madeInert: HTMLElement[] = []
    for (const el of Array.from(document.body.children)) {
      if (el instanceof HTMLElement && !el.inert && el.tagName !== 'SCRIPT') {
        el.inert = true
        madeInert.push(el)
      }
    }
    document.body.appendChild(host)
    const html = document.documentElement
    const prevOverflow = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      for (const el of madeInert) el.inert = false
      html.style.overflow = prevOverflow
      host.remove()
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [host])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.isComposing) return
      // the browser's undo would reach the page body under the dialog (same test as lib/pdfFile.ts
      // isUndoKey, written out so this lazy chunk does not import the editor's module)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        close(currentPage())
      } else if (e.key === 'Tab') {
        const root = dialogRef.current
        if (!root) return
        const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, [tabindex="0"]')).filter((el) => el.getClientRects().length > 0)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (!root.contains(active) || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
        }
      }
    }
    const swallow = (e: KeyboardEvent) => e.stopPropagation()
    const onPop = () => close(currentPage())
    // the dialog's own handlers (zoom keys in PdfView) run before this one: they listen on window
    // in the capture phase too, registered earlier by the child's effect
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', swallow, true)
    window.addEventListener('keypress', swallow, true)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', swallow, true)
      window.removeEventListener('keypress', swallow, true)
      window.removeEventListener('popstate', onPop)
    }
  }, [close])

  const currentPage = () => {
    const v = dialogRef.current?.querySelector('[data-testid="pdf-scroller"]')?.getAttribute('data-current')
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : lastPage.current
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('pdfPreview.dialog')}
      className="nd-pdf-full fixed inset-0 z-[200] flex flex-col"
      data-testid="pdf-fullscreen-view"
    >
      {children((page) => close(page))}
    </div>,
    host,
  )
}
