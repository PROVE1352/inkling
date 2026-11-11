import { useEffect, useState } from 'react'
import type {
  AccessCandidateDTO,
  PageAccessDTO,
  PageAccessLevel,
  PageInviteDTO,
  PagePersonDTO,
  WorkspaceDTO,
} from '@inkling/shared'
import { ApiError, useMe } from '../api'
import {
  useAccessCandidates,
  useCancelPageInvite,
  usePageAccess,
  useRemovePageAccess,
  useSetPageAccess,
} from '../pageAccessApi'
import { copyText } from '../lib/clipboard'
import { defaultLevelFor, grantableLevels, levelLabel, looksLikeEmail } from '../lib/pageAccess'
import { useT } from '../i18n'
import { CopyIcon, UserMinusIcon, XIcon } from './Icons'
import { GuestBadge } from './GuestBadge'
import { Spinner } from './Spinner'
import { useIdMode } from './account/useIdMode'

// "People" section of the share dialog (docs/adr/1250-* .. 1253-*): who has access to this page and
// its subpages, at which level, and pending invitations for addresses without an account.
// The server decides every rule (canManage / canInviteGuests / levels); the controls only follow it.

type Pick = { kind: 'user'; c: AccessCandidateDTO } | { kind: 'email'; email: string }

const selectCls =
  'shrink-0 rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60'

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

function Initial({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

export function SharePeople({ pageId, ws, open }: { pageId: string; ws: WorkspaceDTO; open: boolean }) {
  const t = useT()
  const q = usePageAccess(pageId, open)
  if (q.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={18} />
      </div>
    )
  }
  if (q.isError || !q.data) {
    return <p className="text-xs text-red-600">{errText(q.error, t('access.loadFailed'))}</p>
  }
  return <PeopleBody access={q.data} ws={ws} />
}

function PeopleBody({ access, ws }: { access: PageAccessDTO; ws: WorkspaceDTO }) {
  const t = useT()
  const idMode = useIdMode()
  const me = useMe()
  const pageId = access.pageId
  const setAccess = useSetPageAccess(pageId)
  const remove = useRemovePageAccess(pageId)
  const cancelInvite = useCancelPageInvite(pageId)
  const manager = ws.role === 'owner' || ws.role === 'admin'
  const myLevel: PageAccessLevel = manager ? 'full' : access.myLevel
  const canAddAnyone = access.canManage || access.canInviteGuests

  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  const candidates = useAccessCandidates(pageId, debounced, canAddAnyone)
  const [pick, setPick] = useState<Pick | null>(null)
  const [level, setLevel] = useState<PageAccessLevel | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Links of invitations made in this dialog (the server returns the link once, when no mail went out).
  const [links, setLinks] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ email: string; link?: string } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const pickIsGuest = pick ? (pick.kind === 'email' ? true : pick.c.guest) : false
  const pickAllowed = pick ? (pickIsGuest ? access.canInviteGuests : access.canManage) : false
  const levels = grantableLevels(myLevel, pickIsGuest)
  const chosen = level && levels.includes(level) ? level : defaultLevelFor(myLevel, pickIsGuest)

  // An address typed in full that the search did not turn into an account: invite by email.
  const list = candidates.data ?? []
  const typedEmail = looksLikeEmail(debounced) && !list.some((c) => c.email.toLowerCase() === debounced.toLowerCase())

  const choose = (p: Pick) => {
    setPick(p)
    setLevel(null)
    setQuery('')
    setDebounced('')
    setError(null)
  }

  const add = () => {
    if (!pick || !pickAllowed) return
    setError(null)
    setNotice(null)
    const body = pick.kind === 'user' ? { userId: pick.c.userId, level: chosen } : { email: pick.email, level: chosen }
    setAccess.mutate(body, {
      onSuccess: (r) => {
        setPick(null)
        setLevel(null)
        if (r.invite) {
          if (r.invite.link) setLinks((m) => ({ ...m, [r.invite!.id]: r.invite!.link! }))
          setNotice({ email: r.invite.email, link: r.mailed ? undefined : r.invite.link })
        }
      },
      onError: (e) => setError(errText(e, t('access.saveFailed'))),
    })
  }

  const change = (p: PagePersonDTO, next: PageAccessLevel) => {
    setError(null)
    setAccess.mutate({ userId: p.userId, level: next }, { onError: (e) => setError(errText(e, t('access.saveFailed'))) })
  }
  const drop = (p: PagePersonDTO) => {
    setError(null)
    remove.mutate(p.userId, { onError: (e) => setError(errText(e, t('access.saveFailed'))) })
  }
  const dropInvite = (inv: PageInviteDTO) => {
    setError(null)
    cancelInvite.mutate(inv.id, { onError: (e) => setError(errText(e, t('access.saveFailed'))) })
  }
  const copy = async (id: string, link: string) => {
    const ok = await copyText(link)
    if (!ok) return setError(t('share.copyFailed'))
    setCopiedId(id)
    window.setTimeout(() => setCopiedId(null), 1500)
  }

  const busy = setAccess.isPending || remove.isPending || cancelInvite.isPending

  return (
    <div className="flex flex-col gap-2">
      {canAddAnyone ? (
        <div className="flex flex-col gap-1.5">
          {pick ? (
            <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-ink">
                  <span className="truncate">{pick.kind === 'user' ? pick.c.name || pick.c.email : pick.email}</span>
                  {pickIsGuest && <GuestBadge />}
                </div>
                {pick.kind === 'user' && <div className="truncate text-xs text-sub">{pick.c.email}</div>}
                {pick.kind === 'email' && <div className="text-xs text-sub">{t('access.noAccountYet')}</div>}
              </div>
              <button
                type="button"
                onClick={() => setPick(null)}
                aria-label={t('common.cancel')}
                className="rounded p-1 text-sub hover:bg-hover hover:text-ink"
              >
                <XIcon size={14} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typedEmail) {
                    e.preventDefault()
                    choose({ kind: 'email', email: debounced })
                  }
                }}
                placeholder={idMode ? t('accountLifecycle.accessSearch') : t('access.searchPlaceholder')}
                aria-label={idMode ? t('accountLifecycle.accessSearch') : t('access.searchPlaceholder')}
                className="w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink placeholder:text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {debounced && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-app py-1 shadow-lg">
                  {candidates.isLoading ? (
                    <div className="flex justify-center py-2">
                      <Spinner size={14} />
                    </div>
                  ) : (
                    <>
                      {list.map((c) => {
                        const ok = c.guest ? access.canInviteGuests : access.canManage
                        return (
                          <button
                            key={c.userId}
                            type="button"
                            disabled={!ok}
                            onClick={() => choose({ kind: 'user', c })}
                            title={!ok ? t(c.guest ? 'access.guestPolicyOff' : 'access.membersFullOnly') : undefined}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-50"
                          >
                            <Initial name={c.name || c.email} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-ink">
                                <span className="truncate">{c.name || c.email}</span>
                                {c.guest && <GuestBadge />}
                              </span>
                              <span className="block truncate text-xs text-sub">{c.email}</span>
                            </span>
                          </button>
                        )
                      })}
                      {typedEmail && (
                        <button
                          type="button"
                          disabled={!access.canInviteGuests}
                          onClick={() => choose({ kind: 'email', email: debounced })}
                          title={!access.canInviteGuests ? t('access.guestPolicyOff') : undefined}
                          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-ink hover:bg-hover disabled:opacity-50"
                        >
                          {t('access.inviteEmail', { email: debounced })}
                        </button>
                      )}
                      {list.length === 0 && !typedEmail && (
                        <p className="px-2.5 py-1.5 text-xs text-sub">{idMode ? t('accountLifecycle.accessNoCandidates') : t('access.noCandidates')}</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {pick && (
            <div className="flex items-center gap-2">
              <select
                aria-label={t('access.level')}
                value={chosen}
                disabled={!pickAllowed || busy}
                onChange={(e) => setLevel(e.target.value as PageAccessLevel)}
                className={`${selectCls} flex-1 py-1.5 text-sm`}
              >
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {levelLabel(l)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={add}
                disabled={!pickAllowed || busy}
                className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
              >
                {setAccess.isPending && <Spinner size={14} className="border-white/40 border-t-white" />}
                {pick.kind === 'email' ? t('access.invite') : t('common.add')}
              </button>
            </div>
          )}
          {pick && !pickAllowed && (
            <p className="text-xs text-sub">{t(pickIsGuest ? 'access.guestPolicyOff' : 'access.membersFullOnly')}</p>
          )}
          {!access.canInviteGuests && <p className="text-xs text-sub">{t(guestPolicyHint(access))}</p>}
        </div>
      ) : (
        <p className="text-xs text-sub">{t('access.viewOnly', { level: levelLabel(access.myLevel) })}</p>
      )}

      {notice && (
        <div className="rounded-md border border-line bg-hover/40 px-3 py-2 text-xs text-sub">
          {notice.link ? (
            <>
              <p className="text-ink">{t('access.inviteNotMailed', { email: notice.email })}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  readOnly
                  value={notice.link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copy('notice', notice.link!)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover"
                >
                  <CopyIcon size={12} />
                  {copiedId === 'notice' ? t('common.copied') : t('common.copyLink')}
                </button>
              </div>
            </>
          ) : (
            <p>{t('access.inviteMailed', { email: notice.email })}</p>
          )}
        </div>
      )}

      <div className="divide-y divide-line rounded-md border border-line">
        {access.people.length === 0 && access.invites.length === 0 ? (
          <p className="px-3 py-3 text-xs text-sub">{t('access.empty')}</p>
        ) : (
          <>
            {access.people.map((p) => {
              const self = p.userId === me.data?.id
              const mayChange = !p.inheritedFrom && (p.guest ? access.canManage || access.canInviteGuests : access.canManage)
              const mayChangeLevel = mayChange && (!self || manager)
              const opts = grantableLevels(myLevel, p.guest)
              if (!opts.includes(p.level)) opts.push(p.level)
              return (
                <div key={p.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Initial name={p.name || p.email} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-ink">
                      <span className="truncate">{p.name || p.email}</span>
                      {self && <span className="shrink-0 text-sub">{t('members.you')}</span>}
                      {p.guest && <GuestBadge />}
                    </div>
                    <div className="truncate text-xs text-sub">
                      {p.email}
                      {p.inheritedFrom && (
                        <> · {t('access.inheritedFrom', { title: p.inheritedFrom.title || t('common.untitled') })}</>
                      )}
                    </div>
                  </div>
                  {mayChangeLevel ? (
                    <select
                      aria-label={t('access.levelOf', { name: p.name || p.email })}
                      value={p.level}
                      disabled={busy}
                      onChange={(e) => change(p, e.target.value as PageAccessLevel)}
                      className={selectCls}
                    >
                      {opts.map((l) => (
                        <option key={l} value={l}>
                          {levelLabel(l)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="shrink-0 text-xs text-sub">{levelLabel(p.level)}</span>
                  )}
                  {mayChange && (
                    <button
                      type="button"
                      onClick={() => drop(p)}
                      disabled={busy}
                      title={t('access.remove')}
                      aria-label={t('access.remove')}
                      className="shrink-0 rounded-md p-1 text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-40"
                    >
                      <UserMinusIcon size={14} />
                    </button>
                  )}
                </div>
              )
            })}
            {access.invites.map((inv) => {
              const link = inv.link ?? links[inv.id]
              return (
                <div key={inv.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Initial name={inv.email} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-ink">
                      <span className="truncate">{inv.email}</span>
                      <GuestBadge />
                    </div>
                    <div className="truncate text-xs text-sub">{t('access.pending')}</div>
                  </div>
                  <span className="shrink-0 text-xs text-sub">{levelLabel(inv.level)}</span>
                  {link && (
                    <button
                      type="button"
                      onClick={() => void copy(inv.id, link)}
                      title={t('common.copyLink')}
                      aria-label={t('common.copyLink')}
                      className="shrink-0 rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
                    >
                      {copiedId === inv.id ? <span className="text-xs">{t('common.copied')}</span> : <CopyIcon size={14} />}
                    </button>
                  )}
                  {canAddAnyone && (
                    <button
                      type="button"
                      onClick={() => dropInvite(inv)}
                      disabled={busy}
                      title={t('access.cancelInvite')}
                      aria-label={t('access.cancelInvite')}
                      className="shrink-0 rounded-md p-1 text-red-600 transition-colors duration-150 hover:bg-hover disabled:opacity-40"
                    >
                      <XIcon size={14} />
                    </button>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
      <p className="text-xs text-sub">{t('access.membersNote')}</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

function guestPolicyHint(access: PageAccessDTO) {
  switch (access.guestPolicy) {
    case 'off':
      return 'access.guestsOff' as const
    case 'owners':
      return 'access.guestsOwners' as const
    case 'admins':
      return 'access.guestsAdmins' as const
    default:
      return 'access.guestsMembers' as const
  }
}
