import { useState } from 'react'
import { dismissLargeNotice, fmtSize, fmtTokens, isLargeNoticeDismissed, usePageSize } from '../largePagesApi'
import { useT } from '../i18n'
import { XIcon } from './Icons'

// One quiet line above a large document (docs/adr/1103-*): same thresholds as the agent hint
// (stored state ≥ 1 MiB in V1 bytes, or ≥ 50k indexed tokens). Dismissed per page on this device.
export function LargePageNotice({ pageId }: { pageId: string }) {
  const t = useT()
  const [dismissed, setDismissed] = useState(() => isLargeNoticeDismissed(pageId))
  const q = usePageSize(pageId, !dismissed)
  if (dismissed || !q.data?.large) return null
  const details = t('largePage.details', { size: fmtSize(q.data.stateBytes), tokens: fmtTokens(q.data.tokens) })
  return (
    <div
      role="note"
      data-testid="large-page-notice"
      className="mb-2 flex items-center gap-2 rounded-md border border-line bg-hover/60 px-2.5 py-1 text-xs text-sub"
    >
      <span className="min-w-0 flex-1" title={details}>
        {t('largePage.notice')}
      </span>
      <button
        type="button"
        onClick={() => {
          dismissLargeNotice(pageId)
          setDismissed(true)
        }}
        aria-label={t('largePage.dismiss')}
        title={t('largePage.dismiss')}
        className="shrink-0 rounded p-0.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <XIcon size={12} />
      </button>
    </div>
  )
}
