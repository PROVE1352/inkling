import { useEffect, useRef, useState } from 'react'
import { usePages } from '../../api'
import { useT } from '../../i18n'
import { PageIconGlyph } from '../PageIconGlyph'
import { CANVAS_PRESETS } from './canvasColors'
import { LinkIcon, PlusIcon, TrashIcon } from '../Icons'

// Canvas top toolbar: add text/page/link, pick a color, delete.
export function Toolbar({
  wsId,
  currentPageId,
  selectionCount,
  onAddText,
  onAddPage,
  onAddLink,
  onSetColor,
  onDelete,
}: {
  wsId: string
  currentPageId: string
  selectionCount: number
  onAddText: () => void
  onAddPage: (pageId: string) => void
  onAddLink: (url: string) => void
  onSetColor: (color: string | undefined) => void
  onDelete: () => void
}) {
  const t = useT()
  const pages = usePages(wsId)
  const [open, setOpen] = useState<null | 'page' | 'link' | 'color'>(null)
  const [query, setQuery] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(null)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const matched = (pages.data ?? [])
    .filter((p) => p.id !== currentPageId && p.kind !== 'folder')
    .filter((p) => (q.length === 0 ? true : (p.title || '').toLowerCase().includes(q)))
    .slice(0, 8)

  const submitLink = () => {
    const url = linkUrl.trim()
    if (!url) return
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    onAddLink(normalized)
    setLinkUrl('')
    setOpen(null)
  }

  const btn =
    'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink'

  return (
    <div
      ref={wrapRef}
      className="pointer-events-auto absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-line bg-app/95 px-1.5 py-1 shadow-md backdrop-blur"
    >
      <button type="button" onClick={onAddText} className={btn} title={t('canvas.addTextTitle')}>
        <PlusIcon size={15} /> {t('canvas.text')}
      </button>

      {/* Add page card (search popup) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => (v === 'page' ? null : 'page'))}
          className={btn}
          title={t('canvas.addPageTitle')}
        >
          <span className="text-[13px] leading-none">📄</span> {t('common.page')}
        </button>
        {open === 'page' && (
          <div className="absolute left-0 top-full mt-1 w-64 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('canvas.searchPages')}
              className="mb-1 w-full border-b border-line bg-transparent px-3 py-1.5 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none"
            />
            <div className="max-h-64 overflow-y-auto">
              {matched.length === 0 ? (
                <p className="px-3 py-2 text-xs text-sub">{t('common.noResults')}</p>
              ) : (
                matched.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onAddPage(p.id)
                      setQuery('')
                      setOpen(null)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
                  >
                    <span className="shrink-0 text-[14px] leading-none"><PageIconGlyph page={p} size={14} /></span>
                    <span className="min-w-0 flex-1 truncate">{p.title || t('common.untitled')}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Add link card */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => (v === 'link' ? null : 'link'))}
          className={btn}
          title={t('canvas.addLinkTitle')}
        >
          <LinkIcon size={14} /> {t('canvas.link')}
        </button>
        {open === 'link' && (
          <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-line bg-app p-2 shadow-xl">
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitLink()
                }
              }}
              placeholder="https://example.com"
              className="w-full rounded border border-line bg-transparent px-2 py-1 text-sm text-ink placeholder:text-sub/60 focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={submitLink}
              className="mt-1.5 w-full rounded bg-accent px-2 py-1 text-sm text-white hover:opacity-90"
            >
              {t('common.add')}
            </button>
          </div>
        )}
      </div>

      <div className="mx-0.5 h-5 w-px bg-line" />

      {/* Color picker (applies to the selected nodes/edges) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => (v === 'color' ? null : 'color'))}
          disabled={selectionCount === 0}
          className={`${btn} disabled:opacity-40`}
          title={t('canvas.pickColor')}
        >
          <span className="h-3.5 w-3.5 rounded-full border border-line bg-gradient-to-br from-red-400 via-yellow-300 to-purple-400" />
          {t('canvas.color')}
        </button>
        {open === 'color' && (
          <div className="absolute left-0 top-full mt-1 flex w-max gap-1 rounded-md border border-line bg-app p-1.5 shadow-xl">
            <button
              type="button"
              onClick={() => {
                onSetColor(undefined)
                setOpen(null)
              }}
              title={t('canvas.noColor')}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-xs text-sub hover:bg-hover"
            >
              ✕
            </button>
            {CANVAS_PRESETS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  onSetColor(c.key)
                  setOpen(null)
                }}
                title={c.label}
                className="h-6 w-6 rounded-full border border-line transition-transform hover:scale-110"
                style={{ background: c.hex }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onDelete}
        disabled={selectionCount === 0}
        className={`${btn} hover:!text-red-600 disabled:opacity-40`}
        title={t('canvas.deleteSelectionTitle')}
      >
        <TrashIcon size={14} /> {t('common.delete')}
      </button>
    </div>
  )
}
