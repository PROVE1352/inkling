import { useState } from 'react'
import { Link } from 'react-router'
import type { PageVerificationDTO, VerifiedPageItemDTO } from '@inkling/shared'
import { VERIFY_NOTE_MAX, VERIFY_PRESET_DAYS } from '@inkling/shared'
import { ApiError } from '../api'
import { deviceTimeZone } from '../laterApi'
import { kindEmoji } from '../lib/pageIcon'
import { todayISODate } from '../lib/time'
import { usePageVerification, useVerifiedList, useVerifyPage } from '../verifyApi'
import { fmtDate, useT } from '../i18n'
import { Modal } from './Modal'
import { SELECT_CLASS } from './SettingsRows'
import { Spinner } from './Spinner'

// Page verification (docs/adr/1840-*, 1841-*): the badge under a page's title, the dialog that
// verifies (or re-verifies / removes), and the list of verified and expiring pages.

/** Shield with a check: "verified". Own glyph so Icons.tsx stays untouched. */
export function VerifiedIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

function changedText(t: ReturnType<typeof useT>, v: PageVerificationDTO): string | null {
  if (v.changedSections === 0) return null
  return t('pageVerify.changedSince', { count: v.changedSections })
}

/** Badge line under the title: verified until …, needs verification again, sections changed since. */
export function VerifyBadge({ pageId, onOpen }: { pageId: string; onOpen: () => void }) {
  const t = useT()
  const q = usePageVerification(pageId)
  const v = q.data?.verification
  if (!v) return null
  const expired = v.state === 'expired'
  const changed = changedText(t, v)
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="verify-badge"
      data-state={v.state}
      title={v.note ?? undefined}
      className={`mb-2 flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2.5 py-1 text-left text-xs transition-colors duration-150 hover:bg-hover ${
        expired ? 'border-amber-500/50 text-amber-700 dark:text-amber-400' : 'border-green-600/40 text-green-700 dark:text-green-400'
      }`}
    >
      <span className="flex items-center gap-1 font-medium">
        <VerifiedIcon size={12} />
        {expired ? t('pageVerify.needsAgain') : t('pageVerify.verified')}
      </span>
      <span className="text-sub">
        {expired
          ? t('pageVerify.expiredOn', { date: fmtDate(v.expiresAt) })
          : t('pageVerify.until', { date: fmtDate(v.expiresAt) })}
        {v.verifiedBy ? ` · ${v.verifiedBy.name}` : ''}
      </span>
      {changed && <span className={v.changedMuch ? 'text-amber-700 dark:text-amber-400' : 'text-sub'}>· {changed}</span>}
    </button>
  )
}

type Duration = string // '30' | '90' | '180' | 'date'

/** Verify / re-verify / remove, with the current state on top. */
export function VerifyModal({
  open,
  onClose,
  pageId,
  onOpenList,
}: {
  open: boolean
  onClose: () => void
  pageId: string
  /** "All verified pages": the caller closes this dialog and opens the list. */
  onOpenList: () => void
}) {
  const t = useT()
  const q = usePageVerification(pageId)
  const verify = useVerifyPage(pageId)
  const [duration, setDuration] = useState<Duration>('90')
  const [date, setDate] = useState('')
  const [note, setNote] = useState(q.data?.verification?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const v = q.data?.verification ?? null
  const canVerify = !!q.data?.canVerify

  const body = () => {
    const n = note.trim() ? note.trim() : null
    if (duration === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
      if (!m) return null
      // end of that local day, in the device's time zone
      return { expiresAt: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString(), note: n }
    }
    return { expiresInDays: Number(duration), note: n }
  }
  const run = (input: ReturnType<typeof body>) => {
    setError(null)
    verify.mutate(input, {
      onSuccess: onClose,
      onError: (err) => setError(err instanceof ApiError ? err.message : t('pageVerify.failed')),
    })
  }
  const zone = deviceTimeZone()

  return (
    <Modal open={open} onClose={onClose} title={t('pageVerify.title')}>
      <div className="flex flex-col gap-3 text-sm">
        {q.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner size={18} />
          </div>
        ) : v ? (
          <div className="rounded-md border border-line px-3 py-2">
            <div className={`flex items-center gap-1.5 font-medium ${v.state === 'expired' ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
              <VerifiedIcon />
              {v.state === 'expired' ? t('pageVerify.needsAgain') : t('pageVerify.verified')}
            </div>
            <p className="mt-1 text-xs text-sub">
              {t('pageVerify.byOn', { name: v.verifiedBy?.name || t('pageVerify.someone'), date: fmtDate(v.verifiedAt) })} ·{' '}
              {v.state === 'expired' ? t('pageVerify.expiredOn', { date: fmtDate(v.expiresAt) }) : t('pageVerify.until', { date: fmtDate(v.expiresAt) })}
            </p>
            {v.note && <p className="mt-1 text-xs text-ink">{v.note}</p>}
            <p className={`mt-1 text-xs ${v.changedMuch ? 'text-amber-700 dark:text-amber-400' : 'text-sub'}`}>
              {changedText(t, v) ?? t('pageVerify.noChanges')}
            </p>
          </div>
        ) : (
          <p className="text-xs text-sub">{t('pageVerify.explain')}</p>
        )}

        {canVerify ? (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              const b = body()
              if (b) run(b)
            }}
          >
            <label className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-sub">{t('pageVerify.validFor')}</span>
              <select value={duration} onChange={(e) => setDuration(e.target.value)} className={SELECT_CLASS}>
                {VERIFY_PRESET_DAYS.map((d) => (
                  <option key={d} value={String(d)}>
                    {t('pageVerify.days', { count: d })}
                  </option>
                ))}
                <option value="date">{t('pageVerify.onDate')}</option>
              </select>
              {duration === 'date' && (
                <input
                  type="date"
                  value={date}
                  min={todayISODate()}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label={t('pageVerify.onDate')}
                  className="rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              )}
            </label>
            <input
              value={note}
              maxLength={VERIFY_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('pageVerify.notePlaceholder')}
              aria-label={t('pageVerify.note')}
              className="w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {duration === 'date' && zone && <p className="text-xs text-sub">{t('pageVerify.timeZone', { zone })}</p>}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              {v && (
                <button
                  type="button"
                  disabled={verify.isPending}
                  onClick={() => run(null)}
                  className="mr-auto rounded-md border border-line px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
                >
                  {t('pageVerify.remove')}
                </button>
              )}
              <button
                type="submit"
                disabled={verify.isPending || !body()}
                data-testid="verify-submit"
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {v ? t('pageVerify.again') : t('pageVerify.mark')}
              </button>
            </div>
          </form>
        ) : (
          <p className="text-xs text-sub">{t('pageVerify.cannot')}</p>
        )}
        <button type="button" onClick={onOpenList} className="self-start text-xs text-accent hover:underline">
          {t('pageVerify.listLink')}
        </button>
      </div>
    </Modal>
  )
}

function ListGroup({ title, items, wsId, tone }: { title: string; items: VerifiedPageItemDTO[]; wsId: string; tone: string }) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className={`text-xs font-medium ${tone}`}>
        {title} · {items.length}
      </h3>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.pageId}>
            <Link
              to={`/w/${wsId}/p/${it.pageId}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-hover"
            >
              <span className="w-5 shrink-0 text-center">{it.icon && !it.icon.startsWith('/') ? it.icon : kindEmoji(it.kind)}</span>
              <span className="min-w-0 flex-1 truncate">{it.title || t('common.untitled')}</span>
              {it.verification.changedSections > 0 && (
                <span className={`shrink-0 text-[11px] ${it.verification.changedMuch ? 'text-amber-700 dark:text-amber-400' : 'text-sub'}`}>
                  {t('pageVerify.changedShort', { count: it.verification.changedSections })}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-sub">{fmtDate(it.verification.expiresAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Expired, expiring within the window, and still verified pages of a workspace. */
export function VerifiedListModal({ open, onClose, wsId }: { open: boolean; onClose: () => void; wsId: string }) {
  const t = useT()
  const [mine, setMine] = useState(false)
  const q = useVerifiedList(wsId, mine)
  const d = q.data
  const empty = d && d.expired.length + d.expiring.length + d.verified.length === 0
  return (
    <Modal open={open} onClose={onClose} title={t('pageVerify.listTitle')} size="md">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-xs text-sub">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          {t('pageVerify.onlyMine')}
        </label>
        {q.isLoading || !d ? (
          <div className="flex justify-center py-6">
            <Spinner size={18} />
          </div>
        ) : empty ? (
          <p className="py-4 text-center text-sm text-sub">{t('pageVerify.listEmpty')}</p>
        ) : (
          <>
            <ListGroup title={t('pageVerify.groupExpired')} items={d.expired} wsId={wsId} tone="text-amber-700 dark:text-amber-400" />
            <ListGroup title={t('pageVerify.groupExpiring', { count: d.expiringDays })} items={d.expiring} wsId={wsId} tone="text-ink" />
            <ListGroup title={t('pageVerify.groupVerified')} items={d.verified} wsId={wsId} tone="text-green-700 dark:text-green-400" />
          </>
        )}
      </div>
    </Modal>
  )
}
