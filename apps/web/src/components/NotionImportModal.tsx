import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, useImportNotion, type NotionImportReportDTO } from '../api'
import { t, useT } from '../i18n'
import { UploadIcon } from './Icons'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

/**
 * Notion "Markdown & CSV" export import (docs/adr/0960-*): a short how-to, the upload, and the
 * server's report (counts, links that could not be resolved, skipped files).
 */
export function NotionImportModal({
  open,
  onClose,
  wsId,
}: {
  open: boolean
  onClose: () => void
  wsId: string
}) {
  useT()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const mutation = useImportNotion(wsId)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ firstId: string | null; report: NotionImportReportDTO } | null>(null)

  const close = () => {
    if (mutation.isPending) return
    setError(null)
    setResult(null)
    onClose()
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setResult(null)
    mutation.mutate(
      { file },
      {
        onSuccess: ({ pages, report }) => {
          const top = pages.find((p) => !p.parentId) ?? pages[0]
          setResult({ firstId: top?.id ?? null, report })
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : t('notionImport.failed')),
      },
    )
  }

  const r = result?.report
  return (
    <Modal open={open} onClose={close} title={t('notionImport.title')}>
      {!r && (
        <div className="space-y-3 text-sm text-sub">
          <p>{t('notionImport.hint')}</p>
          <p className="text-xs">{t('notionImport.limits')}</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={mutation.isPending}
            className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {mutation.isPending ? <Spinner size={15} /> : <UploadIcon size={15} />}
            {mutation.isPending ? t('notionImport.importing') : t('notionImport.choose')}
          </button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
      {r && (
        <div className="space-y-3 text-sm">
          <p className="font-medium text-ink">{t('notionImport.done')}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sub">
            <dt>{t('notionImport.documents')}</dt>
            <dd className="text-right text-ink">{r.documents}</dd>
            <dt>{t('notionImport.collections')}</dt>
            <dd className="text-right text-ink">{r.collections}</dd>
            <dt>{t('notionImport.rows')}</dt>
            <dd className="text-right text-ink">{r.rows}</dd>
            {r.folders > 0 && (
              <>
                <dt>{t('notionImport.folders')}</dt>
                <dd className="text-right text-ink">{r.folders}</dd>
              </>
            )}
            <dt>{t('notionImport.attachments')}</dt>
            <dd className="text-right text-ink">{r.attachments}</dd>
            <dt>{t('notionImport.links')}</dt>
            <dd className="text-right text-ink">
              {t('notionImport.linksValue', { resolved: r.links.resolved, total: r.links.total })}
            </dd>
          </dl>
          {r.renamed > 0 && <p className="text-xs text-sub">{t('notionImport.renamed', { count: r.renamed })}</p>}
          {r.merged && r.merged.pages + r.merged.attachments > 0 && (
            <p className="text-xs text-sub">{t('notionImport.merged', { count: r.merged.pages + r.merged.attachments })}</p>
          )}
          <ReportList
            title={t('notionImport.broken', { count: r.brokenLinkCount })}
            items={r.brokenLinks.map((b) => `${b.page}: ${b.href}`)}
            total={r.brokenLinkCount}
          />
          <ReportList
            title={t('notionImport.skipped', { count: r.skippedCount })}
            items={r.skipped.map((s) => `${s.path} — ${s.reason}`)}
            total={r.skippedCount}
          />
          {result?.firstId && (
            <button
              type="button"
              onClick={() => {
                const id = result.firstId
                close()
                navigate(`/w/${wsId}/p/${id}`)
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              {t('notionImport.open')}
            </button>
          )}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onPick} />
    </Modal>
  )
}

function ReportList({ title, items, total }: { title: string; items: string[]; total: number }) {
  if (total === 0) return null
  return (
    <details className="text-xs text-sub">
      <summary className="cursor-pointer text-ink">{title}</summary>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto break-all">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {total > items.length && <li>{t('notionImport.more', { count: total - items.length })}</li>}
      </ul>
    </details>
  )
}
