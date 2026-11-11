import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { WorkspaceDTO } from '@inkling/shared'
import {
  ApiError,
  triggerDownload,
  useDeletedWorkspaces,
  useDeleteWorkspace,
  useMe,
  useMembers,
  useRemoveMember,
  useRestoreWorkspace,
  useWorkspaceRestoreDays,
  useTransferOwnership,
  useWorkspaceDeletePreview,
} from '../api'
import { useT } from '../i18n'
import { DownloadIcon, RestoreIcon } from './Icons'
import { Modal } from './Modal'
import { Group, useSettingsFlat } from './SettingsRows'
import { Spinner } from './Spinner'
import { WorkspaceAvatar } from './WorkspaceAvatar'

// Workspace danger zone (docs/adr/0910-*, 0911-*): leave, transfer ownership, delete (soft, 30-day
// restore) and the "Deleted workspaces" restore list used by Settings and the empty-state screen.

const btn =
  'flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition duration-150 disabled:opacity-60'
const btnDanger = `${btn} bg-red-600 text-white hover:opacity-90 active:scale-[.98]`
const btnPrimary = `${btn} bg-accent text-white hover:opacity-90 active:scale-[.98]`
const btnPlain = `${btn} border border-line text-ink hover:bg-hover`

export type DangerAction = 'leave' | 'transfer' | 'delete' | null

/**
 * One controller for the three dialogs so "Leave" can hand over to "Transfer" or "Delete"
 * without the switcher menu knowing the rules.
 */
export function WorkspaceDangerDialogs({
  action,
  onAction,
  wsId,
  workspace,
}: {
  action: DangerAction
  onAction: (a: DangerAction) => void
  wsId: string
  workspace: WorkspaceDTO
}) {
  const [leaveAfterTransfer, setLeaveAfterTransfer] = useState(false)
  const close = () => {
    setLeaveAfterTransfer(false)
    onAction(null)
  }
  return (
    <>
      {action === 'leave' && (
        <LeaveWorkspaceModal
          wsId={wsId}
          workspace={workspace}
          onClose={close}
          onTransfer={() => {
            setLeaveAfterTransfer(true)
            onAction('transfer')
          }}
          onDelete={() => onAction('delete')}
        />
      )}
      {action === 'transfer' && (
        <TransferOwnershipModal wsId={wsId} workspace={workspace} leaveAfter={leaveAfterTransfer} onClose={close} />
      )}
      {action === 'delete' && <DeleteWorkspaceModal wsId={wsId} workspace={workspace} onClose={close} />}
    </>
  )
}

/**
 * Leave. A sole owner is stopped before the request (the server would refuse with 400): with other
 * members they choose transfer / delete / cancel; alone, leaving is deleting, so they go to delete.
 */
function LeaveWorkspaceModal({
  wsId,
  workspace,
  onClose,
  onTransfer,
  onDelete,
}: {
  wsId: string
  workspace: WorkspaceDTO
  onClose: () => void
  onTransfer: () => void
  onDelete: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const me = useMe()
  const members = useMembers(wsId)
  const remove = useRemoveMember(wsId)
  const restoreDays = useWorkspaceRestoreDays()
  const [error, setError] = useState<string | null>(null)

  const list = members.data ?? []
  const owners = list.filter((m) => m.role === 'owner')
  const soleOwner = workspace.role === 'owner' && owners.length <= 1
  const alone = list.length <= 1

  const leave = () => {
    if (!me.data) return
    setError(null)
    remove.mutate(me.data.id, {
      onSuccess: () => {
        onClose()
        // Home picks another workspace or shows the empty state.
        navigate('/', { replace: true })
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : t('wsDanger.leaveFailed')),
    })
  }

  if (members.isLoading || me.isLoading) {
    return (
      <Modal open onClose={onClose} title={t('wsDanger.leave')}>
        <div className="flex justify-center py-6">
          <Spinner size={20} />
        </div>
      </Modal>
    )
  }

  if (soleOwner && alone) {
    return (
      <Modal open onClose={onClose} title={t('wsDanger.aloneTitle')}>
        <div className="flex flex-col gap-4" data-testid="leave-alone">
          <p className="text-sm text-sub">{t('wsDanger.aloneBody', { days: restoreDays })}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btnPlain} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className={btnDanger} onClick={onDelete}>
              {t('wsDanger.goDelete')}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  if (soleOwner) {
    return (
      <Modal open onClose={onClose} title={t('wsDanger.soleOwnerTitle')}>
        <div className="flex flex-col gap-4" data-testid="leave-sole-owner">
          <p className="text-sm text-sub">{t('wsDanger.soleOwnerBody')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btnPlain} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className={btnDanger} onClick={onDelete}>
              {t('wsDanger.goDelete')}
            </button>
            <button type="button" className={btnPrimary} onClick={onTransfer}>
              {t('wsDanger.goTransfer')}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} title={t('wsDanger.leaveTitle', { name: workspace.name })}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-sub">{t('wsDanger.leaveBody')}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnPlain} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={btnDanger} onClick={leave} disabled={remove.isPending}>
            {remove.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
            {t('wsDanger.leave')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function TransferOwnershipModal({
  wsId,
  workspace,
  leaveAfter,
  onClose,
}: {
  wsId: string
  workspace: WorkspaceDTO
  leaveAfter: boolean
  onClose: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const me = useMe()
  const members = useMembers(wsId)
  const transfer = useTransferOwnership(wsId)
  const remove = useRemoveMember(wsId)
  const [target, setTarget] = useState('')
  const [andLeave, setAndLeave] = useState(leaveAfter)
  const [error, setError] = useState<string | null>(null)

  const others = (members.data ?? []).filter((m) => m.id !== me.data?.id)
  const busy = transfer.isPending || remove.isPending

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!target || !me.data) return
    setError(null)
    const myId = me.data.id
    transfer.mutate(target, {
      onSuccess: () => {
        if (!andLeave) {
          onClose()
          return
        }
        remove.mutate(myId, {
          onSuccess: () => {
            onClose()
            navigate('/', { replace: true })
          },
          onError: (err) => setError(err instanceof ApiError ? err.message : t('wsDanger.leaveFailed')),
        })
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : t('wsDanger.transferFailed')),
    })
  }

  return (
    <Modal open onClose={onClose} title={t('wsDanger.transferTitle')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-sub">{t('wsDanger.transferBody', { name: workspace.name })}</p>
        {members.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner size={18} />
          </div>
        ) : others.length === 0 ? (
          <p className="text-sm text-sub">{t('wsDanger.transferNoMembers')}</p>
        ) : (
          <label className="flex flex-col gap-1 text-xs text-sub">
            {t('wsDanger.transferPick')}
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="rounded-md border border-line bg-app px-2 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <option value="" disabled>
                —
              </option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {(m.name || m.email) + (m.name ? ` (${m.email})` : '')}
                </option>
              ))}
            </select>
          </label>
        )}
        {others.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={andLeave} onChange={(e) => setAndLeave(e.target.checked)} />
            {t('wsDanger.transferThenLeave')}
          </label>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnPlain} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={btnPrimary} disabled={!target || busy}>
            {busy && <Spinner size={16} className="border-white/40 border-t-white" />}
            {t('wsDanger.transferConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteWorkspaceModal({
  wsId,
  workspace,
  onClose,
}: {
  wsId: string
  workspace: WorkspaceDTO
  onClose: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const preview = useWorkspaceDeletePreview(wsId, true)
  const del = useDeleteWorkspace(wsId)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const matches = typed.trim() === workspace.name

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!matches) return
    setError(null)
    del.mutate(typed, {
      onSuccess: () => {
        onClose()
        navigate('/', { replace: true })
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : t('wsDanger.deleteFailed')),
    })
  }

  const p = preview.data
  return (
    <Modal open onClose={onClose} title={t('wsDanger.deleteTitle', { name: workspace.name })}>
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="delete-workspace">
        <p className="text-sm text-ink">{t('wsDanger.deleteIntro')}</p>
        {preview.isLoading ? (
          <div className="flex justify-center py-2">
            <Spinner size={18} />
          </div>
        ) : p ? (
          <ul className="list-disc pl-5 text-sm text-sub">
            <li>{t('wsDanger.deletePages', { count: p.pages })}</li>
            <li>{t('wsDanger.deleteFiles', { count: p.files })}</li>
            <li>{t('wsDanger.deleteLinks', { count: p.publicLinks })}</li>
            <li>{t('wsDanger.deleteMembers', { count: p.members })}</li>
          </ul>
        ) : null}
        <p className="text-sm text-sub">{t('wsDanger.deleteRestore', { days: p?.restoreDays ?? 30 })}</p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-sub">
          {t('wsDanger.deleteExportHint')}
          <button
            type="button"
            onClick={() => triggerDownload(`/api/workspaces/${wsId}/export`)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
          >
            <DownloadIcon size={14} /> {t('wsDanger.deleteExport')}
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs text-sub">
          {t('wsDanger.deleteTypeName')}
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspace.name}
            aria-label={t('wsDanger.deleteTypeName')}
            className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          />
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnPlain} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={btnDanger} disabled={!matches || del.isPending}>
            {del.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
            {t('wsDanger.deleteConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Restore list. `compact` = the empty-state screen (hidden when there is nothing to restore). */
export function DeletedWorkspacesList({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const deleted = useDeletedWorkspaces()
  const restore = useRestoreWorkspace()
  const [error, setError] = useState<string | null>(null)
  const list = deleted.data ?? []
  const flat = useSettingsFlat()

  if (compact && list.length === 0) return null

  const items = (
    <>
      {deleted.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={18} />
        </div>
      ) : list.length === 0 ? (
        <p className="px-4 py-3 text-sm text-sub">{t('wsDanger.deletedEmpty')}</p>
      ) : (
        list.map((w) => {
          const days = Math.max(0, Math.ceil((Date.parse(w.purgeAt) - Date.now()) / 86_400_000))
          return (
            <div key={w.id} className="flex items-center gap-3 px-4 py-3" data-testid="deleted-workspace">
              <WorkspaceAvatar name={w.name} icon={w.icon} size={20} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{w.name}</div>
                <div className="text-xs text-sub">{t('wsDanger.daysLeft', { count: days })}</div>
              </div>
              <button
                type="button"
                disabled={restore.isPending}
                onClick={() => {
                  setError(null)
                  restore.mutate(w.id, {
                    onSuccess: (ws) => navigate(`/w/${ws.id}`),
                    onError: (err) =>
                      setError(err instanceof ApiError ? err.message : t('wsDanger.restoreFailed')),
                  })
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-60"
              >
                <RestoreIcon size={14} /> {t('wsDanger.restore')}
              </button>
            </div>
          )
        })
      )}
      {error && <p className="px-4 py-2 text-xs text-red-600">{error}</p>}
    </>
  )
  // In the flat look the rows sit directly in the group's divided list (no wrapper of their own).
  const rows = flat && !compact ? items : <div className="divide-y divide-line">{items}</div>

  // Settings › Account: the flat row look of the personal settings screen.
  if (flat && !compact) return <Group title={t('wsDanger.deletedTitle')} desc={t('wsDanger.deletedDesc')}>{rows}</Group>

  return (
    <section className={compact ? 'w-full max-w-2xl' : 'mb-8'}>
      <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
        {t('wsDanger.deletedTitle')}
      </h2>
      {!compact && <p className="mb-2 px-1 text-xs text-sub">{t('wsDanger.deletedDesc')}</p>}
      <div className="rounded-lg border border-line">{rows}</div>
    </section>
  )
}
