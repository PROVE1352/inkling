import { useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import type { CollectionField, CollectionViewDTO, MemberDTO, RowDTO } from '@inkling/shared'
import { isPersonLikeType } from '@inkling/shared'
import { applyView, orderedFields } from '../../lib/collection'
import { viewTree } from '../../lib/collectionTree'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { useT } from '../../i18n'
import { FileTextIcon, PlusIcon } from '../Icons'
import { FieldValue } from './cells/FieldValue'
import { useCollectionReadOnly } from './readOnlyContext'
import { TreeToggle, useCollapsedRows } from './subItems'

/** One line per row; above this many rows the list is windowed. */
const ROW_H = 36
const WINDOW_THRESHOLD = 150
/** properties shown inline after the title */
const MAX_PROPS = 8

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/**
 * List view (0.17): compact rows — icon and title, then the view's shown properties as small
 * inline values (the same columnOrder / hiddenFields, sorts and filter keys as a table). Sub-items
 * show as a tree like the table (docs/adr/2144-*). A click opens the row.
 */
export function ListView({
  view,
  fields,
  rows,
  members,
  wsId,
  onCreateRow,
  creatingRow,
  collectionId,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  members?: MemberDTO[]
  wsId: string
  onCreateRow?: () => void
  creatingRow?: boolean
  /** the collection's page id: narrows the sub-items field to a relation to itself */
  collectionId?: string
}) {
  const t = useT()
  const navigate = useNavigate()
  const readOnly = useCollectionReadOnly()
  const config = view.config
  const shown = useMemo(() => orderedFields(fields, config).slice(0, MAX_PROPS), [fields, config])
  const filtered = useMemo(() => applyView(rows, fields, config), [rows, fields, config])
  const [collapsed, toggle] = useCollapsedRows(view.id)
  const tree = useMemo(
    () => viewTree(filtered, fields, config, collapsed, collectionId),
    [filtered, fields, config, collapsed, collectionId],
  )
  const display = tree.rows

  const listRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: display.length, rowHeight: ROW_H, listRef, threshold: WINDOW_THRESHOLD })
  const visible = display.slice(win.start, win.end)

  return (
    <div className="pt-2">
      <div
        ref={listRef}
        role="list"
        aria-label={view.name}
        style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}
      >
        {visible.map((row) => {
          const meta = tree.meta?.get(row.id)
          // nested: the tree already shows the parent
          const props = shown.filter((f) => !(tree.meta && f.id === tree.parentField?.id) && !isEmpty(row.props[f.id]))
          return (
            <div
              key={row.id}
              role="listitem"
              className="group/li flex min-w-0 items-center gap-1 border-b border-line/60 px-1 hover:bg-hover/40"
              style={{ height: ROW_H }}
            >
              {meta && (
                <TreeToggle
                  depth={meta.depth}
                  childCount={meta.childCount}
                  collapsed={collapsed.has(row.id)}
                  onToggle={() => toggle(row.id)}
                />
              )}
              <button
                type="button"
                onClick={() => navigate(`/w/${wsId}/p/${row.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden py-1 text-left"
              >
                <span className="flex min-w-0 shrink items-center gap-1.5">
                  <span className="shrink-0 text-sub">{row.icon ?? <FileTextIcon size={14} />}</span>
                  <span className="truncate text-sm font-medium text-ink">
                    {row.title || <span className="text-sub/60">{t('common.untitled')}</span>}
                  </span>
                </span>
                {props.length > 0 && (
                  <span className="ml-auto flex min-w-0 shrink-[2] items-center justify-end gap-3 overflow-hidden text-xs [&_*]:text-xs">
                    {props.map((f) => (
                      <span key={f.id} className="flex min-w-0 max-w-[14rem] shrink items-center overflow-hidden" title={f.name}>
                        <FieldValue
                          field={f}
                          value={row.props[f.id]}
                          members={members}
                          rowProps={isPersonLikeType(f.type) ? row.props : undefined}
                        />
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </div>
          )
        })}
      </div>
      {display.length === 0 && (
        <div className="border-b border-line px-3 py-4 text-sm text-sub">
          {rows.length === 0 ? t('table.noRows') : t('table.noMatches')}
        </div>
      )}
      {!readOnly && onCreateRow && (
        <button
          type="button"
          onClick={onCreateRow}
          disabled={creatingRow}
          data-print-hide
          className="mt-1 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          <PlusIcon size={15} /> {t('table.newRow')}
        </button>
      )}
    </div>
  )
}
