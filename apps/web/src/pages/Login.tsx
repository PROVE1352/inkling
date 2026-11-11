import { FeatureOn } from '../components/quota/FeatureOn'
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { loginSchema } from '@inkling/shared'
import { ApiError, useAuthMode, useLogin, useLoginTotp, useMe, useResendVerification } from '../api'
import { safeNext } from '../lib/nav'
import { Spinner } from '../components/Spinner'
import { LanguageSelect } from '../components/LanguageSelect'
import { InstanceBadge } from '../components/InstanceBadge'
import { InstanceNotice } from '../components/InstanceNotice'
import { LegalLinks } from '../components/legal/LegalLinks'
import { t as tr, tMaybe, useT } from '../i18n'

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

/**
 * Message for `/login?oidc_error=CODE` (docs/adr/1160-*): the server sends a fixed code, never the
 * provider's own text.
 */
export function oidcErrorText(code: string, name: string): string {
  return tMaybe(`oidc.error.${code}`) ?? tr('oidc.error.unknown', { name })
}

/** "Sign in with <name>": a plain link, the server redirects to the provider (a fetch could not follow it). */
function OidcButton({ name, next }: { name: string; next: string }) {
  const t = useT()
  const href = `/api/auth/oidc/start${next !== '/' ? `?returnTo=${encodeURIComponent(next)}` : ''}`
  return (
    <>
      <div className="flex items-center gap-3 text-[11px] text-sub" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        {t('login.or')}
        <span className="h-px flex-1 bg-line" />
      </div>
      <a
        href={href}
        data-testid="oidc-login"
        className="flex items-center justify-center rounded-md border border-line px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {t('login.oidc', { name })}
      </a>
    </>
  )
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
  // LOGIN_ID_MODE=username: the field is the sign-in ID (docs/adr/2512-*)
  const idMode = mode.data?.loginId === 'username'
  const delegatedName = delegatedDisplayName(mode.data?.delegatedName)
  const resend = useResendVerification()

  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const oidcName = mode.data?.oidc?.name ?? null
  const oidcError = params.get('oidc_error')
  const [serverError, setServerError] = useState<string | null>(
    oidcError ? oidcErrorText(oidcError, mode.data?.oidc?.name ?? 'SSO') : null,
  )
  // Unverified account while email verification is enforced — show the resend button
  const [needsVerify, setNeedsVerify] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)
  const notice = params.get('reset') === '1' ? t('login.passwordChanged') : null
  // Two-step verification (docs/adr/1061-*): the password was right, the server wants a code.
  const loginTotp = useLoginTotp()
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)

  // After an OpenID Connect sign-in into an account with Inkling's own 2FA, the server sends the
  // challenge in the fragment (#totp=…; never sent to a server or put in a Referer). Take it and drop it.
  useEffect(() => {
    const m = /^#totp=([A-Za-z0-9_-]{20,200})$/.exec(window.location.hash)
    if (!m) return
    setChallenge(m[1])
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])

  // Already signed in: go to next (e.g. an invite link) or home
  if (me.data) return <Navigate to={next} replace />

  const backToPassword = () => {
    setChallenge(null)
    setCode('')
    setUseRecovery(false)
    setPassword('')
  }

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault()
    setServerError(null)
    if (!challenge) return
    if (!code.trim()) return setServerError(t('login.totpRequired'))
    loginTotp.mutate(
      { challenge, code: code.trim() },
      {
        onSuccess: () => navigate(next, { replace: true }),
        onError: (err) => {
          setCode('')
          if (err instanceof ApiError && err.code === 'TOTP_CHALLENGE_EXPIRED') {
            backToPassword()
          }
          setServerError(err instanceof ApiError ? err.message : t('login.failed'))
        },
      },
    )
  }

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
          next.email = idMode
            ? t('accountLifecycle.loginIdRequired')
            : delegated
              ? t('login.emailOrIdRequired', { name: delegatedName })
              : t('auth.emailInvalid')
        if (field === 'password' && !next.password)
          next.password = t('auth.passwordRequired')
      }
      setErrors(next)
      return
    }

    login.mutate(parsed.data, {
      onSuccess: (r) => {
        if ('totpRequired' in r) {
          setChallenge(r.challenge)
          setCode('')
          return
        }
        navigate(next, { replace: true })
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
          setServerError(idMode ? t('accountLifecycle.invalidCredentials') : t('login.invalidCredentials'))
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
          <InstanceBadge placement="auth" />
          <InstanceNotice placement="auth" />
        </div>

        {challenge ? (
          <form
            onSubmit={submitCode}
            className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
            data-testid="totp-step"
          >
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('login.totpTitle')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-sub">
                {useRecovery ? t('login.totpRecoveryDesc') : t('login.totpDesc')}
              </p>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">
                {useRecovery ? t('twofa.recoveryTitle') : t('twofa.codeLabel')}
              </span>
              <input
                key={useRecovery ? 'recovery' : 'app'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                maxLength={useRecovery ? 11 : 6}
                placeholder={useRecovery ? 'XXXXX-XXXXX' : '123456'}
                className="rounded-md border border-line bg-app px-3 py-2 text-center font-mono text-base tracking-[0.3em] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            {serverError && <p className="text-xs text-red-600">{serverError}</p>}
            <button
              type="submit"
              disabled={loginTotp.isPending}
              className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {loginTotp.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
              {t('login.totpVerify')}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={backToPassword} className="text-sub hover:text-ink">
                ← {t('login.totpBack')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v)
                  setCode('')
                  setServerError(null)
                }}
                className="text-accent hover:underline"
              >
                {useRecovery ? t('login.totpUseApp') : t('login.totpUseRecovery')}
              </button>
            </div>
          </form>
        ) : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">
              {idMode ? t('accountLifecycle.loginId') : delegated ? t('auth.emailOrId', { name: delegatedName }) : t('common.email')}
            </span>
            <input
              type={delegated || idMode ? 'text' : 'email'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete={delegated || idMode ? 'username' : 'email'}
              {...(idMode ? { autoCapitalize: 'none', spellCheck: false } : {})}
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
          {oidcName && <OidcButton name={oidcName} next={next} />}
        </form>
        )}

        <FeatureOn name="password-reset"><p className="mt-4 text-center text-xs text-sub">
          <Link
            to={`/reset${email.includes('@') ? `?email=${encodeURIComponent(email.trim())}` : ''}`}
            className="text-accent hover:underline"
          >
            {t('login.forgot')}
          </Link>
        </p></FeatureOn>

        <p className="mt-2 text-center text-xs text-sub">
          {t('login.noAccount')}{' '}
          <Link
            to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="text-accent hover:underline"
          >
            {mode.data?.signupKeyRequired ? t('login.registerWithKey') : t('login.register')}
          </Link>
        </p>

        {params.get('deleted') === '1' && (
          <p className="mt-2 text-center text-xs text-sub" role="status">{t('accountLifecycle.deletedNotice')}</p>
        )}

        {mode.data?.setupPending && (
          <p className="mt-2 text-center text-xs text-sub">{t('setup.loginHint')}</p>
        )}

        {delegated && (
          <p className="mt-2 text-center text-xs text-sub">
            {t('login.delegatedHint', { name: delegatedName })}
          </p>
        )}

        <div className="mt-6 flex flex-col items-center gap-3">
          <LegalLinks />
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
