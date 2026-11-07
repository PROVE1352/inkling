import { useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import type { AdminUserDTO, ResetRequestDTO, SignupKeyDTO } from '@inkling/shared'
import { userOriginBadge } from '../lib/adminUser'
import {
  ApiError,
  useAdminDeletePreview,
  useAdminUsers,
  useAuthMode,
  useBanIp,
  useIpBans,
  useUnbanIp,
  useCreateSignupKey,
  useDeleteUser,
  useDismissResetRequest,
  useIssueResetCode,
  useIssueTempPassword,
  useAdminDisableTwoFactor,
  useMarkVerified,
  useMe,
  useResetRequests,
  useRevokeSignupKey,
  useSendCredentialMail,
  useSendInviteMail,
  useSendVerificationMail,
  useSetAdmin,
  useSignupKeys,
} from '../api'
import { Spinner } from '../components/Spinner'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { ReleaseNotice } from '../components/UpdateBanner'
import { NavButtons } from '../components/NavButtons'
import { CopyIcon, MenuIcon, SearchIcon } from '../components/Icons'
import { Pager, paginate } from '../components/Pager'
import { askConfirm } from '../lib/confirm'
import { Modal } from '../components/Modal'
import { AdminPluginsSection } from '../plugins/AdminPlugins'
import { AdminBackupsSection } from '../backup/AdminBackups'
import { fmtDate as fmtD, fmtDateTime as fmtDT, fmtList, t } from '../i18n'
import { delegatedDisplayName } from './Login'

const PER_PAGE = 5

const fmtDate = (iso: string | null) => (iso ? fmtD(iso) : '—')

const fmtDateTime = (iso: string | null) => (iso ? fmtDT(iso) : '—')

/** Renders a translated string with its `{env}` placeholder as inline code. */
function withCode(text: string, code: string): ReactNode {
  const [before, after = ''] = text.split('{env}')
  return (
    <>
      {before}
      <code>{code}</code>
      {after}
    </>
  )
}

/** Workspace names for a confirmation text: the first few, then "+N more". */
function nameList(items: { name: string }[], max = 5): string {
  const names = items.slice(0, max).map((w) => w.name || t('admin.noName'))
  const rest = items.length - names.length
  return fmtList(names) + (rest > 0 ? ` ${t('admin.andMore', { count: rest })}` : '')
}

const errMsg = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback

type SoleOwnerWs = { id: string; name: string }

/** `error.workspaces` of a 409 SOLE_OWNER response (docs/API.md), parsed defensively. */
function soleOwnerList(raw: unknown): SoleOwnerWs[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((w) =>
    w && typeof w === 'object' && typeof (w as SoleOwnerWs).id === 'string'
      ? [{ id: (w as SoleOwnerWs).id, name: String((w as SoleOwnerWs).name ?? '') }]
      : [],
  )
}

/** Shown when a forced deletion is refused because the user is the only owner somewhere. */
function SoleOwnerModal({
  state,
  onClose,
}: {
  state: { user: AdminUserDTO; workspaces: SoleOwnerWs[] } | null
  onClose: () => void
}) {
  return (
    <Modal open={!!state} onClose={onClose} title={t('admin.soleOwnerTitle')}>
      {state && (
        <div className="space-y-3 text-sm text-ink">
          <p>
            {t('admin.soleOwnerBody', { name: state.user.name, email: state.user.email })}
          </p>
          {state.workspaces.length > 0 ? (
            <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
              {state.workspaces.map((w) => (
                <li key={w.id}>{w.name || t('admin.noName')}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-sub">
            {t('admin.soleOwnerHint')}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-hover"
            >
              {t('common.ok')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** One-word current state of a key — for scanning the list by eye. */
function keyState(k: { expired: boolean; exhausted: boolean }) {
  if (k.expired) return { label: t('admin.keyExpired'), cls: 'bg-red-500/10 text-red-600' }
  if (k.exhausted) return { label: t('admin.keyExhausted'), cls: 'bg-sub/10 text-sub' }
  return { label: t('admin.keyAvailable'), cls: 'bg-emerald-500/10 text-emerald-600' }
}

const inputCls =
  'rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
const smallBtn =
  'rounded-md px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-sub'
const outlineBtn =
  'rounded-md border border-line px-3 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50'

function Badge({ children, cls }: { children: ReactNode; cls: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="mb-3 flex items-center gap-2 rounded-md border border-line px-3 py-1.5 focus-within:ring-2 focus-within:ring-accent">
      <SearchIcon size={14} className="shrink-0 text-sub" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-sub/70 focus:outline-none"
      />
    </label>
  )
}

/** Clipboard copy + "Copied" indicator state */
function useCopy(onError: (msg: string) => void) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      onError(t('admin.copyFailed'))
    }
  }
  return { copied, copy }
}

/** Recipient input + [Send by email]. Shows success/failure next to it. */
function MailSender({
  defaultTo,
  onSend,
  label,
}: {
  defaultTo: string
  onSend: (to: string) => Promise<unknown>
  label?: string
}) {
  const [to, setTo] = useState(defaultTo)
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; to: string } | { kind: 'error'; msg: string }
  >({ kind: 'idle' })

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = to.trim()
    if (!addr) {
      setState({ kind: 'error', msg: t('admin.recipientRequired') })
      return
    }
    setState({ kind: 'sending' })
    try {
      await onSend(addr)
      setState({ kind: 'sent', to: addr })
    } catch (err) {
      setState({ kind: 'error', msg: errMsg(err, t('auth.mailFailed')) })
    }
  }

  return (
    <form onSubmit={send} className="flex w-full flex-wrap items-center gap-2">
      <input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder={t('admin.recipient')}
        aria-label={t('admin.recipientLabel')}
        className={`${inputCls} min-w-[12rem] flex-1 py-1.5 text-xs`}
      />
      <button type="submit" disabled={state.kind === 'sending'} className={outlineBtn}>
        {state.kind === 'sending' ? t('admin.sending') : (label ?? t('admin.sendEmail'))}
      </button>
      {state.kind === 'sent' && (
        <span className="text-xs text-emerald-600">{t('admin.sentTo', { email: state.to })}</span>
      )}
      {state.kind === 'error' && <span className="text-xs text-red-600">{state.msg}</span>}
    </form>
  )
}

type Issued = {
  /** Where to show the result — 'user:<id>' or 'req:<id>' */
  slot: string
  userId: string
  kind: 'reset-code' | 'temp-password'
  secret: string
  expiresAt?: string
  defaultTo: string
}

/** A just-issued reset code / temporary password — shown once, with copy and email */
function IssuedPanel({
  issued,
  mailEnabled,
  onClose,
  onError,
}: {
  issued: Issued
  mailEnabled: boolean
  onClose: () => void
  onError: (msg: string) => void
}) {
  const { copied, copy } = useCopy(onError)
  const sendMail = useSendCredentialMail()
  const isCode = issued.kind === 'reset-code'
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs text-sub">
            {isCode ? t('admin.resetCodeLabel') : t('admin.tempPassword')}
          </div>
          <div className="font-mono text-base font-semibold text-ink">{issued.secret}</div>
        </div>
        <button
          type="button"
          onClick={() => copy(issued.secret)}
          className={`${outlineBtn} flex items-center gap-1`}
        >
          <CopyIcon size={12} />
          {copied === issued.secret ? t('common.copied') : t('common.copy')}
        </button>
        {isCode && (
          <button
            type="button"
            onClick={() =>
              copy(`${window.location.origin}/reset?email=${encodeURIComponent(issued.defaultTo)}&code=${encodeURIComponent(issued.secret)}`)
            }
            className={outlineBtn}
          >
            {copied?.includes('/reset?') ? t('common.copied') : t('admin.copyResetLink')}
          </button>
        )}
        <button type="button" onClick={onClose} className={`${smallBtn} ml-auto`}>
          {t('common.close')}
        </button>
      </div>
      <p className="text-xs text-sub">
        {isCode
          ? t('admin.resetCodeHint', { date: fmtDateTime(issued.expiresAt ?? null) })
          : t('admin.tempPasswordHint')}{' '}
        {t('admin.issuedOnce')}
      </p>
      {mailEnabled && (
        <MailSender
          defaultTo={issued.defaultTo}
          onSend={(to) =>
            sendMail.mutateAsync({
              id: issued.userId,
              to,
              kind: issued.kind,
              secret: issued.secret,
            })
          }
        />
      )}
    </div>
  )
}

/** Brute-force protection — banned IP list, unban, manual ban, allowlist */
function IpBansSection() {
  const bans = useIpBans(true)
  const banIp = useBanIp()
  const unban = useUnbanIp()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [ip, setIp] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

  const data = bans.data
  const q = query.trim().toLowerCase()
  const filtered = (data?.bans ?? []).filter(
    (b) => !q || b.ip.toLowerCase().includes(q) || b.reason.toLowerCase().includes(q),
  )
  const view = paginate(filtered, page, PER_PAGE)
  const activeCount = (data?.bans ?? []).filter((b) => b.active).length
  const typedIsMine = !!data && ip.trim() !== '' && ip.trim() === data.yourIp

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    banIp.mutate(
      { ip: ip.trim(), minutes: Math.max(1, Number(minutes) || 60), reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          setMsg({ text: t('admin.banned', { ip: r.ip, date: fmtDateTime(r.bannedUntil) }) })
          setIp('')
          setReason('')
        },
        onError: (err) => setMsg({ text: errMsg(err, t('admin.banFailed')), error: true }),
      },
    )
  }

  return (
    <section className="mb-10">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        {t('admin.bannedIps')}
        {activeCount > 0 && (
          <Badge cls="bg-red-500/10 text-red-600">{t('admin.activeBans', { count: activeCount })}</Badge>
        )}
      </h2>
      {data && (
        <p className="mb-3 text-xs text-sub">
          {t('admin.banPolicy', {
            window: data.policy.windowMinutes,
            failures: data.policy.maxFailures,
            ban: data.policy.banMinutes,
            maxHours: data.policy.banMaxHours,
            accountFailures: data.policy.accountFailures,
          })}{' '}
          {t('admin.yourIp')}{' '}
          <code className="rounded bg-side px-1 text-ink">{data.yourIp}</code>
          {data.yourIpAllowlisted && ` ${t('admin.allowlisted')}`}
        </p>
      )}

      <form onSubmit={submit} className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line p-3">
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-sub">{t('admin.ipLabel')}</span>
          <input
            type="text"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="203.0.113.7"
            spellCheck={false}
            className={`${inputCls} py-1.5 font-mono text-xs`}
          />
        </label>
        <label className="flex w-24 flex-col gap-1">
          <span className="text-xs font-medium text-sub">{t('admin.banMinutes')}</span>
          <input
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className={`${inputCls} py-1.5 text-xs`}
          />
        </label>
        <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-sub">{t('admin.memo')}</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${inputCls} py-1.5 text-xs`}
          />
        </label>
        <button type="submit" disabled={banIp.isPending || !ip.trim() || typedIsMine} className={outlineBtn}>
          {t('admin.manualBan')}
        </button>
        {typedIsMine && (
          <p className="w-full text-xs text-red-600">
            {t('admin.ownIpBlocked')}
          </p>
        )}
        {msg && (
          <p className={`w-full text-xs ${msg.error ? 'text-red-600' : 'text-emerald-600'}`}>{msg.text}</p>
        )}
      </form>

      <SearchBox
        value={query}
        onChange={(v) => {
          setQuery(v)
          setPage(1)
        }}
        placeholder={t('admin.searchBans')}
      />
      {bans.isLoading ? (
        <Spinner size={18} />
      ) : view.items.length ? (
        <>
          <ul className="flex flex-col gap-1">
            {view.items.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-hover/60">
                <code className="font-mono text-xs text-ink">{b.ip}</code>
                {b.active ? (
                  <Badge cls="bg-red-500/10 text-red-600">{t('admin.banActive')}</Badge>
                ) : (
                  <Badge cls="bg-sub/10 text-sub">{t('admin.banEnded')}</Badge>
                )}
                <span className="text-xs text-sub">
                  {b.reason}
                  {b.failures > 0 && ` · ${t('admin.failures', { count: b.failures })}`} · {fmtDateTime(b.createdAt)} → {fmtDateTime(b.bannedUntil)}
                </span>
                {b.active && (
                  <button
                    type="button"
                    onClick={() =>
                      unban.mutate(b.id, {
                        onError: (err) => setMsg({ text: errMsg(err, t('admin.unbanFailed')), error: true }),
                      })
                    }
                    className={`${smallBtn} ml-auto`}
                  >
                    {t('admin.unban')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <Pager page={view.page} pageCount={view.pageCount} onChange={setPage} />
        </>
      ) : (
        <p className="text-sm text-sub">{q ? t('admin.noSearchResults') : t('admin.noBans')}</p>
      )}
      <p className="mt-2 text-xs text-sub">
        {withCode(t('admin.allowlistLabel'), 'ALLOWLIST_IPS')}{' '}
        {data?.allowlist.length ? data.allowlist.join(', ') : t('common.none')}
      </p>
    </section>
  )
}

export function Admin() {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const { onToggleSidebar } = useLayout()
  const me = useMe()
  const mode = useAuthMode()
  const isAdmin = me.data?.isAdmin ?? false
  const mailEnabled = mode.data?.mailEnabled ?? false
  const delegatedName = delegatedDisplayName(mode.data?.delegatedName)
  const delegatedSuffix = `@${mode.data?.delegatedEmailDomain ?? ''}`

  const keys = useSignupKeys(isAdmin)
  const users = useAdminUsers(isAdmin)
  const requests = useResetRequests(isAdmin)
  const createKey = useCreateSignupKey()
  const revokeKey = useRevokeSignupKey()
  const setAdmin = useSetAdmin()
  const issueCode = useIssueResetCode()
  const issueTemp = useIssueTempPassword()
  const disableTwoFactor = useAdminDisableTwoFactor()
  const deleteUser = useDeleteUser()
  const fetchDeletePreview = useAdminDeletePreview()
  const markVerified = useMarkVerified()
  const sendVerify = useSendVerificationMail()
  const dismiss = useDismissResetRequest()
  const sendInvite = useSendInviteMail()

  const [note, setNote] = useState('')
  const [maxUses, setMaxUses] = useState(1)
  const [days, setDays] = useState('')
  const [issuedKey, setIssuedKey] = useState<string | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [userMsg, setUserMsg] = useState<{ slot: string; text: string; error?: boolean } | null>(
    null,
  )
  const [soleOwner, setSoleOwner] = useState<{ user: AdminUserDTO; workspaces: SoleOwnerWs[] } | null>(
    null,
  )
  const { copied, copy } = useCopy(setError)

  const [keyQuery, setKeyQuery] = useState('')
  const [keyPage, setKeyPage] = useState(1)
  const [userQuery, setUserQuery] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [reqPage, setReqPage] = useState(1)

  // Signed in but not an admin: send back to the workspace.
  if (me.isLoading) return null
  if (!isAdmin) return <Navigate to={wsId ? `/w/${wsId}` : '/'} replace />

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    createKey.mutate(
      {
        note: note.trim() || undefined,
        maxUses,
        expiresInDays: days.trim() ? Number(days) : undefined,
      },
      {
        onSuccess: (k) => {
          setIssuedKey(k.key)
          setNote('')
          setMaxUses(1)
          setDays('')
        },
        onError: (err) => setError(errMsg(err, t('admin.keyIssueFailed'))),
      },
    )
  }

  // Came from inside the app: go to the previous screen; opened by URL: go to the workspace home.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(wsId ? `/w/${wsId}` : '/')
  }

  /** Leave the default mail recipient empty for a delegated account's placeholder domain */
  const mailDefault = (email: string) =>
    delegatedSuffix.length > 1 && email.toLowerCase().endsWith(delegatedSuffix) ? '' : email

  const issueFor = (
    u: { id: string; email: string; name: string },
    kind: Issued['kind'],
    slot: string,
  ) => {
    setUserMsg(null)
    const isCode = kind === 'reset-code'
    void askConfirm(
      t(isCode ? 'admin.confirmIssueCode' : 'admin.confirmIssueTemp', { name: u.name, email: u.email }),
      t('admin.issue'),
    ).then((ok) => {
      if (!ok) return
      const onError = (err: unknown) =>
        setUserMsg({
          slot,
          text: errMsg(err, t(isCode ? 'admin.issueCodeFailed' : 'admin.issueTempFailed')),
          error: true,
        })
      if (kind === 'reset-code') {
        issueCode.mutate(u.id, {
          onSuccess: (r) =>
            setIssued({
              slot,
              userId: u.id,
              kind,
              secret: r.code,
              expiresAt: r.expiresAt,
              defaultTo: mailDefault(u.email),
            }),
          onError,
        })
      } else {
        issueTemp.mutate(u.id, {
          onSuccess: (r) =>
            setIssued({ slot, userId: u.id, kind, secret: r.password, defaultTo: mailDefault(u.email) }),
          onError,
        })
      }
    })
  }

  const removeUser = async (u: AdminUserDTO) => {
    setUserMsg(null)
    // What the deletion would take with it; on failure the dialog falls back to the generic text.
    const preview = await fetchDeletePreview(u.id).catch(() => null)
    const parts = [t('admin.confirmRemoveUser', { name: u.name, email: u.email })]
    if (preview && preview.personalWorkspaces > 0) {
      parts.push(
        t('admin.deletePersonal', { count: preview.personalWorkspaces, names: nameList(preview.personal) }),
      )
    }
    if (preview && preview.soleOwnedShared.length > 0) {
      parts.push(t('admin.deleteSoleOwned', { names: nameList(preview.soleOwnedShared) }))
    }
    void askConfirm(parts.join('\n\n'), t('admin.removeUser')).then((ok) => {
      if (!ok) return
      deleteUser.mutate(u.id, {
        onError: (err) => {
          // 409 SOLE_OWNER: list the workspaces that would be left without an owner (docs/API.md).
          if (err instanceof ApiError && err.code === 'SOLE_OWNER') {
            setSoleOwner({ user: u, workspaces: soleOwnerList(err.details.workspaces) })
            return
          }
          setUserMsg({ slot: `user:${u.id}`, text: errMsg(err, t('admin.removeUserFailed')), error: true })
        },
      })
    })
  }

  const toggleAdmin = (u: AdminUserDTO) => {
    setUserMsg(null)
    setAdmin.mutate(
      { id: u.id, isAdmin: !u.isAdmin },
      {
        onError: (err) =>
          setUserMsg({ slot: `user:${u.id}`, text: errMsg(err, t('admin.setAdminFailed')), error: true }),
      },
    )
  }

  // ---- list filters + paging ----
  const kq = keyQuery.trim().toLowerCase()
  const filteredKeys = (keys.data ?? []).filter(
    (k: SignupKeyDTO) =>
      !kq ||
      (k.key ?? k.keyHint ?? '').toLowerCase().includes(kq) ||
      (k.note ?? '').toLowerCase().includes(kq) ||
      k.usedBy.some((u) => u.email.toLowerCase().includes(kq) || u.name.toLowerCase().includes(kq)),
  )
  const keyView = paginate(filteredKeys, keyPage, PER_PAGE)

  const uq = userQuery.trim().toLowerCase()
  const filteredUsers = (users.data ?? []).filter(
    (u) => !uq || u.email.toLowerCase().includes(uq) || u.name.toLowerCase().includes(uq),
  )
  const userView = paginate(filteredUsers, userPage, PER_PAGE)

  const reqView = paginate(requests.data ?? [], reqPage, PER_PAGE)
  const pendingCount = (requests.data ?? []).filter((r) => r.status === 'pending').length

  const renderIssued = (slot: string) =>
    issued?.slot === slot && (
      <IssuedPanel
        key={issued.secret}
        issued={issued}
        mailEnabled={mailEnabled}
        onClose={() => setIssued(null)}
        onError={setError}
      />
    )
  const renderMsg = (slot: string) =>
    userMsg?.slot === slot && (
      <p className={`mt-1 text-xs ${userMsg.error ? 'text-red-600' : 'text-emerald-600'}`}>
        {userMsg.text}
      </p>
    )

  const reqStatus = (r: ResetRequestDTO) =>
    r.status === 'pending' ? (
      <Badge cls="bg-amber-500/10 text-amber-600">{t('admin.reqPending')}</Badge>
    ) : r.status === 'resolved' ? (
      <Badge cls="bg-emerald-500/10 text-emerald-600">{t('admin.reqResolved')}</Badge>
    ) : (
      <Badge cls="bg-sub/10 text-sub">{t('admin.reqDismissed')}</Badge>
    )

  const busyIssuing = issueCode.isPending || issueTemp.isPending

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('settings.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <button
          type="button"
          onClick={goBack}
          className="rounded-md px-2 py-1 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          ← {t('common.back')}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-ink">
          {t('admin.title')}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-bold text-ink">{t('admin.title')}</h1>
        <p className="mt-1 text-sm text-sub">
          {t('admin.intro')}
          {mode.data?.delegated && ` ${t('admin.introDelegated', { name: delegatedName })}`}
        </p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <ReleaseNotice />
      </header>

      {/* ---- password reset requests ---- */}
      <section className="mb-10">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          {t('admin.resetRequests')}
          {pendingCount > 0 && (
            <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white">
              {pendingCount}
            </span>
          )}
        </h2>
        {requests.isLoading ? (
          <Spinner size={18} />
        ) : reqView.items.length ? (
          <>
            <ul className="flex flex-col gap-2">
              {reqView.items.map((r) => {
                const slot = `req:${r.id}`
                // OIDC-created accounts have no password here either (docs/adr/1161-*)
                const delegated = r.origin !== 'local'
                const extName = r.origin === 'oidc' ? (mode.data?.oidc?.name ?? 'SSO') : delegatedName
                return (
                  <li key={r.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {reqStatus(r)}
                      <span className="text-sm font-medium text-ink">{r.name}</span>
                      <span className="text-xs text-sub">{r.email}</span>
                      {delegated && (
                        <Badge cls="bg-sub/10 text-sub">{extName}</Badge>
                      )}
                      <span className="ml-auto text-xs text-sub">{fmtDateTime(r.createdAt)}</span>
                    </div>
                    {r.note && (
                      <p className="mt-1.5 whitespace-pre-wrap break-words rounded bg-side px-2 py-1 text-xs text-ink">
                        {r.note}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-sub">
                      {r.ip && <span className="mr-2">IP {r.ip}</span>}
                      {r.status !== 'pending' && (
                        <span>
                          {t(r.status === 'resolved' ? 'admin.resolvedBy' : 'admin.dismissedBy', {
                            name: r.resolvedByName ?? '—',
                            date: fmtDateTime(r.resolvedAt),
                          })}
                        </span>
                      )}
                      {r.status === 'pending' && delegated && (
                        <span className="mr-2 text-amber-600">
                          {t('admin.delegatedReset', { name: extName })}
                        </span>
                      )}
                      {r.status === 'pending' && (
                        <span className="ml-auto flex flex-wrap gap-1">
                          {!delegated && (
                            <>
                              <button
                                type="button"
                                disabled={busyIssuing}
                                onClick={() =>
                                  issueFor({ id: r.userId, email: r.email, name: r.name }, 'reset-code', slot)
                                }
                                className={outlineBtn}
                              >
                                {t('admin.issueResetCode')}
                              </button>
                              <button
                                type="button"
                                disabled={busyIssuing}
                                onClick={() =>
                                  issueFor({ id: r.userId, email: r.email, name: r.name }, 'temp-password', slot)
                                }
                                className={outlineBtn}
                              >
                                {t('admin.issueTempPassword')}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              dismiss.mutate(r.id, {
                                onError: (err) =>
                                  setUserMsg({ slot, text: errMsg(err, t('admin.actionFailed')), error: true }),
                              })
                            }
                            className={smallBtn}
                          >
                            {t('admin.dismiss')}
                          </button>
                        </span>
                      )}
                    </div>
                    {renderMsg(slot)}
                    {renderIssued(slot)}
                  </li>
                )
              })}
            </ul>
            <Pager page={reqView.page} pageCount={reqView.pageCount} onChange={setReqPage} />
          </>
        ) : (
          <p className="text-sm text-sub">{t('admin.noRequests')}</p>
        )}
        <p className="mt-2 text-xs text-sub">
          {t('admin.requestsHint')}
          {mailEnabled && ` ${t('admin.requestsHintMail')}`}
        </p>
      </section>

      {/* ---- issue a key ---- */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('admin.newKey')}</h2>
        <form
          onSubmit={submit}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-4"
        >
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('admin.keyNote')}</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('admin.keyNotePlaceholder')}
              className={inputCls}
            />
          </label>
          <label className="flex w-24 flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('admin.maxUses')}</span>
            <input
              type="number"
              min={1}
              max={100}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              className={inputCls}
            />
          </label>
          <label className="flex w-32 flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('admin.expiresDays')}</span>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder={t('admin.noExpiry')}
              className={inputCls}
            />
          </label>
          <button
            type="submit"
            disabled={createKey.isPending}
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {createKey.isPending && (
              <Spinner size={14} className="border-white/40 border-t-white" />
            )}
            {t('admin.issue')}
          </button>
        </form>
        <p className="mt-2 text-xs text-sub">
          {t('admin.singleUseHint')}
        </p>

        {issuedKey && (
          <div className="mt-3 flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent/5 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-xs text-sub">{t('admin.issuedKey')}</div>
                <div className="font-mono text-base font-semibold text-ink">{issuedKey}</div>
              </div>
              <button type="button" onClick={() => copy(issuedKey)} className={outlineBtn}>
                {copied === issuedKey ? t('common.copied') : t('admin.copyKey')}
              </button>
              <button
                type="button"
                onClick={() =>
                  copy(`${window.location.origin}/register?key=${encodeURIComponent(issuedKey)}`)
                }
                className={outlineBtn}
              >
                {copied?.includes('/register') ? t('common.copied') : t('admin.copySignupLink')}
              </button>
            </div>
            {mailEnabled && (
              <MailSender
                key={issuedKey}
                defaultTo=""
                label={t('admin.sendInvite')}
                onSend={(to) => sendInvite.mutateAsync({ key: issuedKey, to })}
              />
            )}
          </div>
        )}
      </section>

      {/* ---- issued keys ---- */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {t('admin.issuedKeys')}
          {keys.data && <span className="ml-2 text-xs text-sub">{t('admin.keyCount', { count: keys.data.length })}</span>}
        </h2>
        <SearchBox
          value={keyQuery}
          onChange={(v) => {
            setKeyQuery(v)
            setKeyPage(1)
          }}
          placeholder={t('admin.searchKeys')}
        />

        {keys.isLoading ? (
          <Spinner size={18} />
        ) : keyView.items.length ? (
          <>
            <ul className="flex flex-col gap-2">
              {keyView.items.map((k) => {
                const st = keyState(k)
                return (
                  <li key={k.id ?? k.key} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {k.key ? (
                        <button
                          type="button"
                          onClick={() => copy(k.key!)}
                          title={t('admin.clickToCopy')}
                          className="font-mono text-sm text-ink transition-colors duration-150 hover:text-accent"
                        >
                          {copied === k.key ? t('common.copied') : k.key}
                        </button>
                      ) : (
                        // Used up (or its encrypted copy is unreadable): only the last four characters (docs/adr/1110-*)
                        <span className="font-mono text-sm text-sub" title={t('admin.keyHidden')}>
                          ••••-••••-••••-{k.keyHint ?? '••••'}
                        </span>
                      )}
                      <Badge cls={st.cls}>{st.label}</Badge>
                      <span className="text-xs text-sub">
                        {t('admin.keyUsage', { used: k.usedCount, max: k.maxUses, date: fmtDate(k.expiresAt) })}
                      </span>
                      {k.note && <span className="text-xs text-sub">· {k.note}</span>}
                      <button
                        type="button"
                        onClick={() => revokeKey.mutate(k.id ?? k.key ?? '')}
                        className="ml-auto rounded-md px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-red-600"
                      >
                        {t('admin.revoke')}
                      </button>
                    </div>
                    {k.usedBy.length > 0 && (
                      <div className="mt-2 border-t border-line pt-2 text-xs text-sub">
                        {t('admin.usedBy')}{' '}
                        {k.usedBy.map((u) => `${u.name} (${u.email})`).join(', ')}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <Pager page={keyView.page} pageCount={keyView.pageCount} onChange={setKeyPage} />
          </>
        ) : (
          <p className="text-sm text-sub">
            {kq ? t('admin.noSearchResults') : t('admin.noKeys')}
          </p>
        )}
        <p className="mt-2 text-xs text-sub">
          {t('admin.revokeHint')}
        </p>
      </section>

      {/* ---- users ---- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {t('admin.users')}
          {users.data && (
            <span className="ml-2 text-xs text-sub">{t('admin.userCount', { count: users.data.length })}</span>
          )}
        </h2>
        <SearchBox
          value={userQuery}
          onChange={(v) => {
            setUserQuery(v)
            setUserPage(1)
          }}
          placeholder={t('admin.searchUsers')}
        />
        {users.isLoading ? (
          <Spinner size={18} />
        ) : userView.items.length ? (
          <>
            <ul className="flex flex-col gap-1">
              {userView.items.map((u) => {
                const slot = `user:${u.id}`
                const isMe = u.id === me.data?.id
                const local = u.origin === 'local'
                const originBadge = userOriginBadge(u)
                const pwDisabledReason = !local
                  ? t('admin.pwDisabledDelegated', {
                      name: u.origin === 'oidc' ? (mode.data?.oidc?.name ?? 'SSO') : delegatedName,
                    })
                  : isMe
                    ? t('admin.pwDisabledSelf')
                    : undefined
                return (
                  <li key={u.id} className="rounded-md px-3 py-2 text-sm hover:bg-hover/60">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{u.name}</span>
                      <span className="text-xs text-sub">{u.email}</span>
                      <Badge cls="bg-sub/10 text-sub">
                        {originBadge === 'signupKey'
                          ? t('register.signupKey')
                          : originBadge === 'local'
                            ? t('admin.originLocal')
                            : originBadge === 'oidc'
                              ? (mode.data?.oidc?.name ?? 'SSO')
                              : delegatedName}
                      </Badge>
                      {local ? (
                        u.emailVerifiedAt ? (
                          <Badge cls="bg-emerald-500/10 text-emerald-600">{t('admin.verified')}</Badge>
                        ) : (
                          <Badge cls="bg-amber-500/10 text-amber-600">{t('admin.unverified')}</Badge>
                        )
                      ) : (
                        <Badge cls="bg-sub/10 text-sub">{t('admin.external')}</Badge>
                      )}
                      {u.isAdmin && <Badge cls="bg-accent/10 text-accent">{t('admin.adminBadge')}</Badge>}
                      {u.twoFactor && <Badge cls="bg-emerald-500/10 text-emerald-600">{t('admin.twofaBadge')}</Badge>}
                      <span className="ml-auto text-xs text-sub">{fmtDate(u.createdAt)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-0.5">
                      <button
                        type="button"
                        disabled={!!pwDisabledReason || busyIssuing}
                        title={pwDisabledReason}
                        onClick={() => issueFor(u, 'reset-code', slot)}
                        className={smallBtn}
                      >
                        {t('admin.resetCode')}
                      </button>
                      <button
                        type="button"
                        disabled={!!pwDisabledReason || busyIssuing}
                        title={pwDisabledReason}
                        onClick={() => issueFor(u, 'temp-password', slot)}
                        className={smallBtn}
                      >
                        {t('admin.tempPasswordShort')}
                      </button>
                      {u.twoFactor && !isMe && (
                        <button
                          type="button"
                          disabled={disableTwoFactor.isPending}
                          onClick={() =>
                            void askConfirm(
                              t('admin.confirmTwofaOff', { name: u.name, email: u.email }),
                              t('admin.twofaOff'),
                            ).then((ok) => {
                              if (!ok) return
                              disableTwoFactor.mutate(u.id, {
                                onSuccess: () => setUserMsg({ slot, text: t('admin.twofaTurnedOff') }),
                                onError: (err) =>
                                  setUserMsg({ slot, text: errMsg(err, t('admin.actionFailed')), error: true }),
                              })
                            })
                          }
                          className={smallBtn}
                        >
                          {t('admin.twofaOff')}
                        </button>
                      )}
                      {local && !u.emailVerifiedAt && (
                        <>
                          {mailEnabled && (
                            <button
                              type="button"
                              disabled={sendVerify.isPending}
                              onClick={() =>
                                sendVerify.mutate(u.id, {
                                  onSuccess: () =>
                                    setUserMsg({ slot, text: t('emailVerify.sent', { email: u.email }) }),
                                  onError: (err) =>
                                    setUserMsg({ slot, text: errMsg(err, t('auth.mailFailed')), error: true }),
                                })
                              }
                              className={smallBtn}
                            >
                              {t('admin.verifyMail')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              markVerified.mutate(
                                { id: u.id, verified: true },
                                {
                                  onError: (err) =>
                                    setUserMsg({ slot, text: errMsg(err, t('admin.actionFailed')), error: true }),
                                },
                              )
                            }
                            className={smallBtn}
                          >
                            {t('admin.markVerified')}
                          </button>
                        </>
                      )}
                      {!isMe && (
                        <>
                          <button type="button" onClick={() => toggleAdmin(u)} className={smallBtn}>
                            {u.isAdmin ? t('admin.revokeAdmin') : t('admin.makeAdmin')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeUser(u)}
                            className={`${smallBtn} hover:text-red-600`}
                          >
                            {t('admin.removeUserShort')}
                          </button>
                        </>
                      )}
                    </div>
                    {renderMsg(slot)}
                    {renderIssued(slot)}
                  </li>
                )
              })}
            </ul>
            <Pager page={userView.page} pageCount={userView.pageCount} onChange={setUserPage} />
          </>
        ) : (
          <p className="text-sm text-sub">{uq ? t('admin.noSearchResults') : t('admin.noUsers')}</p>
        )}
      </section>

      {/* ---- banned IPs ---- */}
      <div className="mt-10">
        <IpBansSection />
      </div>

      {/* ---- Backups ---- */}
      <div className="mt-10">
        <AdminBackupsSection />
      </div>

      {/* ---- Plugins (experimental) — renders nothing (no spacer) when the flag is off ---- */}
      <AdminPluginsSection />

      <SoleOwnerModal state={soleOwner} onClose={() => setSoleOwner(null)} />
    </div>
      </div>
    </div>
  )
}
