import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { registerSchema } from '@inkling/shared'
import { ApiError, useAuthMode, useMe, useRegister } from '../api'
import { safeNext } from '../lib/nav'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { LanguageSelect } from '../components/LanguageSelect'
import { InstanceBadge } from '../components/InstanceBadge'
import { LegalLinks } from '../components/legal/LegalLinks'
import { SignupConsent, type SignupConsentState } from '../components/legal/SignupConsent'
import { BotCheckField, SignupFullNotice, signupBody, useSignupShownAt } from '../components/account/SignupExtras'
import { useT } from '../i18n'

export function Register() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const me = useMe()
  const register = useRegister()
  const mode = useAuthMode()
  // First-admin setup (/setup?code=…, docs/adr/2160-*): the code from the server log replaces the
  // signup key for the server's first account, which becomes its admin.
  const setupMode = useLocation().pathname === '/setup'
  const [setupCode, setSetupCode] = useState(params.get('code') ?? '')

  const [email, setEmail] = useState('')
  // LOGIN_ID_MODE=username: a sign-in ID instead of the email (docs/adr/2512-*)
  const [loginId, setLoginId] = useState('')
  const [website, setWebsite] = useState('')
  const shownAt = useSignupShownAt()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  // Coming from an invite email / signup link (/register?key=) pre-fills the key
  const [signupKey, setSignupKey] = useState(params.get('key') ?? '')
  const [sentTo, setSentTo] = useState<{ email: string; mailSent: boolean } | null>(null)
  const [errors, setErrors] = useState<{
    email?: string
    loginId?: string
    name?: string
    password?: string
    signupKey?: string
  }>({})
  const [serverError, setServerError] = useState<string | null>(null)
  // Sign-up consent (restricted mode, LEGAL_DIR): ready unless the block asks for ticks.
  const [consent, setConsent] = useState<SignupConsentState>({ ready: true, consents: [] })

  if (me.data) return <Navigate to={next} replace />

  // Sign-up only creates Inkling's own accounts — unrelated to external accounts used for delegated sign-in.
  if (mode.isLoading) return <FullScreenSpinner />
  const keyRequired = !setupMode && (mode.data?.signupKeyRequired ?? false)
  const idMode = mode.data?.loginId === 'username'
  // SIGNUP_MAX_USERS reached: a notice instead of the form (the setup link still works)
  if (mode.data?.signupFull && !setupMode) return <SignupFullNotice next={next} />

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setServerError(null)

    if (keyRequired && !signupKey.trim()) {
      setErrors({ signupKey: t('register.signupKeyRequired') })
      return
    }
    if (setupMode && !setupCode.trim()) {
      setErrors({ signupKey: t('setup.codeRequired') })
      return
    }

    if (!consent.ready) return

    const parsed = (idMode ? registerSchema.omit({ email: true }) : registerSchema).safeParse({
      ...(idMode ? { loginId: loginId.trim() } : { email }),
      name,
      password,
      ...(setupMode
        ? { setupCode: setupCode.trim() || undefined }
        : { signupKey: signupKey.trim() || undefined }),
      // only when the consent block asked for them, so the body is unchanged otherwise
      ...(consent.legalVersion || consent.consents.length > 0 ? { consents: consent.consents } : {}),
      ...(consent.legalVersion ? { legalVersion: consent.legalVersion } : {}),
    })
    if (!parsed.success) {
      const next: {
        email?: string
        loginId?: string
        name?: string
        password?: string
        signupKey?: string
      } = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'email' && !next.email) next.email = t('auth.emailInvalid')
        if (field === 'loginId' && !next.loginId) next.loginId = t('errors.LOGIN_ID_INVALID')
        if (field === 'name' && !next.name) next.name = t('register.nameInvalid')
        if (field === 'password' && !next.password)
          next.password = t('auth.passwordTooShort')
        if ((field === 'signupKey' || field === 'setupCode') && !next.signupKey)
          next.signupKey = setupMode ? t('setup.invalidCode') : t('register.checkSignupKey')
      }
      setErrors(next)
      return
    }

    register.mutate(signupBody(parsed.data, { checks: !!mode.data?.signupChecks, shownAt, website }), {
      onSuccess: (r) => {
        // Email verification enforced — no session; show the "check your inbox" screen
        if (r.verificationRequired) setSentTo({ email: r.user.email, mailSent: r.mailSent !== false })
        else navigate(next, { replace: true })
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
          setServerError(t('register.emailTaken'))
        } else if (err instanceof ApiError && (err.code === 'LOGIN_ID_INVALID' || err.code === 'LOGIN_ID_TAKEN')) {
          setErrors({ loginId: err.message })
        } else if (
          err instanceof ApiError &&
          (err.code === 'INVALID_SIGNUP_KEY' || err.code === 'SIGNUP_KEY_REQUIRED')
        ) {
          setErrors({ signupKey: t('register.invalidKey') })
        } else if (err instanceof ApiError && err.code === 'INVALID_SETUP_CODE') {
          setErrors({ signupKey: t('setup.invalidCode') })
        } else if (err instanceof ApiError && err.code === 'SETUP_CLOSED') {
          setServerError(t('setup.closed'))
        } else if (err instanceof ApiError && err.code === 'EMAIL_RESERVED') {
          setErrors({ email: t('register.emailReserved') })
        } else {
          setServerError(err instanceof ApiError ? err.message : t('register.failed'))
        }
      },
    })
  }

  if (sentTo) {
    return (
      <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
        <div className="w-full max-w-sm rounded-lg border border-line bg-app p-6 text-center">
          <img src="/icon.svg" alt="Inkling" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="mb-2 text-base font-semibold text-ink">{t('register.checkInbox')}</h1>
          <p className="text-sm text-sub">
            {sentTo.mailSent
              ? t('register.mailSent', { email: sentTo.email })
              : t('register.mailNotSent')}
          </p>
          <Link
            to={`/login?email=${encodeURIComponent(sentTo.email)}`}
            className="mt-4 inline-block text-xs text-accent hover:underline"
          >
            {t('auth.toLogin')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">Inkling</h1>
          <InstanceBadge placement="auth" />
          {setupMode && (
            <>
              <h2 className="text-sm font-semibold text-ink">{t('setup.title')}</h2>
              <p className="text-center text-xs text-sub">{t('setup.hint')}</p>
            </>
          )}
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
          {idMode ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('accountLifecycle.loginId')}</span>
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {errors.loginId ? (
                <span className="text-xs text-red-600">{errors.loginId}</span>
              ) : (
                <span className="text-xs text-sub">{t('accountLifecycle.loginIdHint')}</span>
              )}
            </label>
          ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('common.email')}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.email && <span className="text-xs text-red-600">{errors.email}</span>}
          </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{idMode ? t('accountLifecycle.nickname') : t('common.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete={idMode ? 'nickname' : 'name'}
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.name && <span className="text-xs text-red-600">{errors.name}</span>}
          </label>
          {idMode && <p className="text-xs leading-relaxed text-sub">{t('accountLifecycle.noRealNames')}</p>}

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('common.password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.password && (
              <span className="text-xs text-red-600">{errors.password}</span>
            )}
          </label>

          {keyRequired && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('register.signupKey')}</span>
              <input
                type="text"
                value={signupKey}
                onChange={(e) => setSignupKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="rounded-md border border-line bg-app px-3 py-2 font-mono text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {errors.signupKey ? (
                <span className="text-xs text-red-600">{errors.signupKey}</span>
              ) : (
                <span className="text-xs text-sub">{t('register.signupKeyHint')}</span>
              )}
            </label>
          )}

          {setupMode && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('setup.code')}</span>
              <input
                type="text"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="rounded-md border border-line bg-app px-3 py-2 font-mono text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {errors.signupKey ? (
                <span className="text-xs text-red-600">{errors.signupKey}</span>
              ) : (
                <span className="text-xs text-sub">{t('setup.codeHint')}</span>
              )}
            </label>
          )}

          {mode.data?.signupChecks && <BotCheckField value={website} onChange={setWebsite} />}
          <SignupConsent onChange={setConsent} />

          {serverError && <p className="text-xs text-red-600">{serverError}</p>}

          <button
            type="submit"
            disabled={register.isPending || !consent.ready}
            className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {register.isPending && (
              <Spinner size={16} className="border-white/40 border-t-white" />
            )}
            {setupMode ? t('setup.submit') : t('register.submit')}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-sub">
          {t('register.haveAccount')}{' '}
          <Link
            to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="text-accent hover:underline"
          >
            {t('auth.signIn')}
          </Link>
        </p>

        <div className="mt-6 flex flex-col items-center gap-3">
          <LegalLinks />
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
