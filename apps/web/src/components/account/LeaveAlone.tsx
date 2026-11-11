import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { WorkspaceDTO } from '@inkling/shared'
import { ApiError, api, qk, useWorkspaceRestoreDays } from '../../api'
import { useT } from '../../i18n'
import { Modal } from '../Modal'
import { Spinner } from '../Spinner'

const btn =
  'flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition duration-150 disabled:opacity-60'
const btnDanger = `${btn} bg-red-600 text-white hover:opacity-90 active:scale-[.98]`
const btnPlain = `${btn} border border-line text-ink hover:bg-hover`

/**
 * Leaving a workspace you are the only member of (docs/adr/2513-*): it is deleted at once with its
 * pages and files, without the restore window. Confirmed with the workspace's name, as a deletion
 * is. The restorable deletion stays one click away.
 */
export function LeaveAloneModal({
  wsId,
  workspace,
  meId,
  onClose,
  onDelete,
}: {
  wsId: string
  workspace: WorkspaceDTO
  meId: string
  onClose: () => void
  /** The restorable deletion instead. */
  onDelete: () => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const restoreDays = useWorkspaceRestoreDays()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const leave = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api<void>(`/api/workspaces/${wsId}/members/${meId}`, { method: 'DELETE', body: JSON.stringify({ name }) })
      onClose()
      qc.invalidateQueries({ queryKey: qk.workspaces })
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('wsDanger.leaveFailed'))
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('wsDanger.aloneTitle')}>
      <form onSubmit={leave} className="flex flex-col gap-4" data-testid="leave-alone">
        <p className="text-sm font-medium text-red-600">{t('accountLifecycle.leaveAloneBody')}</p>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-sub">{t('accountLifecycle.typeName', { name: workspace.name })}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            className="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={`${btnPlain} mr-auto`} onClick={onDelete}>
            {t('accountLifecycle.deleteRestorable', { days: restoreDays })}
          </button>
          <button type="button" className={btnPlain} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={btnDanger} disabled={busy || name.trim() !== workspace.name}>
            {busy && <Spinner size={14} className="border-white/40 border-t-white" />}
            {t('accountLifecycle.leaveAndDelete')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * "Delete now" next to Restore in the deleted workspaces list (docs/adr/2513-*): the workspace goes
 * for good, which also frees its place under a workspace limit. Confirmed with the name.
 */
export function PurgeDeletedButton({ ws }: { ws: { id: string; name: string } }) {
  const t = useT()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const purge = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api<void>(`/api/workspaces/${ws.id}/permanent`, { method: 'DELETE', body: JSON.stringify({ name }) })
      setOpen(false)
      qc.invalidateQueries({ queryKey: qk.deletedWorkspaces })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('accountLifecycle.purgeFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setName('')
          setError(null)
          setOpen(true)
        }}
        className="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1.5 text-xs text-red-600 transition-colors duration-150 hover:bg-red-500/10"
        data-testid="purge-deleted"
      >
        {t('accountLifecycle.purgeNow')}
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={t('accountLifecycle.purgeTitle', { name: ws.name })}>
          <form onSubmit={purge} className="flex flex-col gap-4">
            <p className="text-sm font-medium text-red-600">{t('accountLifecycle.purgeBody')}</p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-sub">{t('accountLifecycle.typeName', { name: ws.name })}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                className="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnPlain} onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className={btnDanger} disabled={busy || name.trim() !== ws.name}>
                {busy && <Spinner size={14} className="border-white/40 border-t-white" />}
                {t('accountLifecycle.purgeConfirm')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
