import { useFeatureOff } from './quota/features'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { MemberDTO, WorkspaceAccessRole, WorkspaceDTO, WorkspaceRole } from '@inkling/shared'
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
import { StatusChip } from './MemberStatus'
import {
  CopyIcon,
  LogOutIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  UserMinusIcon,
} from './Icons'
import { Spinner } from './Spinner'
import { useIdMode } from './account/useIdMode'

// Members tab of the workspace settings screen (docs/adr/0945-*, 0948-*). Owners change roles;
// owners and admins remove people (admins: plain members only) and handle the invite link;
// adding existing users follows the workspace's member-add policy (WorkspaceDTO.can).

export const roleLabel = (role: WorkspaceAccessRole) =>
  role === 'owner'
    ? t('members.roleOwner')
    : role === 'admin'
      ? t('members.roleAdmin')
      : role === 'guest'
        ? t('members.roleGuest')
        : t('members.roleMember')

export function RoleBadge({ role }: { role: WorkspaceAccessRole }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
        role === 'member' || role === 'guest' ? 'bg-hover text-sub' : 'bg-accent-soft text-accent'
      }`}
    >
      {roleLabel(role)}
    </span>
  )
}

export function MembersPanel({ wsId, workspace }: { wsId: string; workspace: WorkspaceDTO }) {
  useT()
  const idMode = useIdMode()

  const navigate = useNavigate()
  const me = useMe()
  const members = useMembers(wsId)
  const updateRole = useUpdateMemberRole(wsId)
  const removeMember = useRemoveMember(wsId)
  const regenerate = useRegenerateInvite(wsId)
  const addMember = useAddMember(wsId)
  // adding existing users directly turned off by the server (member-direct-add, docs/adr/2507-*): invite link only
  const directOff = useFeatureOff('member-direct-add')

  // Search existing users — input debounced by 250ms
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  const candidates = useMemberCandidates(workspace.can?.addMembers === false || directOff ? '' : wsId, debounced)

  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [confirmRegen, setConfirmRegen] = useState(false)

  const isOwner = workspace.role === 'owner'
  const isManager = workspace.can?.manage ?? isOwner
  const canAdd = (workspace.can?.addMembers ?? true) && !directOff
  const canInvite = workspace.can?.inviteLink ?? isOwner
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
        if (isSelf) navigate('/', { replace: true })
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
    // admins may remove plain members (and themselves); owners anyone but the last owner
    const canRemove = isSelf || isOwner || (isManager && m.role === 'member')
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
          {/* status message (docs/adr/1845-*) */}
          {m.status && <StatusChip status={m.status} className="mt-0.5" />}
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
              <option value="admin">{t('members.roleAdmin')}</option>
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
            {isManager && canRemove && !isSelf && (
              <ConfirmPopover
                open={confirmRemoveId === m.id}
                onCancel={() => setConfirmRemoveId(null)}
                onConfirm={() => doRemove(m.id)}
                message={t('members.removeConfirm', { name: m.name || t('members.thisMember') })}
                confirmLabel={t('members.removeMember')}
              >
                <button
                  type="button"
                  onClick={() => setConfirmRemoveId(m.id)}
                  disabled={busy}
                  title={t('members.removeMember')}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-40"
                >
                  <UserMinusIcon size={14} />
                </button>
              </ConfirmPopover>
            )}
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

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line">
      {canAdd && (
        <div className="border-b border-line px-3 py-2">
          <label className="flex items-center gap-2 rounded-md border border-line bg-app px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-accent">
            <SearchIcon size={14} className="shrink-0 text-sub" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={idMode ? t('accountLifecycle.membersSearch') : t('members.searchPlaceholder')}
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
                <p className="px-1 py-2 text-xs text-sub">{t('members.noCandidates')}</p>
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
      )}

      <div className="py-1">
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

      {error && <p className="px-4 pb-2 text-xs text-red-600">{error}</p>}

      {isManager && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-3">
          {canInvite ? (
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
          ) : (
            <p className="flex-1 text-xs text-sub">{t('members.inviteOff')}</p>
          )}
          {canInvite && (
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
                {regenerate.isPending ? <Spinner size={14} /> : <RefreshIcon size={14} />}
                {t('members.regenCode')}
              </button>
            </ConfirmPopover>
          )}
        </div>
      )}
    </div>
  )
}
