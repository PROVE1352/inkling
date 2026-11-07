import { usePageProvenance } from '../notificationsApi'
import { relativeTime, formatDateTime } from '../lib/time'
import { useT } from '../i18n'

// "Written by AI (via X) · Last AI edit 2 hours ago (via Y)" under a doc page's title
// (docs/adr/1005-*). Renders nothing when a person wrote the page and no agent edited it.
export function PageProvenanceBadge({ pageId }: { pageId: string }) {
  const t = useT()
  const prov = usePageProvenance(pageId)
  const p = prov.data
  if (!p || (!p.createdVia && !p.lastAgentEdit)) return null
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sub"
      data-testid="page-provenance"
    >
      {p.createdVia && (
        <span className="rounded border border-line px-1.5 py-px">
          {t('provenance.writtenByAi', { client: p.createdVia })}
        </span>
      )}
      {p.lastAgentEdit && (
        <span
          className="rounded border border-line px-1.5 py-px"
          title={[p.lastAgentEdit.actorName, formatDateTime(p.lastAgentEdit.at)].filter(Boolean).join(' · ')}
        >
          {t('provenance.lastAiEdit', {
            when: relativeTime(p.lastAgentEdit.at),
            client: p.lastAgentEdit.via,
          })}
        </span>
      )}
    </div>
  )
}
