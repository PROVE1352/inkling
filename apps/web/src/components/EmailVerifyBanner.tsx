import { useState } from 'react'
import { ApiError, useAuthMode, useMe, useResendVerification } from '../api'
import { XIcon } from './Icons'
import { useT } from '../i18n'

// Unverified-email warning banner — only for a local account not yet verified, on a server with mail on.
// (In the default mode with REQUIRE_EMAIL_VERIFICATION off, sign-in works and only this banner shows.)
export function EmailVerifyBanner() {
  const t = useT()
  const me = useMe()
  const mode = useAuthMode()
  const resend = useResendVerification()
  const [hidden, setHidden] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  if (hidden || !mode.data?.mailEnabled) return null
  if (!me.data || me.data.origin !== 'local' || me.data.emailVerified !== false) return null

  const send = () => {
    setMsg(null)
    resend.mutate(undefined, {
      onSuccess: (r) =>
        setMsg(
          r.alreadyVerified
            ? t('emailVerify.already')
            : t('emailVerify.sent', { email: me.data?.email ?? '' }),
        ),
      onError: (err) => setMsg(err instanceof ApiError ? err.message : t('auth.mailFailed')),
    })
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-ink">
      <span>{t('emailVerify.message')}</span>
      <button
        type="button"
        onClick={send}
        disabled={resend.isPending}
        className="rounded-md px-2 py-0.5 text-accent transition-colors duration-150 hover:bg-hover disabled:opacity-50"
      >
        {t('login.resendVerify')}
      </button>
      {msg && <span className="text-sub">{msg}</span>}
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label={t('emailVerify.dismiss')}
        className="ml-auto rounded-md p-0.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <XIcon size={14} />
      </button>
    </div>
  )
}
