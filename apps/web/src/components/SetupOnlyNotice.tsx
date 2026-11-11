import { Link } from 'react-router'
import type { AuthModeDTO } from '@inkling/shared'
import { useT } from '../i18n'
import { LanguageSelect } from './LanguageSelect'
import { InstanceBadge } from './InstanceBadge'
import { InstanceNotice } from './InstanceNotice'

/**
 * "Restricted sign-up" as the server decides it (contract §13): an account cap, a per-address cap, an
 * account lifetime or sign-in IDs. Read from fields /auth/mode already sends for those settings
 * (`signupChecks` is there exactly when one of the two caps is), so no field was added for it.
 */
export function restrictedSignup(mode: Pick<AuthModeDTO, 'loginId' | 'signupChecks' | 'accountLifetimeDays'>): boolean {
  return mode.loginId === 'username' || mode.signupChecks === true || mode.accountLifetimeDays !== undefined
}

/**
 * The sign-up screen of a restricted server whose operator account does not exist yet
 * (docs/adr/2527-*): every sign-up but the setup code's is refused (SETUP_REQUIRED), so instead of the
 * form it says where the setup link is. /setup?code=… still shows the form.
 */
export function SetupOnlyNotice({ next }: { next: string }) {
  const t = useT()
  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm" data-testid="setup-only">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
          <InstanceBadge placement="auth" />
          <InstanceNotice placement="auth" />
        </div>
        <div className="rounded-lg border border-line bg-app p-6 text-center">
          <h2 className="mb-2 text-base font-semibold text-ink">{t('setup.restrictedTitle')}</h2>
          <p className="break-keep text-sm text-sub [overflow-wrap:anywhere]">{t('setup.restrictedBody')}</p>
          <Link
            to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="mt-4 inline-block text-xs text-accent hover:underline"
          >
            {t('auth.toLogin')}
          </Link>
        </div>
        <div className="mt-6 flex justify-center">
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
