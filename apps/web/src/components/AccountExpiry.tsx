import { Link, useParams } from 'react-router'
import { useMe } from '../api'
import { useT } from '../i18n'

/**
 * "This account will be deleted on YYYY-MM-DD" (ACCOUNT_LIFETIME_DAYS, restricted mode,
 * docs/adr/2515-*), shown while the signed-in account has an expiry date (/auth/me `expiresAt`), with
 * a link to the export (workspace settings). Nothing without a date.
 *
 *   sidebar  always (under the workspace switcher).
 *   banner   on phones always (the sidebar is a drawer there); on wider screens only in the last
 *            three days, in the warning colour.
 */
export function AccountExpiry({ placement }: { placement: 'sidebar' | 'banner' }) {
  const t = useT()
  const me = useMe()
  const { wsId } = useParams()
  const at = me.data?.expiresAt
  if (!at) return null
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return null
  const date = localDate(when)
  const soon = when.getTime() - Date.now() <= 3 * 86_400_000
  const exportTo = wsId ? `/w/${wsId}/workspace-settings?tab=general` : '/'
  const text = t('accountLifecycle.expiresOn', { date })

  if (placement === 'sidebar') {
    return (
      <p
        data-testid="account-expiry"
        className={`mx-1 mt-1 rounded-md px-2 py-1 text-xs ${soon ? 'border border-amber-500/30 bg-amber-500/10 font-medium text-ink' : 'text-sub'}`}
      >
        {text}{' '}
        <Link to={exportTo} className="underline hover:text-ink">
          {t('accountLifecycle.export')}
        </Link>
      </p>
    )
  }
  return (
    <div
      role={soon ? 'alert' : 'status'}
      data-testid="account-expiry-banner"
      className={`${soon ? 'flex' : 'flex md:hidden'} shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs ${
        soon
          ? 'border-amber-500/30 bg-amber-500/10 font-medium text-ink'
          : 'border-line bg-app text-sub'
      }`}
    >
      <span className="min-w-0 flex-1">{text}</span>
      <Link to={exportTo} className="shrink-0 underline">
        {t('accountLifecycle.export')}
      </Link>
    </div>
  )
}

/** YYYY-MM-DD in the viewer's time zone. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
