import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router'
import { usePurgePage, useRestorePage, useTrash } from '../api'
import { PageIconGlyph } from './PageIconGlyph'
import { relativeTime } from '../lib/time'
import { ConfirmPopover } from './ConfirmPopover'
import { RestoreIcon, TrashIcon, XIcon } from './Icons'
import { Spinner } from './Spinner'
import { useT } from '../i18n'

export function TrashModal({
  open,
  onClose,
  wsId,
}: {
  open: boolean
  onClose: () => void
  wsId: string
}) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const trash = useTrash(wsId, open)
  const restore = useRestorePage(wsId)
  const purge = usePurgePage(wsId)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const currentPageId = location.pathname.match(/\/p\/([^/]+)/)?.[1]

  const doPurge = (id: string) => {
    setConfirmId(null)
    purge.mutate(id, {
      onSuccess: () => {
        if (currentPageId === id) navigate(`/w/${wsId}`)
      },
    })
  }

  if (!open) return null

  const items = trash.data ?? []

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="nd-dialog flex max-h-[75dvh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-app shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <TrashIcon size={17} /> {t('trash.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {trash.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-sub">
              {t('trash.empty')}
            </p>
          ) : (
            items.map((page) => (
              <div
                key={page.id}
                className="group flex items-center gap-2 px-3 py-2 text-sm hover:bg-hover"
              >
                <span className="shrink-0 text-[15px] leading-none">
                  <PageIconGlyph page={page} size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">{page.title || t('common.untitled')}</div>
                  <div className="text-xs text-sub">
                    {t('trash.deletedAt', { when: relativeTime(page.deletedAt ?? page.updatedAt) })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => restore.mutate(page.id)}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-active hover:text-ink"
                  title={t('common.restore')}
                >
                  <RestoreIcon size={14} /> {t('common.restore')}
                </button>
                <ConfirmPopover
                  open={confirmId === page.id}
                  onCancel={() => setConfirmId(null)}
                  onConfirm={() => doPurge(page.id)}
                  message={t('trash.purgeConfirm')}
                  confirmLabel={t('trash.purge')}
                >
                  <button
                    type="button"
                    onClick={() => setConfirmId(page.id)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 transition-colors duration-150 hover:bg-hover"
                    title={t('trash.purge')}
                  >
                    <TrashIcon size={14} /> {t('trash.purge')}
                  </button>
                </ConfirmPopover>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
