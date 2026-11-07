import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollectionField, RowRefDTO } from '@inkling/shared'
import { useRowOptions } from '../../../lib/collectionApi'
import { formatNumber } from '../../../lib/collection'
import { CheckIcon, FileTextIcon, SearchIcon } from '../../Icons'
import { useCollectionRefs } from '../refsContext'
import { S } from '../strings'

/** Resolve linked-row titles: collection refs (context) first, else the target's option list. */
function useRefLookup(field: CollectionField, ids: string[]) {
  const refs = useCollectionRefs()
  const missing = ids.some((id) => !refs?.[id])
  const fallback = useRowOptions(field.relation?.targetPageId, '', missing && ids.length > 0)
  return (id: string): RowRefDTO | undefined =>
    refs?.[id] ?? fallback.data?.rows.find((r) => r.id === id)
}

export function RelationChips({ field, value }: { field: CollectionField; value: unknown }) {
  const ids = Array.isArray(value) ? (value as string[]) : []
  const lookup = useRefLookup(field, ids)
  if (ids.length === 0) return null
  const known = ids.map(lookup).filter((r): r is RowRefDTO => !!r)
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {known.map((r) => (
        <span
          key={r.id}
          className="inline-flex max-w-full items-center gap-1 truncate rounded bg-hover px-1.5 py-0.5 text-xs text-ink"
        >
          {r.icon ? <span>{r.icon}</span> : <FileTextIcon size={12} className="shrink-0 text-sub" />}
          <span className="truncate underline decoration-line underline-offset-2">
            {r.title || S.untitled}
          </span>
        </span>
      ))}
      {known.length < ids.length && (
        <span className="text-xs text-sub">{S.relationHiddenCount(ids.length - known.length)}</span>
      )}
    </span>
  )
}

export function RollupValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    return (
      <span className="flex min-w-0 flex-wrap gap-1">
        {value.map((v) => (
          <span key={String(v)} className="truncate rounded bg-hover px-1.5 py-0.5 text-xs text-ink">
            {String(v)}
          </span>
        ))}
      </span>
    )
  }
  return (
    <span className="truncate text-sm text-ink">
      {typeof value === 'number' ? formatNumber(value) : String(value)}
    </span>
  )
}

export function RelationCell({
  field,
  value,
  onCommit,
}: {
  field: CollectionField
  value: unknown
  onCommit: (value: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const ids = Array.isArray(value) ? (value as string[]) : []
  const options = useRowOptions(field.relation?.targetPageId, debounced, open)

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 200)
    return () => window.clearTimeout(t)
  }, [q])

  const close = useCallback(() => setOpen(false), [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    onCommit(next.length ? next : null)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[30px] w-full items-center gap-1 px-2 py-1 text-left text-sm hover:bg-hover"
      >
        <RelationChips field={field} value={value} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-md border border-line bg-app shadow-xl">
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
            <SearchIcon size={14} className="text-sub" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={S.relationSearch}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {options.data?.rows.length === 0 && (
              <p className="px-3 py-2 text-xs text-sub">{S.relationEmpty}</p>
            )}
            {options.data?.rows.map((r) => {
              const on = ids.includes(r.id)
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      on ? 'border-accent bg-accent text-white' : 'border-line'
                    }`}
                  >
                    {on && <CheckIcon size={11} />}
                  </span>
                  {r.icon && <span>{r.icon}</span>}
                  <span className="truncate">{r.title || S.untitled}</span>
                </button>
              )
            })}
            {options.data?.more && <p className="px-3 py-1.5 text-[11px] text-sub">{S.relationMore}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
