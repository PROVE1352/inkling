import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { UserDTO } from '@inkling/shared'
import { api, ApiError, qk, useAuthMode } from '../../api'
import { useT, tMaybe } from '../../i18n'
import { trialDelayMs, trialErrorKey, trialFormMs, trialLandingPath } from '../../lib/trial'
import { useSignupShownAt } from '../account/SignupExtras'
import { SignupAgreementLine } from '../legal/SignupConsent'
import { Spinner } from '../Spinner'

interface TrialResult {
  user: UserDTO
  workspaceId: string
  samplePageId: string | null
}

/**
 * "Try without an account" under the sign-in and sign-up forms (TRIAL_ACCOUNTS, docs/adr/2555-*).
 * Nothing while the server has trials off, or hides the button (no admin yet, sign-up tick boxes); a
 * line instead of it while every trial seat is taken. A click before the screen has been up 2 s waits
 * for the rest before sending (the server's bot check), then lands on the sample page. With documents
 * but no tick boxes, the one-line agreement goes under it and the version shown is sent.
 */
export function TrialButton({ placement }: { placement: 'login' | 'register' }) {
  const t = useT()
  const mode = useAuthMode()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const shownAt = useSignupShownAt()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trial = mode.data?.trial
  if (!trial) return null
  if (!trial.available) {
    if (trial.reason !== 'full') return null
    return (
      <p className="mt-4 break-keep text-center text-xs text-sub" data-testid="trial-full">
        {t('trial.full')}
      </p>
    )
  }

  const start = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const wait = trialDelayMs(shownAt, Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      const legalVersion = mode.data?.legal?.version
      const r = await api<TrialResult>('/api/auth/trial', {
        method: 'POST',
        body: JSON.stringify({ formMs: trialFormMs(shownAt, Date.now()), website: '', ...(legalVersion ? { legalVersion } : {}) }),
      })
      qc.setQueryData(qk.me, r.user)
      await qc.invalidateQueries({ queryKey: qk.me })
      void qc.invalidateQueries({ queryKey: qk.workspaces })
      navigate(trialLandingPath(r), { replace: true })
    } catch (err) {
      if (err instanceof ApiError) {
        const key = trialErrorKey(err.code)
        setError((key && tMaybe(key)) || err.message)
        // the seats or the terms changed since the screen loaded: show what the server says now
        if (err.code === 'TRIAL_FULL' || err.code === 'TRIAL_NEEDS_CONSENT' || err.code === 'SETUP_REQUIRED') {
          void qc.invalidateQueries({ queryKey: qk.authMode })
        }
      } else setError(t('login.failed'))
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2" data-testid={`trial-${placement}`}>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        aria-busy={busy}
        data-testid="trial-button"
        className="flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        {busy && <Spinner size={16} />}
        {t('trial.button')}
      </button>
      {error && (
        <p className="text-center text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      {/* the sign-up form has the same line under its own button already */}
      {placement === 'login' && <SignupAgreementLine />}
      <p className="break-keep text-center text-[11px] leading-relaxed text-sub">{t('trial.hint', { hours: trial.hours })}</p>
    </div>
  )
}
