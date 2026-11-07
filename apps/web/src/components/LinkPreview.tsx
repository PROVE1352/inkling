import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { usePages } from '../api'
import { t, useT, type TKey } from '../i18n'
import { kindLabel } from '../lib/pageIcon'
import { PageIconGlyph } from './PageIconGlyph'

// Internal link preview (like Obsidian's "Page preview") — hovering a wikilink in the body (<a href="/w/…/p/…">)
// or a page mention chip for ~500ms shows the title + the first 12 lines.
// Events are delegated to the container (mouseover/mouseout), so there are only 2 listeners regardless of link count.
// The body is fetched via the existing single-page md export (GET /api/pages/:id/export?format=md) and kept in a module cache
// (that endpoint is limited to 20 requests/minute, so caching is required — hovering the same link again sends no request).

const HOVER_MS = 500
const HIDE_MS = 200
const CACHE_TTL = 60_000
const MAX_LINES = 12

/** `error` holds a dictionary key, translated at render time. */
type Entry = { lines: Line[] | null; error?: TKey; at: number }
type Line = { text: string; heading?: boolean }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Entry>>()

// Lightly turn markdown into plain preview lines (no renderer).
function mdToLines(md: string): Line[] {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const out: Line[] = []
  let inCode = false
  for (const raw of body.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      continue
    }
    let line = raw.trimEnd()
    if (!line.trim()) continue
    let heading = false
    if (!inCode) {
      const h = line.match(/^#{1,6}\s+(.*)$/)
      if (h) {
        line = h[1]
        heading = true
      }
      line = line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, `[${t('linkPreview.image')}]`)
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ')
        .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/^>\s?/, '│ ')
        .replace(/(\*\*|__|~~|`)/g, '')
    }
    out.push({ text: line, heading })
    if (out.length >= MAX_LINES) break
  }
  return out
}

function loadPreview(pageId: string): Promise<Entry> {
  const hit = cache.get(pageId)
  if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit)
  const pending = inflight.get(pageId)
  if (pending) return pending
  const p = fetch(`/api/pages/${pageId}/export?format=md`, { credentials: 'same-origin' })
    .then(async (res): Promise<Entry> => {
      if (res.status === 429) return { lines: null, error: 'linkPreview.rateLimited', at: Date.now() }
      if (!res.ok) return { lines: null, error: 'linkPreview.unavailable', at: Date.now() }
      return { lines: mdToLines(await res.text()), at: Date.now() }
    })
    .catch(() => ({ lines: null, error: 'linkPreview.unavailable', at: Date.now() }) as Entry)
    .then((entry) => {
      inflight.delete(pageId)
      // Transient errors (429) are not cached, so the next hover retries
      if (entry.lines) {
        cache.set(pageId, entry)
        // Cache cap — evict oldest first (prevents memory buildup)
        if (cache.size > 50) cache.delete(cache.keys().next().value as string)
      }
      return entry
    })
  inflight.set(pageId, p)
  return p
}

// Hover target → page id (wikilink href or mention chip data-page-id)
function targetPageId(el: EventTarget | null): { id: string; anchor: HTMLElement } | null {
  if (!(el instanceof Element)) return null
  const mention = el.closest<HTMLElement>('[data-page-id]')
  if (mention?.dataset.pageId) return { id: mention.dataset.pageId, anchor: mention }
  const a = el.closest<HTMLAnchorElement>('a[href]')
  if (!a) return null
  const m = (a.getAttribute('href') ?? '').match(/^\/w\/[^/]+\/p\/([^/?#]+)/)
  return m ? { id: m[1], anchor: a } : null
}

type Open = { id: string; rect: DOMRect }

export function LinkPreview({
  wsId,
  containerRef,
}: {
  wsId: string
  containerRef: RefObject<HTMLElement | null>
}) {
  const tr = useT()
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const [open, setOpen] = useState<Open | null>(null)
  const [entry, setEntry] = useState<Entry | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  const popRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const onOver = (e: MouseEvent) => {
      const t = targetPageId(e.target)
      if (!t) return
      window.clearTimeout(hideTimer.current)
      if (hoverRef.current === t.anchor) return
      hoverRef.current = t.anchor
      window.clearTimeout(showTimer.current)
      showTimer.current = window.setTimeout(() => {
        if (!t.anchor.isConnected) return
        setOpen({ id: t.id, rect: t.anchor.getBoundingClientRect() })
      }, HOVER_MS)
    }
    const onOut = (e: MouseEvent) => {
      if (!hoverRef.current) return
      const to = e.relatedTarget as Node | null
      if (to && (hoverRef.current.contains(to) || popRef.current?.contains(to))) return
      hoverRef.current = null
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => setOpen(null), HIDE_MS)
    }
    // Close immediately once clicking, scrolling or typing starts
    const close = () => {
      hoverRef.current = null
      window.clearTimeout(showTimer.current)
      setOpen(null)
    }
    root.addEventListener('mouseover', onOver)
    root.addEventListener('mouseout', onOut)
    root.addEventListener('mousedown', close)
    root.addEventListener('scroll', close, { passive: true })
    root.addEventListener('keydown', close)
    return () => {
      root.removeEventListener('mouseover', onOver)
      root.removeEventListener('mouseout', onOut)
      root.removeEventListener('mousedown', close)
      root.removeEventListener('scroll', close)
      root.removeEventListener('keydown', close)
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
    }
  }, [containerRef])

  const page = open ? pages.data?.find((p) => p.id === open.id) : undefined
  const isDoc = page?.kind === 'doc'

  useEffect(() => {
    if (!open || !isDoc) {
      setEntry(null)
      return
    }
    let alive = true
    const cached = cache.get(open.id)
    setEntry(cached ?? null)
    void loadPreview(open.id).then((e) => {
      if (alive) setEntry(e)
    })
    return () => {
      alive = false
    }
  }, [open, isDoc])

  if (!open) return null

  // Show below the link (above it if there's no room). Clamp horizontally to stay on screen.
  const W = 340
  const left = Math.max(8, Math.min(open.rect.left, window.innerWidth - W - 8))
  const below = window.innerHeight - open.rect.bottom > 260
  const style = below
    ? { left, top: open.rect.bottom + 6, width: W }
    : { left, bottom: window.innerHeight - open.rect.top + 6, width: W }

  return createPortal(
    <div
      ref={popRef}
      role="tooltip"
      data-link-preview
      style={style}
      onMouseEnter={() => window.clearTimeout(hideTimer.current)}
      onMouseLeave={() => {
        hoverRef.current = null
        hideTimer.current = window.setTimeout(() => setOpen(null), HIDE_MS)
      }}
      className="nd-pop fixed z-50 max-h-72 overflow-hidden rounded-lg border border-line bg-app p-3 shadow-xl"
    >
      <button
        type="button"
        onClick={() => {
          setOpen(null)
          navigate(`/w/${wsId}/p/${open.id}`)
        }}
        className="mb-1.5 flex w-full items-center gap-1.5 text-left text-sm font-semibold text-ink hover:underline"
      >
        <span className="shrink-0 text-[15px] leading-none"><PageIconGlyph page={page ?? { icon: null, kind: 'doc' }} size={15} /></span>
        <span className="min-w-0 flex-1 truncate">
          {page ? page.title || tr('common.untitled') : tr('linkPreview.notFound')}
        </span>
      </button>
      {!page ? (
        <p className="text-xs text-sub">{tr('linkPreview.notFoundBody')}</p>
      ) : !isDoc ? (
        <p className="text-xs text-sub">{kindLabel(page.kind)}</p>
      ) : !entry ? (
        <p className="text-xs text-sub">{tr('common.loading')}</p>
      ) : entry.error ? (
        <p className="text-xs text-sub">{tr(entry.error)}</p>
      ) : entry.lines && entry.lines.length === 0 ? (
        <p className="text-xs text-sub">{tr('linkPreview.empty')}</p>
      ) : (
        <div className="flex flex-col gap-0.5 text-xs leading-relaxed text-sub">
          {entry.lines!.map((l, i) => (
            <p
              key={i}
              className={`truncate ${l.heading ? 'font-semibold text-ink' : ''}`}
            >
              {l.text}
            </p>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
