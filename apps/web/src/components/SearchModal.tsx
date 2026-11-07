import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { usePages, useSearch } from '../api'
import type { PageMetaDTO } from '@inkling/shared'
import { highlight } from '../lib/highlight'
import { PageIconGlyph } from './PageIconGlyph'
import { relativeTime } from '../lib/time'
import { SearchIcon } from './Icons'
import { Spinner } from './Spinner'
import { useT } from '../i18n'

// mode: 'all' = server search (title + body snippet, ⌘K·⌘⇧F) / 'title' = quick switcher (⌘O) —
// filters titles and aliases of the already-loaded page list instantly. Empty input → most recently edited.
export type SearchMode = 'all' | 'title'

export function SearchModal({
  open,
  onClose,
  wsId,
  initialQuery = '',
  mode = 'all',
}: {
  open: boolean
  onClose: () => void
  wsId: string
  initialQuery?: string
  mode?: SearchMode
}) {
  const t = useT()
  const navigate = useNavigate()
  const [query, setQuery] = useState(initialQuery)
  const [debounced, setDebounced] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<number | undefined>(undefined)

  // Apply the initial query + focus when opened
  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setDebounced(initialQuery)
    setSelected(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, initialQuery])

  // 250 ms debounce
  useEffect(() => {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setDebounced(query), 250)
    return () => window.clearTimeout(timerRef.current)
  }, [query])

  const titleMode = mode === 'title'
  const search = useSearch(wsId, titleMode ? '' : debounced)
  const pages = usePages(wsId)
  // Quick switcher: uses the raw input without debounce (the list is already in memory)
  const titleResults = useMemo<(PageMetaDTO & { snippet?: string })[]>(() => {
    if (!titleMode) return []
    const q = query.trim().toLowerCase()
    const alive = (pages.data ?? []).filter((p) => !p.deletedAt)
    if (!q) {
      return [...alive].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)
    }
    const hit = (p: PageMetaDTO) =>
      (p.title || t('common.untitled')).toLowerCase().includes(q) ||
      (p.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    // Titles that start with the query come first
    const starts = (p: PageMetaDTO) => ((p.title || '').toLowerCase().startsWith(q) ? 0 : 1)
    return alive
      .filter(hit)
      .sort((a, b) => starts(a) - starts(b) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
  }, [titleMode, query, pages.data, t])
  const results = useMemo(
    () => (titleMode ? titleResults : (search.data ?? [])),
    [titleMode, titleResults, search.data],
  )

  useEffect(() => {
    setSelected(0)
  }, [results])

  const go = (index: number) => {
    const page = results[index]
    if (!page) return
    onClose()
    navigate(`/w/${wsId}/p/${page.id}`)
  }

  if (!open) return null

  const showList = titleMode || debounced.trim().length > 0

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-2 pt-3 sm:p-4 sm:pt-[12dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titleMode ? t('search.quickSwitch') : t('common.search')}
        data-search-mode={mode}
        className="nd-pop flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg sm:max-h-[70dvh] flex-col overflow-hidden rounded-lg border border-line bg-app shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <SearchIcon size={18} className="shrink-0 text-sub" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((s) => Math.min(s + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                go(selected)
              }
            }}
            placeholder={titleMode ? t('search.quickSwitchPlaceholder') : t('search.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-sub focus-visible:outline-none"
          />
          {!titleMode && search.isFetching && <Spinner size={15} />}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!showList ? (
            <p className="px-3 py-6 text-center text-xs text-sub">
              {t('search.typeToSearch')}
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-sub">
              {!titleMode && search.isFetching ? t('search.searching') : t('common.noResults')}
            </p>
          ) : (
            results.map((page, i) => (
              <button
                key={page.id}
                type="button"
                onMouseEnter={() => setSelected(i)}
                onClick={() => go(i)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors duration-100 ${
                  i === selected ? 'bg-active text-ink' : 'text-ink hover:bg-hover'
                }`}
              >
                <span className="shrink-0 pt-px text-[15px] leading-none">
                  <PageIconGlyph page={page} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {highlight(page.title || t('common.untitled'), titleMode ? query : debounced)}
                    </span>
                    <span className="shrink-0 text-xs text-sub">
                      {relativeTime(page.updatedAt)}
                    </span>
                  </span>
                  {page.snippet ? (
                    <span className="mt-0.5 block truncate text-xs text-sub">
                      {highlight(page.snippet, debounced)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
