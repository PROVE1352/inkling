import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SIDEBAR_MENU_DEFAULT_HIDDEN, SIDEBAR_MENU_IDS } from '@inkling/shared'
import { useSaveSidebarPrefs, useSidebarPrefs } from '../sidebarApi'
import { moveEntry, resolveSidebarMenu, setEntryHidden, toSidebarPrefs, type SidebarEntry } from '../lib/sidebarMenu'
import { useT } from '../i18n'
import { ChevronDownIcon, GripIcon } from './Icons'
import { Group, Toggle } from './SettingsRows'
import { SIDEBAR_MENU_META, isSidebarMenuId } from './sidebarMenus'

// Settings → Sidebar (docs/adr/1020-*): show/hide each top-of-sidebar menu and reorder them by
// dragging the handle (mouse, long-press on touch, or Space + arrow keys) or with the ↑/↓ buttons
// (shown on hover or keyboard focus).
// Stored on the account, so every device shows the same sidebar.
export function SidebarSettings() {
  const t = useT()
  const prefs = useSidebarPrefs()
  const save = useSaveSidebarPrefs()
  const entries = resolveSidebarMenu(prefs, SIDEBAR_MENU_IDS, SIDEBAR_MENU_DEFAULT_HIDDEN).filter((e) => isSidebarMenuId(e.id))
  const isDefault = prefs.order.length === 0 && prefs.hidden.length === 0
  const allHidden = entries.every((e) => e.hidden)
  const [live, setLive] = useState('')
  const sectionRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null)

  const commit = (next: SidebarEntry[]) => save.mutate(toSidebarPrefs(next, SIDEBAR_MENU_IDS, prefs, SIDEBAR_MENU_DEFAULT_HIDDEN))
  const name = (id: string) => (isSidebarMenuId(id) ? t(SIDEBAR_MENU_META[id].label) : id)

  const move = (from: number, to: number, focusId?: string) => {
    if (to < 0 || to >= entries.length) return
    commit(moveEntry(entries, from, to))
    setLive(t('sidebarSettings.moved', { name: name(entries[from].id), pos: to + 1, total: entries.length }))
    if (focusId) pendingFocus.current = focusId
  }

  // Reordering moves the row's DOM node, which drops focus: put it back on the same arrow of the moved
  // row once the new order has rendered (or on its other arrow when this one became disabled at an end).
  const orderKey = entries.map((e) => e.id).join()
  useEffect(() => {
    const focusId = pendingFocus.current
    if (!focusId) return
    pendingFocus.current = null
    const q = (fid: string) => sectionRef.current?.querySelector<HTMLButtonElement>(`[data-focus-id="${fid}"]`)
    const other = focusId.startsWith('up-') ? focusId.replace('up-', 'down-') : focusId.replace('down-', 'up-')
    const el = q(focusId)
    ;(el && !el.disabled ? el : q(other))?.focus()
  }, [orderKey])

  const sensors = useSensors(
    // Same thresholds as the page tree (AppDnd): a finger needs a long press so the list still scrolls.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = entries.findIndex((x) => x.id === e.active.id)
    const to = entries.findIndex((x) => x.id === e.over!.id)
    if (from !== -1 && to !== -1) move(from, to)
  }

  return (
    <div ref={sectionRef}>
      <Group title={t('sidebarSettings.title')}>
        <div className="px-4 py-3">
          <div className="text-xs leading-relaxed text-sub">{t('sidebarSettings.desc')}</div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{ screenReaderInstructions: { draggable: t('sidebarSettings.dragInstructions') } }}
          >
            <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
              <ul
                aria-label={t('sidebarSettings.listLabel')}
                data-testid="sidebar-settings-list"
                className="mt-3 divide-y divide-line rounded-md border border-line"
              >
                {entries.map((e, i) => (
                  <SortableRow
                    key={e.id}
                    entry={e}
                    label={name(e.id)}
                    first={i === 0}
                    last={i === entries.length - 1}
                    onUp={() => move(i, i - 1, `up-${e.id}`)}
                    onDown={() => move(i, i + 1, `down-${e.id}`)}
                    onToggle={(show) => commit(setEntryHidden(entries, e.id, !show))}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {allHidden && <p className="mt-2 text-xs text-sub">{t('sidebarSettings.allHidden')}</p>}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                save.mutate({ order: [], hidden: [] })
                setLive(t('sidebarSettings.reset'))
              }}
              disabled={isDefault}
              data-testid="sidebar-settings-reset"
              className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40"
            >
              {t('sidebarSettings.reset')}
            </button>
          </div>
          <span className="sr-only" aria-live="polite">
            {live}
          </span>
        </div>
      </Group>
    </div>
  )
}

function SortableRow({
  entry,
  label,
  first,
  last,
  onUp,
  onDown,
  onToggle,
}: {
  entry: SidebarEntry
  label: string
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onToggle: (show: boolean) => void
}) {
  const t = useT()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  })
  const meta = isSidebarMenuId(entry.id) ? SIDEBAR_MENU_META[entry.id] : null
  const arrow =
    'flex h-7 w-7 items-center justify-center rounded-md text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:h-9 pointer-coarse:w-9'
  // ↑/↓ only while the row is hovered or holds keyboard focus (Tab still reaches them: opacity keeps them in
  // the tab order). Touch screens have no hover, so they stay visible there.
  const reveal =
    'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100'

  return (
    <li
      ref={setNodeRef}
      data-menu-id={entry.id}
      style={{
        transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={`group/row relative flex items-center gap-2 bg-app px-2 py-1.5 ${isDragging ? 'z-10 shadow-lg ring-1 ring-line' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('sidebarSettings.dragHandle', { name: label })}
        title={t('sidebarSettings.dragHandle', { name: label })}
        className="flex h-7 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-sub hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing pointer-coarse:h-9"
      >
        <GripIcon size={16} />
      </button>
      <span className={`flex shrink-0 ${entry.hidden ? 'text-sub/60' : 'text-sub'}`}>{meta?.icon(16)}</span>
      <span className={`min-w-0 flex-1 truncate text-sm ${entry.hidden ? 'text-sub line-through decoration-sub/50' : 'text-ink'}`}>
        {label}
      </span>
      <span className={`flex shrink-0 ${reveal}`}>
        <button
          type="button"
          data-focus-id={`up-${entry.id}`}
          onClick={onUp}
          disabled={first}
          aria-label={t('sidebarSettings.moveUp', { name: label })}
          title={t('sidebarSettings.moveUp', { name: label })}
          className={arrow}
        >
          <ChevronDownIcon size={16} className="rotate-180" />
        </button>
        <button
          type="button"
          data-focus-id={`down-${entry.id}`}
          onClick={onDown}
          disabled={last}
          aria-label={t('sidebarSettings.moveDown', { name: label })}
          title={t('sidebarSettings.moveDown', { name: label })}
          className={arrow}
        >
          <ChevronDownIcon size={16} />
        </button>
      </span>
      <span className="ml-1 flex shrink-0">
        <Toggle label={t('sidebarSettings.show', { name: label })} checked={!entry.hidden} onChange={onToggle} />
      </span>
    </li>
  )
}
