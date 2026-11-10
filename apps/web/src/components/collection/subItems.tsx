import { useCallback, useEffect, useState } from 'react'
import { t } from '../../i18n'
import { loadCollapsed, saveCollapsed, toggleCollapsed } from '../../lib/collectionTree'
import { ChevronDownIcon, ChevronRightIcon } from '../Icons'

/** Indentation per sub-item level (px). */
export const SUB_ITEM_INDENT = 16

/** Rows collapsed in a view's tree, kept per view in this browser (docs/adr/2144-*). */
export function useCollapsedRows(viewId: string): [Set<string>, (rowId: string) => void, (rowId: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(viewId))
  useEffect(() => setCollapsed(loadCollapsed(viewId)), [viewId])
  const toggle = useCallback(
    (rowId: string) =>
      setCollapsed((cur) => {
        const next = toggleCollapsed(cur, rowId)
        saveCollapsed(viewId, next)
        return next
      }),
    [viewId],
  )
  const expand = useCallback(
    (rowId: string) =>
      setCollapsed((cur) => {
        if (!cur.has(rowId)) return cur
        const next = toggleCollapsed(cur, rowId)
        saveCollapsed(viewId, next)
        return next
      }),
    [viewId],
  )
  return [collapsed, toggle, expand]
}

/** Indentation and the disclosure toggle in front of a row's title (a spacer for rows without children). */
export function TreeToggle({
  depth,
  childCount,
  collapsed,
  onToggle,
}: {
  depth: number
  childCount: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <span className="flex shrink-0 items-center" style={{ paddingLeft: depth * SUB_ITEM_INDENT }}>
      {childCount > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('subItems.expand') : t('subItems.collapse')}
          title={collapsed ? t('subItems.expand') : t('subItems.collapse')}
          className="flex h-5 w-5 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
        >
          {collapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
        </button>
      ) : (
        <span className="h-5 w-5" />
      )}
    </span>
  )
}
