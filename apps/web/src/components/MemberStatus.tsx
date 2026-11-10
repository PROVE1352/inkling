import { useState } from 'react'
import type { MemberStatusDTO } from '@inkling/shared'
import { MEMBER_STATUS_EMOJI_MAX, MEMBER_STATUS_TEXT_MAX } from '@inkling/shared'
import { ApiError } from '../api'
import { deviceTimeZone } from '../laterApi'
import { fromLocalInput, toLocalInput } from '../lib/laterPresets'
import { liveStatus, statusLabel, useMyStatus, useSetMyStatus } from '../memberStatusApi'
import { fmtDate, useT } from '../i18n'
import { Modal } from './Modal'
import { Row, SELECT_CLASS } from './SettingsRows'

// Member status (docs/adr/1845-*, 1846-*): a short message with an emoji and an automatic clear
// time. Clear times are picked in the device's time zone and sent as instants; the server drops a
// status once it has passed.

const QUICK_EMOJI = ['🎓', '📚', '🌴', '🤒', '🎧', '🚗', '🏠', '⏳'] as const

type ClearChoice = 'never' | 'hour' | 'today' | 'week' | 'custom'

/** The instant a preset means on this device (null = never; undefined = custom not filled yet). */
export function clearInstant(choice: ClearChoice, custom: string, now = new Date()): Date | null | undefined {
  if (choice === 'never') return null
  if (choice === 'hour') return new Date(now.getTime() + 3_600_000)
  if (choice === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0)
  if (choice === 'week') {
    // end of this week's Sunday (getDay: 0 = Sunday); on a Sunday, the end of today
    const toSunday = (7 - now.getDay()) % 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + toSunday, 23, 59, 0, 0)
  }
  return fromLocalInput(custom) ?? undefined
}

/** Small "🎓 Exam week" chip next to a name; the title says until when. */
export function StatusChip({ status, className = '' }: { status: MemberStatusDTO | null | undefined; className?: string }) {
  const t = useT()
  const s = liveStatus(status)
  if (!s) return null
  const until = s.clearAt ? t('status.until', { date: fmtDate(s.clearAt, { dateStyle: 'medium', timeStyle: 'short' }) }) : ''
  return (
    <span
      data-testid="member-status"
      title={until ? `${statusLabel(s)} · ${until}` : statusLabel(s)}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-full bg-hover px-1.5 py-px text-[11px] leading-4 text-sub ${className}`}
    >
      <span className="truncate">{statusLabel(s)}</span>
    </span>
  )
}

export function StatusModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const mine = useMyStatus()
  const set = useSetMyStatus()
  const current = liveStatus(mine.data)
  const [emoji, setEmoji] = useState<string>(current?.emoji ?? '')
  const [text, setText] = useState(current?.text ?? '')
  const [choice, setChoice] = useState<ClearChoice>(current?.clearAt ? 'custom' : 'never')
  const [custom, setCustom] = useState(current?.clearAt ? toLocalInput(new Date(current.clearAt)) : '')
  const [error, setError] = useState<string | null>(null)
  const zone = deviceTimeZone()
  const clearAt = clearInstant(choice, custom)
  const canSave = (emoji.trim() !== '' || text.trim() !== '') && clearAt !== undefined && !set.isPending

  const save = () => {
    if (clearAt === undefined) return
    setError(null)
    set.mutate(
      { emoji: emoji.trim() || null, text: text.trim(), clearAt: clearAt ? clearAt.toISOString() : null },
      {
        onSuccess: onClose,
        onError: (err) => setError(err instanceof ApiError ? err.message : t('status.saveFailed')),
      },
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={t('status.title')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) save()
        }}
      >
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('status.emoji')}>
          {QUICK_EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              aria-pressed={emoji === e}
              onClick={() => setEmoji(emoji === e ? '' : e)}
              className={`flex h-9 w-9 items-center justify-center rounded-md text-lg transition-colors duration-150 hover:bg-hover ${
                emoji === e ? 'bg-accent/15 ring-1 ring-accent' : ''
              }`}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value.slice(0, MEMBER_STATUS_EMOJI_MAX))}
            aria-label={t('status.emoji')}
            placeholder="🙂"
            className="w-14 shrink-0 rounded-md border border-line bg-app px-2 py-1.5 text-center text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <input
            value={text}
            autoFocus
            maxLength={MEMBER_STATUS_TEXT_MAX}
            onChange={(e) => setText(e.target.value)}
            aria-label={t('status.text')}
            placeholder={t('status.placeholder')}
            className="min-w-0 flex-1 rounded-md border border-line bg-app px-2.5 py-1.5 text-sm text-ink placeholder:text-sub/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <span className="text-xs text-sub">{t('status.clearAfter')}</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value as ClearChoice)} className={SELECT_CLASS}>
            <option value="never">{t('status.clearNever')}</option>
            <option value="hour">{t('status.clearHour')}</option>
            <option value="today">{t('status.clearToday')}</option>
            <option value="week">{t('status.clearWeek')}</option>
            <option value="custom">{t('status.clearCustom')}</option>
          </select>
          {choice === 'custom' && (
            <input
              type="datetime-local"
              value={custom}
              min={toLocalInput(new Date())}
              onChange={(e) => setCustom(e.target.value)}
              aria-label={t('status.clearCustom')}
              className="rounded-md border border-line bg-app px-2 py-1 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          )}
        </label>
        {zone && <p className="text-xs text-sub">{t('status.timeZone', { zone })}</p>}
        <p className="text-xs text-sub">{t('status.hint')}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          {current && (
            <button
              type="button"
              disabled={set.isPending}
              onClick={() => set.mutate(null, { onSuccess: onClose })}
              className="mr-auto rounded-md border border-line px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink"
            >
              {t('status.clear')}
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSave}
            data-testid="status-save"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {t('status.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Settings → Account: the person's own status. */
export function StatusRow() {
  const t = useT()
  const mine = useMyStatus()
  const [open, setOpen] = useState(false)
  const current = liveStatus(mine.data)
  return (
    <>
      <Row title={t('status.title')} desc={current ? undefined : t('status.none')}>
        {current && <StatusChip status={current} />}
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="status-open"
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:bg-hover"
        >
          {current ? t('status.edit') : t('status.set')}
        </button>
      </Row>
      {/* remount per open: the form starts from the saved status each time */}
      {open && <StatusModal key="status-modal" open={open} onClose={() => setOpen(false)} />}
    </>
  )
}
