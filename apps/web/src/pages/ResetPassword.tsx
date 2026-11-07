import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { resetPasswordSchema } from '@inkling/shared'
import { ApiError, useAuthMode, useForgotPassword, useResetPassword } from '../api'
import { Spinner } from '../components/Spinner'
import { useT } from '../i18n'
import { delegatedDisplayName } from './Login'

const inputCls =
  'rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

// /reset — password reset.
//   "I have a code": email + reset code (issued by an admin / sent by email, or a single-use signup key) + new password.
//   "I don't have a code": ask the admin for a reset (a verified email gets the reset email right away).
// Arriving from the email link (/reset?email=&code=) pre-fills the fields.
export function ResetPassword() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const mode = useAuthMode()
  const reset = useResetPassword()
  const forgot = useForgotPassword()

  const prefilledCode = params.get('code') ?? ''
  const [tab, setTab] = useState<'code' | 'request'>(
    params.get('mode') === 'request' && !prefilledCode ? 'request' : 'code',
  )
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [code, setCode] = useState(prefilledCode)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [requested, setRequested] = useState(false)

  const delegated = mode.data?.delegated ?? false
  const delegatedName = delegatedDisplayName(mode.data?.delegatedName)

  const submitReset = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (pw !== pw2) {
      setError(t('reset.mismatch'))
      return
    }
    const parsed = resetPasswordSchema.safeParse({ email, code, newPassword: pw })
    if (!parsed.success) {
      const f = parsed.error.issues[0]?.path[0]
      setError(
        f === 'newPassword'
          ? t('reset.newPasswordTooShort')
          : f === 'code'
            ? t('reset.codeRequired')
            : t('reset.emailRequired'),
      )
      return
    }
    reset.mutate(parsed.data, {
      onSuccess: () =>
        navigate(`/login?reset=1&email=${encodeURIComponent(email.trim())}`, { replace: true }),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : t('reset.failed')),
    })
  }

  const submitRequest = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (email.trim().length < 3) {
      setError(t('reset.emailRequired'))
      return
    }
    forgot.mutate(
      { email: email.trim(), note: note.trim() || undefined },
      {
        onSuccess: () => setRequested(true),
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : t('reset.requestFailed')),
      },
    )
  }

  const tabBtn = (which: 'code' | 'request', label: string) => (
    <button
      type="button"
      onClick={() => {
        setTab(which)
        setError(null)
      }}
      aria-pressed={tab === which}
      className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors duration-150 ${
        tab === which ? 'bg-accent/10 font-medium text-accent' : 'text-sub hover:bg-hover hover:text-ink'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex min-h-full items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/icon.svg" alt="Inkling" className="h-12 w-12" />
          <h1 className="text-xl font-bold text-ink">{t('reset.title')}</h1>
        </div>

        <div className="mb-3 flex gap-1 rounded-lg border border-line p-1">
          {tabBtn('code', t('reset.tabCode'))}
          {tabBtn('request', t('reset.tabRequest'))}
        </div>

        {tab === 'code' ? (
          <form
            onSubmit={submitReset}
            className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('common.email')}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('reset.code')}</span>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className={`${inputCls} font-mono`}
              />
              <span className="text-xs text-sub">
                {t('reset.codeHint')}
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('reset.newPassword')}</span>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('reset.confirmPassword')}</span>
              <input
                type="password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
                className={inputCls}
              />
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={reset.isPending}
              className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {reset.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
              {t('reset.submit')}
            </button>
            <p className="text-xs text-sub">{t('reset.signsOutEverywhere')}</p>
          </form>
        ) : requested ? (
          <div className="rounded-lg border border-line bg-app p-6 text-sm text-ink">
            <p>{t('reset.requested')}</p>
            <p className="mt-2 text-xs text-sub">
              {mode.data?.mailEnabled
                ? t('reset.requestedMail')
                : t('reset.requestedNoMail')}
            </p>
          </div>
        ) : (
          <form
            onSubmit={submitRequest}
            className="flex flex-col gap-3 rounded-lg border border-line bg-app p-6"
          >
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">
                {delegated ? t('auth.emailOrId', { name: delegatedName }) : t('common.email')}
              </span>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-sub">{t('reset.note')}</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 300))}
                rows={3}
                placeholder={t('reset.notePlaceholder')}
                className={`${inputCls} resize-none`}
              />
              <span className="text-right text-[11px] text-sub">{note.length}/300</span>
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={forgot.isPending}
              className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {forgot.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
              {t('reset.sendRequest')}
            </button>
            {delegated && (
              <p className="text-xs text-sub">
                {t('reset.delegatedHint', { name: delegatedName })}
              </p>
            )}
          </form>
        )}

        <p className="mt-4 text-center text-xs text-sub">
          <Link to="/login" className="text-accent hover:underline">
            {t('auth.toLogin')}
          </Link>
        </p>
      </div>
    </div>
  )
}
