import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import type { MemberDTO, WorkspaceDTO, WorkspaceRole } from '@inkling/shared'
import {
  ApiError,
  useAddMember,
  useMe,
  useMemberCandidates,
  useMembers,
  useRegenerateInvite,
  useRemoveMember,
  useUpdateMemberRole,
} from '../api'
import { copyText, inviteLink } from '../lib/clipboard'
import { t, useT } from '../i18n'
import { ConfirmPopover } from './ConfirmPopover'
import {
  CopyIcon,
  LogOutIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  UserMinusIcon,
  UsersIcon,
  XIcon,
} from './Icons'
import { Spinner } from './Spinner'

const roleLabel = (role: WorkspaceRole) => (role === 'owner' ? t('members.roleOwner') : t('members.roleMember'))

function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
        role === 'owner'
          ? 'bg-accent-soft text-accent'
          : 'bg-hover text-sub'
      }`}
    >
      {roleLabel(role)}
    </span>
  )
}

export function MembersModal({
  open,
  onClose,
  wsId,
  workspace,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  workspace: WorkspaceDTO
}) {
  useT()
  const navigate = useNavigate()
  const me = useMe()
  const members = useMembers(wsId)
  const updateRole = useUpdateMemberRole(wsId)
  const removeMember = useRemoveMember(wsId)
  const regenerate = useRegenerateInvite(wsId)
  const addMember = useAddMember(wsId)

  // Search existing users — input debounced by 250ms
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  const candidates = useMemberCandidates(open ? wsId : '', debounced)

  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [confirmRegen, setConfirmRegen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const isOwner = workspace.role === 'owner'
  const list = members.data ?? []
  const ownerCount = list.filter((m) => m.role === 'owner').length

  const copyLink = async () => {
    const ok = await copyText(inviteLink(workspace.inviteCode))
    setCopied(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), 1500)
  }

  const changeRole = (userId: string, role: WorkspaceRole) => {
    setError(null)
    updateRole.mutate(
      { userId, role },
      {
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : t('members.roleChangeFailed')),
      },
    )
  }

  const doRemove = (userId: string) => {
    setConfirmRemoveId(null)
    setError(null)
    const isSelf = userId === me.data?.id
    removeMember.mutate(userId, {
      onSuccess: () => {
        // Once I leave I can no longer access this workspace → go home.
        if (isSelf) {
          onClose()
          navigate('/', { replace: true })
        }
      },
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('members.actionFailed')),
    })
  }

  const regen = () => {
    setConfirmRegen(false)
    setError(null)
    regenerate.mutate(undefined, {
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('members.regenFailed')),
    })
  }

  const add = (userId: string) => {
    setError(null)
    addMember.mutate(userId, {
      onSuccess: () => setQuery(''),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('members.addFailed')),
    })
  }

  const busy = updateRole.isPending || removeMember.isPending

  const renderRow = (m: MemberDTO) => {
    const isSelf = m.id === me.data?.id
    const isLastOwner = m.role === 'owner' && ownerCount <= 1
    const initial = m.name.trim().charAt(0).toUpperCase() || '?'
    return (
      <div key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-hover">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ink">
            {m.name || t('members.noName')}
            {isSelf && <span className="text-sub"> {t('members.you')}</span>}
          </div>
          <div className="truncate text-xs text-sub">{m.email}</div>
        </div>

        {isOwner ? (
          <>
            <select
              aria-label={t('members.role')}
              value={m.role}
              disabled={busy || isLastOwner}
              onChange={(e) => changeRole(m.id, e.target.value as WorkspaceRole)}
              className="shrink-0 rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              <option value="owner">{t('members.roleOwner')}</option>
              <option value="member">{t('members.roleMember')}</option>
            </select>
            <ConfirmPopover
              open={confirmRemoveId === m.id}
              onCancel={() => setConfirmRemoveId(null)}
              onConfirm={() => doRemove(m.id)}
              message={
                isSelf
                  ? t('members.leaveConfirm')
                  : t('members.removeConfirm', { name: m.name || t('members.thisMember') })
              }
              confirmLabel={isSelf ? t('members.leave') : t('members.removeMember')}
            >
              <button
                type="button"
                onClick={() => setConfirmRemoveId(m.id)}
                disabled={isLastOwner || busy}
                title={isSelf ? t('members.leave') : t('members.removeMember')}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-40"
              >
                {isSelf ? <LogOutIcon size={14} /> : <UserMinusIcon size={14} />}
              </button>
            </ConfirmPopover>
          </>
        ) : (
          <>
            <RoleBadge role={m.role} />
            {isSelf && (
              <ConfirmPopover
                open={confirmRemoveId === m.id}
                onCancel={() => setConfirmRemoveId(null)}
                onConfirm={() => doRemove(m.id)}
                message={t('members.leaveConfirm')}
                confirmLabel={t('members.leave')}
              >
                <button
                  type="button"
                  onClick={() => setConfirmRemoveId(m.id)}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-40"
                >
                  <LogOutIcon size={14} /> {t('members.leave')}
                </button>
              </ConfirmPopover>
            )}
          </>
        )}
      </div>
    )
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="nd-pop flex max-h-[75dvh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-line bg-app shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <UsersIcon size={17} /> {t('members.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="border-b border-line px-3 py-2">
          <label className="flex items-center gap-2 rounded-md border border-line bg-app px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-accent">
            <SearchIcon size={14} className="shrink-0 text-sub" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('members.searchPlaceholder')}
              aria-label={t('members.searchLabel')}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-sub focus:outline-none"
            />
          </label>
          {debounced && (
            <div className="mt-1">
              {candidates.isLoading ? (
                <div className="flex justify-center py-2">
                  <Spinner size={16} />
                </div>
              ) : (candidates.data ?? []).length === 0 ? (
                <p className="px-1 py-2 text-xs text-sub">
                  {t('members.noCandidates')}
                </p>
              ) : (
                (candidates.data ?? []).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-hover">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ink">{c.name || t('members.noName')}</div>
                      <div className="truncate text-xs text-sub">{c.email}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => add(c.id)}
                      disabled={addMember.isPending}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60"
                    >
                      <PlusIcon size={13} /> {t('common.add')}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {members.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          ) : list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-sub">{t('members.empty')}</p>
          ) : (
            list.map(renderRow)
          )}
        </div>

        {error && <p className="px-4 pt-2 text-xs text-red-600">{error}</p>}

        <div className="flex items-center gap-2 border-t border-line px-3 py-3">
          <button
            type="button"
            onClick={copyLink}
            className="flex flex-1 items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            title={t('members.copyInvite')}
          >
            <CopyIcon size={14} />
            <span key={copied ?? 'idle'} className="nd-fade">
              {copied === 'ok' ? t('members.copied') : copied === 'fail' ? t('members.copyFailed') : t('members.copyInvite')}
            </span>
          </button>
          {isOwner && (
            <ConfirmPopover
              open={confirmRegen}
              onCancel={() => setConfirmRegen(false)}
              onConfirm={regen}
              message={t('members.regenConfirm')}
              confirmLabel={t('members.regenerate')}
            >
              <button
                type="button"
                onClick={() => setConfirmRegen(true)}
                disabled={regenerate.isPending}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
                title={t('members.regenTitle')}
              >
                {regenerate.isPending ? (
                  <Spinner size={14} />
                ) : (
                  <RefreshIcon size={14} />
                )}
                {t('members.regenCode')}
              </button>
            </ConfirmPopover>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
