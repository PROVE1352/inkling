import { useEffect, useState } from 'react'
import { SHEETS_SYNC_DEFAULT_INTERVAL, SHEETS_SYNC_MIN_INTERVAL } from '@inkling/shared'
import {
  useDeleteSheetSync,
  useRunSheetSync,
  useSaveSheetSync,
  useSheetSync,
} from '../../lib/collectionApi'
import { fmtDateTime } from '../../i18n'
import { Modal } from '../Modal'
import { S } from './strings'

const INPUT =
  'w-full rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent'

/** Google Sheets read sync settings — only rendered when the `sheets-sync` flag is enabled. */
export function SheetSyncModal({
  open,
  onClose,
  pageId,
}: {
  open: boolean
  onClose: () => void
  pageId: string
}) {
  const sync = useSheetSync(pageId, open)
  const save = useSaveSheetSync(pageId)
  const remove = useDeleteSheetSync(pageId)
  const run = useRunSheetSync(pageId)
  const [url, setUrl] = useState('')
  const [keyColumn, setKeyColumn] = useState('')
  const [titleColumn, setTitleColumn] = useState('')
  const [interval, setIntervalMin] = useState(SHEETS_SYNC_DEFAULT_INTERVAL)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const s = sync.data
    if (!open || !s) return
    setUrl(s.url)
    setKeyColumn(s.keyColumn)
    setTitleColumn(s.titleColumn ?? '')
    setIntervalMin(s.intervalMinutes)
    setEnabled(s.enabled)
  }, [open, sync.data])

  const err = (save.error ?? run.error ?? remove.error) as Error | null
  const s = sync.data

  return (
    <Modal open={open} onClose={onClose} title={S.syncTitle}>
      <div className="flex flex-col gap-2.5 text-xs text-sub">
        <p className="leading-relaxed">{S.syncHelp}</p>
        <label className="flex flex-col gap-1">
          {S.syncUrl}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          {S.syncKey}
          <input value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1">
          {S.syncTitleCol}
          <input value={titleColumn} onChange={(e) => setTitleColumn(e.target.value)} className={INPUT} />
        </label>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            {S.syncInterval}
            <input
              type="number"
              min={SHEETS_SYNC_MIN_INTERVAL}
              max={1440}
              value={interval}
              onChange={(e) => setIntervalMin(Math.max(SHEETS_SYNC_MIN_INTERVAL, Number(e.target.value) || SHEETS_SYNC_MIN_INTERVAL))}
              className="w-20 rounded border border-line bg-app px-2 py-1 text-sm text-ink"
            />
          </label>
          <label className="flex items-center gap-1.5 text-ink">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {S.syncEnabled}
          </label>
        </div>
        {s && (
          <p>
            {S.syncLast}: {s.lastSyncedAt ? fmtDateTime(s.lastSyncedAt) : S.syncNever}
            {s.lastStatus === 'ok' && s.lastStats
              ? ` — ${S.syncStats(s.lastStats.inserted, s.lastStats.updated, s.lastStats.unchanged)}`
              : ''}
            {s.lastStatus === 'error' && s.lastError ? (
              <span className="block text-red-600">{s.lastError}</span>
            ) : null}
          </p>
        )}
        {err && <p className="text-red-600">{err.message}</p>}
        <div className="mt-1 flex items-center justify-end gap-2">
          {s && (
            <>
              <button
                type="button"
                onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
                className="mr-auto rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-hover"
              >
                {S.syncRemove}
              </button>
              <button
                type="button"
                onClick={() => run.mutate()}
                disabled={run.isPending}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-60"
              >
                {S.syncNow}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={save.isPending || !url.trim() || !keyColumn.trim()}
            onClick={() =>
              save.mutate({
                url: url.trim(),
                keyColumn: keyColumn.trim(),
                titleColumn: titleColumn.trim() || undefined,
                intervalMinutes: interval,
                enabled,
              })
            }
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-60"
          >
            {S.save}
          </button>
        </div>
      </div>
    </Modal>
  )
}
