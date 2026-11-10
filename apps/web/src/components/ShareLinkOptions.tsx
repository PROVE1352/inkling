import { useState } from 'react'
import type { CreateShareInput, SharePolicyDTO, ShareStatusDTO, UpdateShareInput } from '@inkling/shared'
import { SHARE_EXPIRY_PRESET_DAYS, SHARE_PASSWORD_LENGTH } from '@inkling/shared'
import { ApiError, useUpdateShare } from '../api'
import { fmtDate, useT } from '../i18n'
import { todayISODate } from '../lib/time'
import { fromLocalInput, toLocalInput } from '../lib/laterPresets'
import { deviceTimeZone } from '../laterApi'
import { SELECT_CLASS } from './SettingsRows'
import { Spinner } from './Spinner'

// Expiry and password of a public link (docs/adr/1170-*, 1171-*, 1172-*): the options shown before
// publishing, and the settings of an existing link. Times are decided on the server: presets send a
// day count, "on a date" sends the end of that local day.

/** 'never' | '1' | '7' | '30' | other default day count | 'date' */
type ExpiryValue = string

function expiryOptions(t: ReturnType<typeof useT>, extraDays: number | null) {
  const days = [...SHARE_EXPIRY_PRESET_DAYS] as number[]
  if (extraDays && !days.includes(extraDays)) days.push(extraDays)
  days.sort((a, b) => a - b)
  return [
    { value: 'never', label: t('shareLink.never') },
    ...days.map((d) => ({ value: String(d), label: t('shareLink.days', { count: d }) })),
    { value: 'date', label: t('shareLink.pickDate') },
  ]
}

/** End of a local 'YYYY-MM-DD' day as an ISO instant. */
function endOfLocalDay(ymd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString()
}

/** The expiry part of a request body for a choice (undefined while a date is still missing). */
function expiryBody(value: ExpiryValue, date: string): Pick<CreateShareInput, 'expiresAt' | 'expiresInDays'> | undefined {
  if (value === 'never') return { expiresAt: null }
  if (value === 'date') {
    const at = endOfLocalDay(date)
    return at ? { expiresAt: at } : undefined
  }
  return { expiresInDays: Number(value) }
}

function ExpirySelect({
  value,
  date,
  onValue,
  onDate,
  extraDays,
  disabled,
}: {
  value: ExpiryValue
  date: string
  onValue: (v: ExpiryValue) => void
  onDate: (d: string) => void
  extraDays: number | null
  disabled?: boolean
}) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={value}
        aria-label={t('shareLink.expires')}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
        className={SELECT_CLASS}
      >
        {expiryOptions(t, extraDays).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {value === 'date' && (
        <input
          type="date"
          value={date}
          min={todayISODate()}
          aria-label={t('shareLink.dateLabel')}
          title={t('shareLink.dateLabel')}
          disabled={disabled}
          onChange={(e) => onDate(e.target.value)}
          className="rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      )}
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

const dateTimeClass =
  'rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

/**
 * Start of a scheduled link (docs/adr/1844-*): a local date and time in the device's time zone,
 * sent as an instant. Before it, visitors get the same page as for a link that does not exist.
 */
function StartInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT()
  return (
    <input
      type="datetime-local"
      value={value}
      min={toLocalInput(new Date())}
      aria-label={t('shareLink.startsLabel')}
      title={t('shareLink.startsLabel')}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={dateTimeClass}
    />
  )
}

function ZoneNote() {
  const t = useT()
  const zone = deviceTimeZone()
  return zone ? <p className="text-xs text-sub">{t('shareLink.timeZone', { zone })}</p> : null
}

function PolicyNote({ policy }: { policy: SharePolicyDTO | undefined }) {
  const t = useT()
  if (!policy || (!policy.passwordRequired && !policy.defaultExpiryDays)) return null
  return (
    <p className="text-xs text-sub">
      {policy.passwordRequired && t('shareLink.policyPassword')}
      {policy.passwordRequired && policy.defaultExpiryDays ? ' ' : ''}
      {policy.defaultExpiryDays ? t('shareLink.policyDefault', { count: policy.defaultExpiryDays }) : ''}
    </p>
  )
}

/**
 * Options picked before "Publish to web". Returns the body for POST /share, or null while the
 * choice is incomplete (date missing, password too short).
 */
export function usePublishOptions(policy: SharePolicyDTO | undefined) {
  const def = policy?.defaultExpiryDays ?? null
  const [expiry, setExpiry] = useState<ExpiryValue | null>(null)
  const [date, setDate] = useState('')
  const [withPassword, setWithPassword] = useState(false)
  const [password, setPassword] = useState('')
  // scheduled start (docs/adr/1844-*): off = the link opens at once
  const [scheduled, setScheduled] = useState(false)
  const [start, setStart] = useState('')
  const value = expiry ?? (def ? String(def) : 'never')
  const needPassword = withPassword || !!policy?.passwordRequired
  const exp = expiryBody(value, date)
  const passwordOk = !needPassword || password.length >= SHARE_PASSWORD_LENGTH.min
  const startAt = scheduled ? fromLocalInput(start) : null
  const startOk = !scheduled || !!startAt
  const body: CreateShareInput | null =
    exp && passwordOk && startOk
      ? { ...exp, ...(needPassword ? { password } : {}), ...(startAt ? { startsAt: startAt.toISOString() } : {}) }
      : null
  return {
    body,
    reset: () => {
      setExpiry(null)
      setDate('')
      setWithPassword(false)
      setPassword('')
      setScheduled(false)
      setStart('')
    },
    view: (
      <PublishOptionsView
        policy={policy}
        value={value}
        date={date}
        onValue={setExpiry}
        onDate={setDate}
        needPassword={needPassword}
        onWithPassword={setWithPassword}
        password={password}
        onPassword={setPassword}
        scheduled={scheduled}
        onScheduled={setScheduled}
        start={start}
        onStart={setStart}
      />
    ),
  }
}

function PublishOptionsView({
  policy,
  value,
  date,
  onValue,
  onDate,
  needPassword,
  onWithPassword,
  password,
  onPassword,
  scheduled,
  onScheduled,
  start,
  onStart,
}: {
  policy: SharePolicyDTO | undefined
  value: ExpiryValue
  date: string
  onValue: (v: ExpiryValue) => void
  onDate: (d: string) => void
  needPassword: boolean
  onWithPassword: (v: boolean) => void
  password: string
  onPassword: (v: string) => void
  scheduled: boolean
  onScheduled: (v: boolean) => void
  start: string
  onStart: (v: string) => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line px-3 py-2.5">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={scheduled} onChange={(e) => onScheduled(e.target.checked)} data-testid="share-schedule" />
        {t('shareLink.schedule')}
      </label>
      {scheduled && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.starts')}</span>
            <StartInput value={start} onChange={onStart} />
          </div>
          <p className="text-xs text-sub">{t('shareLink.scheduleHint')}</p>
          <ZoneNote />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.expires')}</span>
        <ExpirySelect
          value={value}
          date={date}
          onValue={onValue}
          onDate={onDate}
          extraDays={policy?.defaultExpiryDays ?? null}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={needPassword}
          disabled={!!policy?.passwordRequired}
          onChange={(e) => onWithPassword(e.target.checked)}
        />
        {t('shareLink.requirePassword')}
      </label>
      {needPassword && (
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          maxLength={SHARE_PASSWORD_LENGTH.max}
          placeholder={t('shareLink.passwordPlaceholder')}
          aria-label={t('shareLink.password')}
          onChange={(e) => onPassword(e.target.value)}
          className={inputClass}
        />
      )}
      {needPassword && <p className="text-xs text-sub">{t('shareLink.passwordHint')}</p>}
      <PolicyNote policy={policy} />
    </div>
  )
}

/** Expiry and password of a published link: status for everyone, changes for owners and admins. */
export function LinkSettings({
  pageId,
  status,
  canManage,
}: {
  pageId: string
  status: ShareStatusDTO
  canManage: boolean
}) {
  const t = useT()
  const update = useUpdateShare(pageId)
  const [error, setError] = useState<string | null>(null)
  const [editingExpiry, setEditingExpiry] = useState(false)
  const [expiry, setExpiry] = useState<ExpiryValue>('7')
  const [date, setDate] = useState('')
  const [editingPassword, setEditingPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [editingStart, setEditingStart] = useState(false)
  const [start, setStart] = useState('')
  const policy = status.policy

  const send = (body: UpdateShareInput, done?: () => void) => {
    setError(null)
    update.mutate(body, {
      onSuccess: () => done?.(),
      onError: (err) => setError(err instanceof ApiError ? err.message : t('shareLink.updateFailed')),
    })
  }

  const expiresAt = status.expiresAt ?? null
  const expiryText = !expiresAt
    ? t('shareLink.noExpiry')
    : status.expired
      ? t('shareLink.expiredOn', { date: fmtDate(expiresAt) })
      : t('shareLink.expiresOn', { date: fmtDate(expiresAt, { dateStyle: 'medium', timeStyle: 'short' }) })
  const pendingExpiry = expiryBody(expiry, date)
  const btn =
    'rounded-md border border-line px-2.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60'

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.expires')}</span>
          <span className={`min-w-0 flex-1 text-sm ${status.expired ? 'text-red-600' : 'text-ink'}`}>{expiryText}</span>
          {canManage && !editingExpiry && (
            <button type="button" className={btn} onClick={() => setEditingExpiry(true)}>
              {t('shareLink.extend')}
            </button>
          )}
        </div>
        {canManage && editingExpiry && (
          <div className="flex flex-wrap items-center gap-2 pl-[92px] max-sm:pl-0">
            <ExpirySelect value={expiry} date={date} onValue={setExpiry} onDate={setDate} extraDays={policy?.defaultExpiryDays ?? null} disabled={update.isPending} />
            <button
              type="button"
              disabled={!pendingExpiry || update.isPending}
              onClick={() => pendingExpiry && send(pendingExpiry, () => setEditingExpiry(false))}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {t('shareLink.apply')}
            </button>
            <button type="button" className={btn} onClick={() => setEditingExpiry(false)}>
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>

      {(status.startsAt || canManage) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.starts')}</span>
            <span className={`min-w-0 flex-1 text-sm ${status.notStarted ? 'text-amber-600' : 'text-ink'}`} data-testid="share-starts">
              {status.startsAt && status.notStarted
                ? t('shareLink.startsOn', { date: fmtDate(status.startsAt, { dateStyle: 'medium', timeStyle: 'short' }) })
                : t('shareLink.openNow')}
            </span>
            {canManage && !editingStart && (
              <>
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    setStart(status.startsAt ? toLocalInput(new Date(status.startsAt)) : '')
                    setEditingStart(true)
                  }}
                >
                  {status.notStarted ? t('shareLink.changeStart') : t('shareLink.schedule')}
                </button>
                {status.notStarted && (
                  <button type="button" className={btn} disabled={update.isPending} onClick={() => send({ startsAt: null })}>
                    {t('shareLink.openNowAction')}
                  </button>
                )}
              </>
            )}
          </div>
          {canManage && editingStart && (
            <div className="flex flex-col gap-1.5 pl-[92px] max-sm:pl-0">
              <div className="flex flex-wrap items-center gap-2">
                <StartInput value={start} onChange={setStart} disabled={update.isPending} />
                <button
                  type="button"
                  disabled={!fromLocalInput(start) || update.isPending}
                  onClick={() => {
                    const at = fromLocalInput(start)
                    if (at) send({ startsAt: at.toISOString() }, () => setEditingStart(false))
                  }}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {t('shareLink.apply')}
                </button>
                <button type="button" className={btn} onClick={() => setEditingStart(false)}>
                  {t('common.cancel')}
                </button>
              </div>
              <ZoneNote />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.password')}</span>
          <span className="min-w-0 flex-1 text-sm text-ink">
            {status.hasPassword ? t('shareLink.passwordOn') : t('shareLink.passwordOff')}
          </span>
          {canManage && !editingPassword && (
            <>
              <button type="button" className={btn} onClick={() => setEditingPassword(true)}>
                {status.hasPassword ? t('shareLink.changePassword') : t('shareLink.setPassword')}
              </button>
              {status.hasPassword && !policy?.passwordRequired && (
                <button type="button" className={btn} disabled={update.isPending} onClick={() => send({ password: null })}>
                  {t('shareLink.removePassword')}
                </button>
              )}
            </>
          )}
        </div>
        {canManage && editingPassword && (
          <form
            className="flex items-center gap-2 pl-[92px] max-sm:pl-0"
            onSubmit={(e) => {
              e.preventDefault()
              if (password.length < SHARE_PASSWORD_LENGTH.min) {
                setError(t('shareLink.tooShort'))
                return
              }
              send({ password }, () => {
                setEditingPassword(false)
                setPassword('')
              })
            }}
          >
            <input
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              maxLength={SHARE_PASSWORD_LENGTH.max}
              placeholder={t('shareLink.passwordPlaceholder')}
              aria-label={t('shareLink.password')}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={update.isPending}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {update.isPending ? <Spinner size={12} className="border-white/40 border-t-white" /> : t('shareLink.save')}
            </button>
            <button
              type="button"
              className={`${btn} shrink-0 py-1.5`}
              onClick={() => {
                setEditingPassword(false)
                setPassword('')
              }}
            >
              {t('common.cancel')}
            </button>
          </form>
        )}
      </div>
      {/* visitors' Markdown download (docs/adr/2362-*): off until a manager turns it on */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-sub">{t('shareLink.download')}</span>
          {canManage ? (
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={!!status.allowDownload}
                disabled={update.isPending}
                onChange={(e) => send({ allowDownload: e.target.checked })}
                data-testid="share-allow-download"
              />
              {t('shareLink.allowDownload')}
            </label>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-ink">
              {status.allowDownload ? t('shareLink.downloadOn') : t('shareLink.downloadOff')}
            </span>
          )}
        </div>
        {canManage && <p className="pl-[92px] text-xs text-sub max-sm:pl-0">{t('shareLink.downloadHint')}</p>}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {canManage && <PolicyNote policy={policy} />}
    </div>
  )
}
