import { useState } from 'react'
import type { WorkspaceDTO } from '@inkling/shared'
import { WorkspaceAvatar } from './WorkspaceAvatar'
import { GuestBadge } from './GuestBadge'
import { CheckIcon, ChevronRightIcon } from './Icons'
import { arrangeWorkspaces, hasArrangement } from '../lib/workspaceListing'
import { useWorkspaceGroups, useWorkspaceListingChange } from '../workspaceListingApi'
import { useT } from '../i18n'

// The workspace list inside the switcher (docs/adr/2300-*). Without groups or archived workspaces it
// is the plain list it always was; with them: ungrouped first, then each group (foldable, the fold is
// saved on the account), then "Archived" (folded unless the open workspace is in it).
export function WorkspaceSwitcherList({
  wsId,
  workspaces,
  onPick,
}: {
  wsId: string
  workspaces: WorkspaceDTO[]
  onPick: (w: WorkspaceDTO) => void
}) {
  const t = useT()
  const groups = useWorkspaceGroups()
  const change = useWorkspaceListingChange()
  const current = workspaces.find((w) => w.id === wsId)
  const [archivedOpen, setArchivedOpen] = useState(!!current?.listing?.archived)

  const row = (w: WorkspaceDTO, muted = false) => (
    <button
      key={w.id}
      type="button"
      data-ws-row={w.id}
      onClick={() => onPick(w)}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover ${muted ? 'text-sub' : 'text-ink'}`}
    >
      <WorkspaceAvatar name={w.name} icon={w.icon} size={18} />
      <span className="min-w-0 flex-1 truncate">{w.name}</span>
      {w.role === 'guest' && <GuestBadge />}
      {w.id === wsId && <CheckIcon size={15} className="text-accent" />}
    </button>
  )

  if (!hasArrangement(workspaces, groups)) return <div className="max-h-64 overflow-y-auto">{workspaces.map((w) => row(w))}</div>

  const a = arrangeWorkspaces(workspaces, groups)
  const header = (key: string, label: string, open: boolean, onToggle: () => void, count: number) => (
    <button
      key={`h-${key}`}
      type="button"
      data-ws-group={key}
      aria-expanded={open}
      aria-label={t('wsGroups.toggleGroup', { name: label })}
      onClick={onToggle}
      className="mt-1 flex w-full items-center gap-1 px-3 pb-0.5 pt-1 text-left text-[11px] font-semibold uppercase tracking-wide text-sub hover:text-ink"
    >
      <ChevronRightIcon size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-normal tabular-nums normal-case">{count}</span>
    </button>
  )

  return (
    // Taller than the plain list: group heads take room, and a long archive should not push the menu out.
    <div className="max-h-[min(24rem,50dvh)] overflow-y-auto">
      {a.ungrouped.map((w) => row(w))}
      {a.groups.map(({ group, items }) => {
        const open = !group.collapsed
        // a folded group still shows the open workspace, so the check mark never disappears
        const shown = open ? items : items.filter((w) => w.id === wsId)
        return (
          <div key={group.id} role="group" aria-label={group.name}>
            {header(group.id, group.name, open, () => change.mutate({ kind: 'updateGroup', id: group.id, collapsed: open }), items.length)}
            {shown.map((w) => row(w))}
            {open && items.length === 0 && <div className="px-3 py-1 text-xs text-sub/70">{t('wsGroups.empty')}</div>}
          </div>
        )
      })}
      {a.archived.length > 0 && (
        <div role="group" aria-label={t('wsGroups.archived')}>
          {header('archived', t('wsGroups.archived'), archivedOpen, () => setArchivedOpen((v) => !v), a.archived.length)}
          {(archivedOpen ? a.archived : a.archived.filter((w) => w.id === wsId)).map((w) => row(w, true))}
        </div>
      )}
    </div>
  )
}
