import { useEffect, useRef, useState } from 'react'
import { DownloadIcon, CopyIcon, MoreHorizontalIcon, RefreshIcon, TemplateIcon, UploadIcon } from '../Icons'
import { useT } from '../../i18n'
import { S } from './strings'

/** Collection toolbar "⋯" menu: row templates / import / export / copy / sheets sync (experimental). */
export function CollectionMenu({
  onRowTemplates,
  onImport,
  onExportCsv,
  onExportXlsx,
  onCopyTsv,
  onSheetSync,
}: {
  /** row templates (docs/adr/1180-*) */
  onRowTemplates?: () => void
  /** omitted when the collection is read-only (edit lock) */
  onImport?: () => void
  onExportCsv: () => void
  onExportXlsx: () => void
  onCopyTsv: () => void
  /** shown only when the experimental `sheets-sync` flag is enabled */
  onSheetSync?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover'
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div ref={ref} className="relative" data-print-hide>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={S.more}
        title={S.more}
        className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
      >
        <MoreHorizontalIcon size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
          {onRowTemplates && (
            <button type="button" className={`${item} border-b border-line`} onClick={run(onRowTemplates)}>
              <TemplateIcon size={14} /> {t('rowTpl.manage')}
            </button>
          )}
          {onImport && (
            <button type="button" className={item} onClick={run(onImport)}>
              <UploadIcon size={14} /> {S.importFile}
            </button>
          )}
          <button type="button" className={item} onClick={run(onExportCsv)}>
            <DownloadIcon size={14} /> {S.exportCsv}
          </button>
          <button type="button" className={item} onClick={run(onExportXlsx)}>
            <DownloadIcon size={14} /> {S.exportXlsx}
          </button>
          <button type="button" className={item} onClick={run(onCopyTsv)}>
            <CopyIcon size={14} /> {S.copyTsv}
          </button>
          {onSheetSync && (
            <button type="button" className={`${item} border-t border-line`} onClick={run(onSheetSync)}>
              <RefreshIcon size={14} /> {S.sheetSync}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
