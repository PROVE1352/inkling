import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { CollectionField, CollectionViewDTO, MemberDTO, RowDTO } from '@inkling/shared'
import { applyView } from '../../lib/collection'
import { useCovers } from '../../lib/collectionApi'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { FileTextIcon, PlusIcon } from '../Icons'
import { FieldValue } from './cells/FieldValue'
import { S } from './strings'

const MIN_WIDTH = { sm: 180, md: 240, lg: 320 } as const
const COVER_H = { sm: 96, md: 136, lg: 184 } as const
const GAP = 12
const TITLE_H = 40
const PROP_H = 24
const MAX_PROPS = 6

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * Gallery (card grid). Cards have a fixed height so rows of cards can be windowed with the
 * same hook as the table — 10k rows render only the visible card rows.
 */
export function GalleryView({
  view,
  fields,
  rows,
  members,
  wsId,
  pageId,
  onCreateRow,
  creatingRow,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  members?: MemberDTO[]
  wsId: string
  pageId: string
  onCreateRow: () => void
  creatingRow?: boolean
}) {
  const navigate = useNavigate()
  const config = view.config
  const size = config.cardSize ?? 'md'
  const coverMode = config.cardCover ?? 'cover'
  const covers = useCovers(pageId, coverMode === 'firstImage')
  const display = useMemo(() => applyView(rows, fields, config), [rows, fields, config])
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const cardFields = (config.cardFieldIds ?? [])
    .map((id) => byId.get(id))
    .filter((f): f is CollectionField => !!f)
    .slice(0, MAX_PROPS)

  const listRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(1, Math.floor((width + GAP) / (MIN_WIDTH[size] + GAP)))
  const coverH = coverMode === 'none' ? 0 : COVER_H[size]
  const cardH = coverH + TITLE_H + cardFields.length * PROP_H + (cardFields.length ? 8 : 0)
  const rowH = cardH + GAP
  const lineCount = Math.ceil(display.length / cols)
  const win = useWindowedRows({ count: lineCount, rowHeight: rowH, listRef, threshold: 30 })

  const coverOf = (row: RowDTO): string | null => {
    if (coverMode === 'cover') return row.coverUrl
    if (coverMode === 'firstImage') return covers.data?.[row.id] ?? row.coverUrl
    return null
  }

  const lines: RowDTO[][] = []
  for (let i = win.start; i < win.end; i++) lines.push(display.slice(i * cols, i * cols + cols))

  return (
    <div className="pt-3">
      <div ref={listRef} style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
        {lines.map((line, li) => (
          <div
            key={win.start + li}
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: GAP,
              height: cardH,
              marginBottom: GAP,
            }}
          >
            {line.map((row) => {
              const cover = coverOf(row)
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => navigate(`/w/${wsId}/p/${row.id}`)}
                  className="nd-print-avoid flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-app text-left shadow-sm transition hover:bg-hover/40 hover:shadow"
                  style={{ height: cardH }}
                >
                  {coverH > 0 && (
                    <div className="w-full shrink-0 overflow-hidden bg-side/60" style={{ height: coverH }}>
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-3xl text-sub/40">
                          {row.icon ?? <FileTextIcon size={28} />}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex min-w-0 items-center gap-1.5 px-3" style={{ height: TITLE_H }}>
                    {row.icon && <span className="shrink-0">{row.icon}</span>}
                    <span className="truncate text-sm font-medium text-ink">
                      {row.title || <span className="text-sub/60">{S.untitled}</span>}
                    </span>
                  </div>
                  {cardFields.length > 0 && (
                    <div className="flex min-w-0 flex-col px-3 pb-2">
                      {cardFields.map((f) => (
                        <div key={f.id} className="flex min-w-0 items-center overflow-hidden" style={{ height: PROP_H }}>
                          {isEmpty(row.props[f.id]) ? null : (
                            <FieldValue field={f} value={row.props[f.id]} members={members} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onCreateRow}
        disabled={creatingRow}
        data-print-hide
        className="mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
      >
        <PlusIcon size={15} /> {S.newCard}
      </button>
    </div>
  )
}
