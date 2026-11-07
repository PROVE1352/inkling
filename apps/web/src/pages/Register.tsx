import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { registerSchema } from '@inkling/shared'
import { ApiError, useAuthMode, useMe, useRegister } from '../api'
import { safeNext } from '../lib/nav'
import { FullScreenSpinner, Spinner } from '../components/Spinner'
import { LanguageSelect } from '../components/LanguageSelect'
import { useT } from '../i18n'

export function Register() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const me = useMe()
  const register = useRegister()
  const mode = useAuthMode()

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  // Coming from an invite email / signup link (/register?key=) pre-fills the key
  const [signupKey, setSignupKey] = useState(params.get('key') ?? '')
  const [sentTo, setSentTo] = useState<{ email: string; mailSent: boolean } | null>(null)
  const [errors, setErrors] = useState<{
    email?: string
    name?: string
    password?: string
    signupKey?: string
  }>({})
  const [serverError, setServerError] = useState<string | null>(null)

  if (me.data) return <Navigate to={next} replace />

  // Sign-up only creates Inkling's own accounts — unrelated to external accounts used for delegated sign-in.
  if (mode.isLoading) return <FullScreenSpinner />
  const keyRequired = mode.data?.signupKeyRequired ?? false

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setServerError(null)

    if (keyRequired && !signupKey.trim()) {
      setErrors({ signupKey: t('register.signupKeyRequired') })
      return
    }

    const parsed = registerSchema.safeParse({
      email,
      name,
      password,
      signupKey: signupKey.trim() || undefined,
    })
    if (!parsed.success) {
      const next: {
        email?: string
        name?: string
        password?: string
        signupKey?: string
      } = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (field === 'email' && !next.email) next.email = t('auth.emailInvalid')
        if (field === 'name' && !next.name) next.name = t('register.nameInvalid')
        if (field === 'password' && !next.password)
          next.password = t('auth.passwordTooShort')
        if (field === 'signupKey' && !next.signupKey)
          next.signupKey = t('register.checkSignupKey')
      }
      setErrors(next)
      return
    }

    register.mutate(parsed.data, {
      onSuccess: (r) => {
        // Email verification enforced — no session; show the "check your inbox" screen
        if (r.verificationRequired) setSentTo({ email: r.user.email, mailSent: r.mailSent !== false })
        else navigate(next, { replace: true })
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
          setServerError(t('register.emailTaken'))
        } else if (
          err instanceof ApiError &&
          (err.code === 'INVALID_SIGNUP_KEY' || err.code === 'SIGNUP_KEY_REQUIRED')
        ) {
          setErrors({ signupKey: t('register.invalidKey') })
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
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
        >
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

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-sub">{t('common.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            {errors.name && <span className="text-xs text-red-600">{errors.name}</span>}
          </label>

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

          {serverError && <p className="text-xs text-red-600">{serverError}</p>}

          <button
            type="submit"
            disabled={register.isPending}
            className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {register.isPending && (
              <Spinner size={16} className="border-white/40 border-t-white" />
            )}
            {t('register.submit')}
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

        <div className="mt-6 flex justify-center">
          <LanguageSelect compact />
        </div>
      </div>
    </div>
  )
}
