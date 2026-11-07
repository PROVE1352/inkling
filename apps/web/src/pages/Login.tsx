import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { loginSchema } from '@inkling/shared'
import { ApiError, useAuthMode, useLogin, useMe, useResendVerification } from '../api'
import { safeNext } from '../lib/nav'
import { Spinner } from '../components/Spinner'
import { LanguageSelect } from '../components/LanguageSelect'
import { t as tr, useT } from '../i18n'

/**
 * Display name of the delegated (external) sign-in service from /auth/mode. The server default is
 * 'External account' (older servers sent '외부 계정'); both, and an empty value, are shown in the
 * UI language. Anything else is the operator's configured name and is shown as-is.
 */
export function delegatedDisplayName(raw: string | null | undefined): string {
  const name = raw?.trim()
  if (!name || name === 'External account' || name === '외부 계정') return tr('auth.externalAccount')
  return name
}

export function Login() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const me = useMe()
  const login = useLogin()
  const mode = useAuthMode()
  // In delegated mode one field accepts either an Inkling email or an external account username.
  // The server checks Inkling's own accounts first and delegates to the external auth server only if none match.
  const delegated = mode.data?.delegated ?? false
  const delegatedName = delegatedDisplayName(mode.data?.delegatedName)
  const resend = useResendVerification()

  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [serverError, setServerError] = useState<string | null>(null)
  // Unverified account while email verification is enforced — show the resend button
  const [needsVerify, setNeedsVerify] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)
  const notice = params.get('reset') === '1' ? t('login.passwordChanged') : null

  // Already signed in: go to next (e.g. an invite link) or home
  if (me.data) return <Navigate to={next} replace />

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setServerError(null)
    setNeedsVerify(false)
    setVerifyMsg(null)

    const parsed = loginSchema.safeParse({ email, password })
    if (!parsed.success) {
      const next: { email?: string; password?: string } = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'email' && !next.email)
          next.email = delegated
            ? t('login.emailOrIdRequired', { name: delegatedName })
            : t('auth.emailInvalid')
        if (field === 'password' && !next.password)
          next.password = t('auth.passwordRequired')
      }
      setErrors(next)
      return
    }

    login.mutate(parsed.data, {
      onSuccess: () => navigate(next, { replace: true }),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
          setServerError(t('login.invalidCredentials'))
        } else if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
          setServerError(err.message)
          setNeedsVerify(true)
        } else {
          setServerError(err instanceof ApiError ? err.message : t('login.failed'))
        }
      },
    })
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">
              {delegated ? t('auth.emailOrId', { name: delegatedName }) : t('common.email')}
            </span>
            <input
              type={delegated ? 'text' : 'email'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete={delegated ? 'username' : 'email'}
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.email && <span className="text-xs text-red-600">{errors.email}</span>}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('common.password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.password && (
              <span className="text-xs text-red-600">{errors.password}</span>
            )}
          </label>

          {notice && !serverError && <p className="text-xs text-emerald-600">{notice}</p>}
          {serverError && <p className="text-xs text-red-600">{serverError}</p>}
          {needsVerify && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                disabled={resend.isPending}
                onClick={() =>
                  resend.mutate(
                    { email: email.trim(), password },
                    {
                      onSuccess: (r) =>
                        setVerifyMsg(
                          r.alreadyVerified
                            ? t('login.alreadyVerified')
                            : t('login.verifyResent'),
                        ),
                      onError: (err) =>
                        setVerifyMsg(err instanceof ApiError ? err.message : t('auth.mailFailed')),
                    },
                  )
                }
                className="rounded-md border border-line px-2 py-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                {t('login.resendVerify')}
              </button>
              {verifyMsg && <span className="text-sub">{verifyMsg}</span>}
            </div>
          )}

          <button
            type="submit"
            disabled={login.isPending}
            className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {login.isPending && (
              <Spinner size={16} className="border-white/40 border-t-white" />
            )}
            {t('auth.signIn')}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-sub">
          <Link
            to={`/reset${email.includes('@') ? `?email=${encodeURIComponent(email.trim())}` : ''}`}
            className="text-accent hover:underline"
          >
            {t('login.forgot')}
          </Link>
        </p>

        <p className="mt-2 text-center text-xs text-sub">
          {t('login.noAccount')}{' '}
          <Link
            to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="text-accent hover:underline"
          >
            {mode.data?.signupKeyRequired ? t('login.registerWithKey') : t('login.register')}
          </Link>
        </p>

        {delegated && (
          <p className="mt-2 text-center text-xs text-sub">
            {t('login.delegatedHint', { name: delegatedName })}
          </p>
        )}

        <div className="mt-6 flex justify-center">
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
