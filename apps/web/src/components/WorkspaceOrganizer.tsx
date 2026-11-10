import { useState } from 'react'
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
import { WORKSPACE_GROUPS_MAX, WORKSPACE_GROUP_NAME_MAX, type WorkspaceDTO, type WorkspaceGroupDTO } from '@inkling/shared'
import { useWorkspaces } from '../api'
import { arrangeWorkspaces, moveId } from '../lib/workspaceListing'
import { useWorkspaceGroups, useWorkspaceListingChange } from '../workspaceListingApi'
import { useT } from '../i18n'
import { ChevronDownIcon, EditIcon, GripIcon, RestoreIcon, TrashIcon } from './Icons'
import { Group } from './SettingsRows'
import { WorkspaceAvatar } from './WorkspaceAvatar'
import { GuestBadge } from './GuestBadge'

// Arranging one's own workspace list (docs/adr/2300-*): groups (make, rename, order, fold, delete,
// archive all) and, per workspace, its group, its place inside the group and the archive. Reordering
// inside a group is the sidebar settings' pattern (drag handle or ↑/↓, docs/adr/1020-*); moving to
// another group is the select on the row. Shown in a dialog from the switcher and in Settings › Sidebar.

const iconBtn =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:h-9 pointer-coarse:w-9'
const smallBtn =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'

/** A box with a lid: "archive". Drawn here (one use) rather than added to the shared icon set. */
function ArchiveIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </svg>
  )
}

export function WorkspaceOrganizer() {
  const t = useT()
  const workspaces = useWorkspaces().data ?? []
  const groups = useWorkspaceGroups()
  const change = useWorkspaceListingChange()
  const [live, setLive] = useState('')
  const a = arrangeWorkspaces(workspaces, groups)

  return (
    <div data-testid="ws-organizer" className="flex flex-col gap-4">
      <GroupsEditor groups={groups} arranged={a.groups} />
      <div>
        <h3 className="mb-1 text-xs font-semibold text-sub">{t('wsGroups.workspaces')}</h3>
        <WorkspaceSection
          label={groups.length ? t('wsGroups.ungrouped') : null}
          groupId={null}
          items={a.ungrouped}
          groups={groups}
          onMoved={setLive}
        />
        {a.groups.map(({ group, items }) => (
          <WorkspaceSection key={group.id} label={group.name} groupId={group.id} items={items} groups={groups} onMoved={setLive} />
        ))}
        {a.archived.length > 0 && (
          <section className="mt-3" aria-label={t('wsGroups.archived')} data-testid="ws-organizer-archived">
            <h4 className="mb-1 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide text-sub">
              {t('wsGroups.archived')}
              <span className="font-normal normal-case text-sub/80">{t('wsGroups.archivedHint')}</span>
            </h4>
            <ul className="divide-y divide-line rounded-md border border-line">
              {a.archived.map((w) => (
                <li key={w.id} data-ws-id={w.id} className="flex items-center gap-2 px-2 py-1.5">
                  <WorkspaceAvatar name={w.name} icon={w.icon} size={18} />
                  <span className="min-w-0 flex-1 truncate text-sm text-sub">{w.name}</span>
                  {w.role === 'guest' && <GuestBadge />}
                  {w.listing?.group && <span className="hidden max-w-[8rem] truncate text-xs text-sub/80 sm:inline">{w.listing.group}</span>}
                  <button
                    type="button"
                    className={smallBtn}
                    aria-label={t('wsGroups.unarchiveWs', { name: w.name })}
                    onClick={() => change.mutate({ kind: 'listing', workspaceId: w.id, archived: false })}
                  >
                    <span className="flex items-center gap-1">
                      <RestoreIcon size={13} />
                      {t('wsGroups.unarchive')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {live}
      </span>
    </div>
  )
}

function GroupsEditor({ groups, arranged }: { groups: WorkspaceGroupDTO[]; arranged: { group: WorkspaceGroupDTO; items: WorkspaceDTO[] }[] }) {
  const t = useT()
  const change = useWorkspaceListingChange()
  const workspaces = useWorkspaces().data ?? []
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const full = groups.length >= WORKSPACE_GROUPS_MAX

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || full) return
    change.mutate({ kind: 'createGroup', name: n })
    setName('')
  }
  const saveRename = (g: WorkspaceGroupDTO) => {
    const n = draft.trim()
    if (n && n !== g.name) change.mutate({ kind: 'updateGroup', id: g.id, name: n })
    setEditing(null)
  }
  const move = (i: number, to: number) => change.mutate({ kind: 'orderGroups', ids: moveId(groups.map((g) => g.id), i, to) })
  // archived members of a group are not in `arranged` (they sit under Archived): count them apart
  const archivedIn = (id: string) => workspaces.filter((w) => w.listing?.archived && w.listing.groupId === id).length

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-sub">{t('wsGroups.groups')}</h3>
      {groups.length > 0 && (
        <ul className="mb-2 divide-y divide-line rounded-md border border-line" data-testid="ws-groups">
          {groups.map((g, i) => {
            const live = arranged.find((x) => x.group.id === g.id)?.items.length ?? 0
            const archived = archivedIn(g.id)
            const allArchived = live === 0 && archived > 0
            return (
              <li key={g.id} data-group-id={g.id} className="flex flex-wrap items-center gap-1 px-2 py-1.5">
                {editing === g.id ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={WORKSPACE_GROUP_NAME_MAX}
                    aria-label={t('wsGroups.renameGroup', { name: g.name })}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => saveRename(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename(g)
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEditing(null)
                      }
                    }}
                    className="min-w-0 flex-1 rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {g.name} <span className="text-xs tabular-nums text-sub">{live + archived}</span>
                  </span>
                )}
                <button type="button" className={iconBtn} onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={t('wsGroups.moveUp', { name: g.name })} title={t('wsGroups.moveUp', { name: g.name })}>
                  <ChevronDownIcon size={16} className="rotate-180" />
                </button>
                <button type="button" className={iconBtn} onClick={() => move(i, i + 1)} disabled={i === groups.length - 1} aria-label={t('wsGroups.moveDown', { name: g.name })} title={t('wsGroups.moveDown', { name: g.name })}>
                  <ChevronDownIcon size={16} />
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => {
                    setDraft(g.name)
                    setEditing(g.id)
                  }}
                  aria-label={t('wsGroups.renameGroup', { name: g.name })}
                  title={t('wsGroups.rename')}
                >
                  <EditIcon size={15} />
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  disabled={live + archived === 0}
                  onClick={() => change.mutate({ kind: 'archiveGroup', id: g.id, archived: !allArchived })}
                  aria-label={t(allArchived ? 'wsGroups.unarchiveAllIn' : 'wsGroups.archiveAllIn', { name: g.name })}
                >
                  {t(allArchived ? 'wsGroups.unarchiveAll' : 'wsGroups.archiveAll')}
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => {
                    if (window.confirm(t('wsGroups.deleteGroupConfirm', { name: g.name }))) change.mutate({ kind: 'deleteGroup', id: g.id })
                  }}
                  aria-label={t('wsGroups.deleteGroup', { name: g.name })}
                  title={t('wsGroups.deleteGroup', { name: g.name })}
                >
                  <TrashIcon size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={WORKSPACE_GROUP_NAME_MAX}
          placeholder={t('wsGroups.groupNamePlaceholder')}
          aria-label={t('wsGroups.newGroup')}
          disabled={full}
          className="min-w-0 flex-1 rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button type="submit" className={smallBtn} disabled={full || !name.trim()}>
          {t('wsGroups.add')}
        </button>
      </form>
      {full && <p className="mt-1 text-xs text-sub">{t('wsGroups.limit', { max: WORKSPACE_GROUPS_MAX })}</p>}
    </div>
  )
}

function WorkspaceSection({
  label,
  groupId,
  items,
  groups,
  onMoved,
}: {
  label: string | null
  groupId: string | null
  items: WorkspaceDTO[]
  groups: WorkspaceGroupDTO[]
  onMoved: (msg: string) => void
}) {
  const t = useT()
  const change = useWorkspaceListingChange()
  const ids = items.map((w) => w.id)
  const sensors = useSensors(
    // the page tree's thresholds (AppDnd): a finger needs a long press so the list still scrolls
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    change.mutate({ kind: 'orderWorkspaces', groupId, ids: moveId(ids, from, to) })
    onMoved(t('wsGroups.moved', { name: items[from].name, pos: to + 1, total: ids.length }))
  }
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    move(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)))
  }
  if (label !== null && items.length === 0 && groupId === null) return null
  return (
    <section className="mt-2" aria-label={label ?? t('wsGroups.workspaces')} data-section={groupId ?? 'ungrouped'}>
      {label !== null && <h4 className="mb-1 truncate text-[11px] font-semibold uppercase tracking-wide text-sub">{label}</h4>}
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-2 py-1.5 text-xs text-sub">{t('wsGroups.empty')}</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ screenReaderInstructions: { draggable: t('wsGroups.dragInstructions') } }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((w, i) => (
                <WorkspaceRow
                  key={w.id}
                  ws={w}
                  groups={groups}
                  first={i === 0}
                  last={i === items.length - 1}
                  onUp={() => move(i, i - 1)}
                  onDown={() => move(i, i + 1)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  )
}

function WorkspaceRow({
  ws,
  groups,
  first,
  last,
  onUp,
  onDown,
}: {
  ws: WorkspaceDTO
  groups: WorkspaceGroupDTO[]
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
}) {
  const t = useT()
  const change = useWorkspaceListingChange()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: ws.id })
  const reveal = 'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100'
  return (
    <li
      ref={setNodeRef}
      data-ws-id={ws.id}
      style={{ transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }}
      className={`group/row relative flex items-center gap-1.5 bg-app px-1.5 py-1.5 ${isDragging ? 'z-10 shadow-lg ring-1 ring-line' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('wsGroups.dragHandle', { name: ws.name })}
        title={t('wsGroups.dragHandle', { name: ws.name })}
        className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-sub hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing pointer-coarse:h-9"
      >
        <GripIcon size={15} />
      </button>
      <WorkspaceAvatar name={ws.name} icon={ws.icon} size={18} />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{ws.name}</span>
      {ws.role === 'guest' && <GuestBadge />}
      <span className={`hidden shrink-0 sm:flex ${reveal}`}>
        <button type="button" className={iconBtn} onClick={onUp} disabled={first} aria-label={t('wsGroups.moveUp', { name: ws.name })} title={t('wsGroups.moveUp', { name: ws.name })}>
          <ChevronDownIcon size={16} className="rotate-180" />
        </button>
        <button type="button" className={iconBtn} onClick={onDown} disabled={last} aria-label={t('wsGroups.moveDown', { name: ws.name })} title={t('wsGroups.moveDown', { name: ws.name })}>
          <ChevronDownIcon size={16} />
        </button>
      </span>
      {groups.length > 0 && (
        <select
          value={ws.listing?.groupId && groups.some((g) => g.id === ws.listing?.groupId) ? ws.listing.groupId : ''}
          onChange={(e) => change.mutate({ kind: 'listing', workspaceId: ws.id, groupId: e.target.value || null })}
          aria-label={t('wsGroups.groupOf', { name: ws.name })}
          className="w-28 shrink-0 truncate rounded-md border border-line bg-app px-1 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-32"
        >
          <option value="">{t('wsGroups.ungrouped')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={iconBtn}
        onClick={() => change.mutate({ kind: 'listing', workspaceId: ws.id, archived: true })}
        aria-label={t('wsGroups.archiveWs', { name: ws.name })}
        title={t('wsGroups.archive')}
      >
        <ArchiveIcon />
      </button>
    </li>
  )
}

/** Settings › Sidebar: the same editor in a settings group. */
export function WorkspaceListSettings() {
  const t = useT()
  return (
    <Group title={t('wsGroups.title')} desc={t('wsGroups.desc')}>
      <div className="px-4 py-3">
        <WorkspaceOrganizer />
      </div>
    </Group>
  )
}
