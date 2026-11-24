import { Link, useParams } from 'react-router'
import { useMe } from '../api'
import { useT } from '../i18n'
import { hoursLeft } from '../lib/trial'

/**
 * "Trial account · deleted in N h" in the sidebar head (TRIAL_ACCOUNTS, docs/adr/2555-*), shown while
 * the signed-in account is a trial one (/auth/me `trial`). Opening it says what is off and how to keep
 * the pages (the export in workspace settings). Plain text like the account expiry line beside it.
 */
export function TrialBadge() {
  const t = useT()
  const me = useMe()
  const { wsId } = useParams()
  const at = me.data?.trial?.expiresAt
  if (!at) return null
  const n = hoursLeft(at, Date.now())
  if (n === null) return null
  const exportTo = wsId ? `/w/${wsId}/workspace-settings?tab=general` : '/'
  return (
    <details className="group mx-1 mt-1 px-2 py-1 text-xs text-sub" data-testid="trial-badge">
      <summary className="cursor-pointer list-none truncate hover:text-ink [&::-webkit-details-marker]:hidden">
        {t('trial.badge', { n })}
      </summary>
      <div className="mt-1 flex flex-col gap-1 leading-relaxed">
        <p className="break-keep">{t('trial.about', { n })}</p>
        <p className="break-keep">
          {t('trial.keep')}{' '}
          <Link to={exportTo} className="whitespace-nowrap underline hover:text-ink">
            {t('trial.export')}
          </Link>
        </p>
      </div>
    </details>
  )
}
