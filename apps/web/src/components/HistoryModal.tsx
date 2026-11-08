import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ApiError,
  useCreateSnapshot,
  useRestoreSnapshot,
  useSnapshotPreview,
  useSnapshots,
} from '../api'
import { useSnapshotDiff } from '../notificationsApi'
import { relativeTime } from '../lib/time'
import { ConfirmPopover } from './ConfirmPopover'
import { DiffView } from './DiffView'
import { HistoryIcon, RestoreIcon, XIcon } from './Icons'
import { Spinner } from './Spinner'
import { t, useT, type TKey } from '../i18n'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Unlabeled snapshots (autosaves) get a default label so their kind is obvious.
// Labels the server stores for system snapshots, in whichever language the creator used
// (routes/snapshots.ts, routes/pageContent.ts). Shown in the viewer's language instead.
const SYSTEM_LABELS: Record<string, TKey> = {
  Manual: 'history.labelManual',
  수동: 'history.labelManual',
  'Before restore': 'history.labelBeforeRestore',
  '복원 전': 'history.labelBeforeRestore',
  'Before AI edit': 'history.labelBeforeAiEdit',
  'AI 편집 전': 'history.labelBeforeAiEdit',
  'AI edit': 'history.labelAiEdit',
  'AI 편집': 'history.labelAiEdit',
}

/** "Alice" / "Alice (via Claude)" for a snapshot's author line; null when there is none (autosave). */
export function snapAuthor(s: { author?: { name: string } | null; viaClient?: string | null }): string | null {
  if (!s.author) return s.viaClient ? t('comments.via', { client: s.viaClient }) : null
  return s.viaClient ? t('history.byVia', { name: s.author.name, client: s.viaClient }) : s.author.name
}

export function snapLabel(label: string | null): string {
  const l = label?.trim()
  if (!l) return t('history.autosave')
  const sys = SYSTEM_LABELS[l]
  return sys ? t(sys) : l
}

export function HistoryModal({
  open,
  onClose,
  pageId,
  initialSid,
}: {
  open: boolean
  onClose: () => void
  pageId: string
  initialSid?: string | null
}) {
  const t = useT()
  const snapshots = useSnapshots(pageId, open)
  const create = useCreateSnapshot(pageId)
  const restore = useRestoreSnapshot(pageId)

  const [selected, setSelected] = useState<string | null>(initialSid ?? null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  // 'diff' = compare the selected snapshot with the current document (docs/adr/1004-*).
  const [mode, setMode] = useState<'preview' | 'diff'>('preview')
  const preview = useSnapshotPreview(pageId, open && mode === 'preview' ? selected : null)
  const diff = useSnapshotDiff(pageId, open && mode === 'diff' ? selected : null, 'current')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const list = snapshots.data ?? []

  const doCreate = () => {
    setError(null)
    create.mutate(undefined, {
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('history.snapshotFailed')),
    })
  }

  const doRestore = () => {
    if (!selected) return
    setConfirmRestore(false)
    setError(null)
    restore.mutate(selected, {
      // Restored → close the modal. Open editors update live through collab.
      onSuccess: () => onClose(),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('history.restoreFailed')),
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="nd-dialog flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-app shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <HistoryIcon size={17} /> {t('history.title')}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={doCreate}
              disabled={create.isPending}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
            >
              {create.isPending ? <Spinner size={14} /> : <HistoryIcon size={14} />}
              {t('history.snapshotNow')}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <XIcon size={18} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* list */}
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-line md:max-h-none md:w-64 md:border-b-0 md:border-r">
            {snapshots.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size={18} />
              </div>
            ) : list.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-sub">
                {t('history.empty')}
              </p>
            ) : (
              list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelected(s.id)}
                  className={`flex w-full flex-col gap-0.5 border-b border-line/60 px-3 py-2 text-left transition-colors duration-150 ${
                    selected === s.id ? 'bg-active' : 'hover:bg-hover'
                  }`}
                >
                  <span className="truncate text-xs font-medium text-ink">
                    {snapLabel(s.label)}
                  </span>
                  {snapAuthor(s) && (
                    <span className="truncate text-[11px] text-sub">{snapAuthor(s)}</span>
                  )}
                  <span className="flex items-center gap-1.5 text-[11px] text-sub">
                    <span>{relativeTime(s.createdAt)}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtBytes(s.bytes)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          {/* preview */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selected && (
              <div className="sticky top-0 z-10 flex justify-end gap-1 border-b border-line bg-app px-3 py-1.5">
                {(['preview', 'diff'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`rounded-md px-2 py-0.5 text-xs transition-colors duration-150 ${
                      mode === m ? 'bg-active font-medium text-ink' : 'text-sub hover:bg-hover hover:text-ink'
                    }`}
                  >
                    {m === 'preview' ? t('historyDiff.preview') : t('historyDiff.compare')}
                  </button>
                ))}
              </div>
            )}
            {!selected ? (
              <p className="px-4 py-10 text-center text-xs text-sub">
                {t('history.selectHint')}
              </p>
            ) : mode === 'diff' ? (
              diff.isLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner size={18} />
                </div>
              ) : diff.isError || !diff.data ? (
                <p className="px-4 py-10 text-center text-xs text-red-600">{t('diff.loadFailed')}</p>
              ) : (
                <div className="px-4 py-3">
                  <DiffView ops={diff.data.ops} large={diff.data.large} />
                </div>
              )
            ) : preview.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner size={18} />
              </div>
            ) : preview.isError ? (
              <p className="px-4 py-10 text-center text-xs text-red-600">
                {t('history.previewFailed')}
              </p>
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 text-xs leading-relaxed text-ink">
                {preview.data || t('history.emptyDoc')}
              </pre>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-xs text-red-600">{error}</span>
          <ConfirmPopover
            open={confirmRestore}
            onCancel={() => setConfirmRestore(false)}
            onConfirm={doRestore}
            message={t('history.restoreConfirm')}
            confirmLabel={t('common.restore')}
          >
            <button
              type="button"
              onClick={() => setConfirmRestore(true)}
              disabled={!selected || restore.isPending}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-50"
            >
              {restore.isPending ? (
                <Spinner size={14} className="border-white/40 border-t-white" />
              ) : (
                <RestoreIcon size={14} />
              )}
              {t('history.restoreThis')}
            </button>
          </ConfirmPopover>
        </div>
      </div>
    </div>,
    document.body,
  )
}
