import { useState } from 'react'
import type { LaterItemDTO } from '@inkling/shared'
import { ApiError } from '../api'
import { fmtDateTime, useT, type TKey } from '../i18n'
import { deviceTimeZone, useDeleteLater, useLaterTarget, useSaveLater, useUpdateLater, type LaterTarget } from '../laterApi'
import { fromLocalInput, laterPresets, toLocalInput, type LaterPresetId } from '../lib/laterPresets'
import { toast } from '../lib/toast'
import { ClockIcon } from './Icons'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

// "Save for later" with a reminder (docs/adr/1410-*, 1411-*). Presets are computed on this device
// (its time zone); the server gets one absolute instant.

const PRESET_LABEL: Record<LaterPresetId, TKey> = {
  in20: 'later.presetIn20',
  tonight: 'later.presetTonight',
  tomorrow: 'later.presetTomorrow',
  nextWeek: 'later.presetNextWeek',
}

function saveInput(t: Exclude<LaterTarget, { kind: 'item' }>) {
  return t.kind === 'page'
    ? { kind: 'page' as const, pageId: t.pageId, anchor: t.anchor }
    : t.kind === 'thread'
      ? { kind: 'thread' as const, threadId: t.threadId }
      : { kind: 'notification' as const, notificationId: t.notificationId }
}

export function reminderLine(item: Pick<LaterItemDTO, 'remindAt' | 'reminded'>, t: ReturnType<typeof useT>): string | null {
  if (!item.remindAt) return null
  const time = fmtDateTime(item.remindAt)
  return item.reminded ? t('later.reminded', { time }) : t('later.remindAt', { time })
}

/** Save state and reminder choices for one target. */
export function LaterPanel({ target, onDone }: { target: LaterTarget; onDone?: () => void }) {
  const t = useT()
  const current = useLaterTarget(target)
  const save = useSaveLater()
  const update = useUpdateLater()
  const remove = useDeleteLater()
  const [custom, setCustom] = useState(() => toLocalInput(laterPresets()[2].at))
  const [error, setError] = useState<string | null>(null)
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : String(e))
  const item = current.data ?? null
  const open = item && !item.done
  const busy = save.isPending || update.isPending || remove.isPending

  const remindAt = (at: Date | null) => {
    setError(null)
    const tz = deviceTimeZone()
    const iso = at ? at.toISOString() : null
    if (open && item) {
      update.mutate({ id: item.id, remindAt: iso, remindTz: tz }, { onSuccess: () => onDone?.(), onError })
    } else if (target.kind !== 'item') {
      save.mutate(
        { ...saveInput(target), remindAt: iso, remindTz: tz },
        {
          onSuccess: () => {
            toast({ message: t('later.savedToast') })
            onDone?.()
          },
          onError,
        },
      )
    }
  }

  if (current.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={16} />
      </div>
    )
  }

  const presets = laterPresets()
  const zone = deviceTimeZone()
  return (
    <div className="flex flex-col gap-3" data-testid="later-panel">
      <div className="flex items-center gap-2">
        {open ? (
          <>
            <span className="flex-1 text-sm text-ink">
              {t('later.saved')}
              {item && reminderLine(item, t) && <span className="block text-xs text-sub">{reminderLine(item, t)}</span>}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                item &&
                remove.mutate(item.id, {
                  onSuccess: () => {
                    toast({ message: t('later.removedToast') })
                    onDone?.()
                  },
                  onError,
                })
              }
              className="rounded-md border border-line px-2.5 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              {t('later.delete')}
            </button>
          </>
        ) : target.kind === 'item' ? null : (
          <button
            type="button"
            disabled={busy}
            data-testid="later-save"
            onClick={() =>
              save.mutate(saveInput(target as Exclude<LaterTarget, { kind: 'item' }>), {
                onSuccess: () => {
                  toast({ message: t('later.savedToast') })
                  onDone?.()
                },
                onError,
              })
            }
            className="flex-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {t('later.save')}
          </button>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-sub">{t('later.remind')}</div>
        <ul className="flex flex-col">
          {presets.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={busy}
                data-testid={`later-preset-${p.id}`}
                onClick={() => remindAt(p.at)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                <span>{t(PRESET_LABEL[p.id])}</span>
                <span className="text-xs tabular-nums text-sub">{fmtDateTime(p.at)}</span>
              </button>
            </li>
          ))}
          {open && item?.remindAt && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => remindAt(null)}
                className="w-full rounded-md px-2 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
              >
                {t('later.clearReminder')}
              </button>
            </li>
          )}
        </ul>
        <form
          className="mt-2 flex flex-wrap items-center gap-2 px-2"
          onSubmit={(e) => {
            e.preventDefault()
            const at = fromLocalInput(custom)
            if (at) remindAt(at)
          }}
        >
          <label className="sr-only" htmlFor="later-custom">
            {t('later.custom')}
          </label>
          <input
            id="later-custom"
            type="datetime-local"
            value={custom}
            min={toLocalInput(new Date())}
            onChange={(e) => setCustom(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-app px-2 py-1 text-sm text-ink"
            aria-label={t('later.custom')}
          />
          <button
            type="submit"
            disabled={busy || !fromLocalInput(custom)}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-hover disabled:opacity-60"
          >
            {t('later.set')}
          </button>
        </form>
        {zone && <p className="mt-1.5 px-2 text-[11px] text-sub">{t('later.timeZone', { zone })}</p>}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Modal around LaterPanel (page menu, comment threads). */
export function LaterModal({ open, onClose, target }: { open: boolean; onClose: () => void; target: LaterTarget }) {
  const t = useT()
  return (
    <Modal open={open} onClose={onClose} title={t('later.save')}>
      <LaterPanel target={target} onDone={onClose} />
    </Modal>
  )
}

/** Small clock button that opens the modal; accent while the target is on the list. */
export function LaterButton({ target, className = '' }: { target: LaterTarget; className?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const current = useLaterTarget(target)
  const saved = !!current.data && !current.data.done
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-pressed={saved}
        aria-label={saved ? t('later.saved') : t('later.save')}
        title={saved ? t('later.saved') : t('later.save')}
        data-testid="later-button"
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-hover ${saved ? 'text-accent' : 'text-sub hover:text-ink'} ${className}`}
      >
        <ClockIcon size={12} /> {saved ? t('later.saved') : t('later.save')}
      </button>
      {open && <LaterModal open={open} onClose={() => setOpen(false)} target={target} />}
    </>
  )
}
