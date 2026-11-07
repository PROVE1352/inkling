import { useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError, useMe, useVerifyEmail } from '../api'
import { Spinner } from '../components/Spinner'
import { useT } from '../i18n'

// /verify?token= — the link in the verification email. Sends the confirm request once on open.
export function VerifyEmail() {
  const t = useT()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const verify = useVerifyEmail()
  const me = useMe()
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current || !token) return
    sent.current = true
    verify.mutate(token)
  }, [token, verify])

  const failed = !token || verify.isError
  const message = !token
    ? t('verify.noToken')
    : verify.error instanceof ApiError
      ? verify.error.message
      : t('verify.failed')

  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-line bg-app p-6 text-center">
        <img src="/icon.svg" alt="Inkling" className="mx-auto mb-3 h-12 w-12" />
        {verify.isSuccess ? (
          <>
            <h1 className="mb-2 text-base font-semibold text-ink">{t('verify.doneTitle')}</h1>
            <p className="text-sm text-sub">{t('verify.done', { email: verify.data.email })}</p>
          </>
        ) : failed ? (
          <>
            <h1 className="mb-2 text-base font-semibold text-ink">{t('verify.failedTitle')}</h1>
            <p className="text-sm text-sub">{message}</p>
            <p className="mt-2 text-xs text-sub">
              {t('verify.resendHint')}
            </p>
          </>
        ) : (
          <div className="flex justify-center py-4">
            <Spinner size={20} />
          </div>
        )}
        <Link
          to={me.data ? '/' : '/login'}
          className="mt-4 inline-block text-xs text-accent hover:underline"
        >
          {me.data ? t('verify.toHome') : t('auth.toLogin')}
        </Link>
      </div>
    </div>
  )
}
