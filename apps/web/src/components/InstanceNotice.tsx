import { useAuthMode } from '../api'
import { useT } from '../i18n'

/**
 * The operator's notice (INSTANCE_NOTICE, 0.22 integration, docs/adr/2526-*): changes, outages and
 * incidents on a server that sends no mail. Shown wherever the instance label is (InstanceBadge's
 * placement rule): under the title of the sign-in, sign-up and consent screens, and as a strip above
 * every app screen, on every width (a notice must not hide with the sidebar). It cannot be closed.
 *
 * Drawn as text only: React escapes it, line breaks are kept with `white-space: pre-line`, and an
 * address in it stays plain text (no link is made). Long words wrap anywhere, so a 390 px screen never
 * scrolls sideways; the strip keeps at most a few lines and scrolls inside itself.
 */
export function InstanceNotice({ placement }: { placement: 'banner' | 'auth' }) {
  const t = useT()
  const notice = useAuthMode().data?.instanceNotice
  if (!notice) return null
  if (placement === 'banner') {
    return (
      <div
        role="note"
        aria-label={t('legal.instanceNotice')}
        data-instance-notice="banner"
        className="max-h-24 shrink-0 overflow-y-auto whitespace-pre-line border-b border-line bg-accent-soft px-3 py-1.5 text-xs leading-relaxed text-ink [overflow-wrap:anywhere]"
      >
        {notice}
      </div>
    )
  }
  return (
    <p
      role="note"
      aria-label={t('legal.instanceNotice')}
      data-instance-notice="auth"
      className="w-full whitespace-pre-line rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-left text-xs leading-relaxed text-ink [overflow-wrap:anywhere]"
    >
      {notice}
    </p>
  )
}
