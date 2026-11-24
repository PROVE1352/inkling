import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '../../i18n'
import { Spinner } from '../Spinner'
import { ConsentItems } from './ConsentItems'
import { CONSENT_REQUIRED_EVENT, DOC_PATH, useLegal, useLegalMode } from './legalApi'
import { signupAgreementParts, signupSubmitKey } from './signupAgreement'

/** What the consent block tells the sign-up form. */
export interface SignupConsentState {
  /** Every required item is ticked (true when the server asks for no consent). */
  ready: boolean
  /** The ids of the ticked items (signup.json `items[].id`). */
  consents: string[]
  /** The document version the block showed (GET /api/legal → version). */
  legalVersion?: string
}

/**
 * Sign-up consent (restricted mode, LEGAL_DIR, docs/adr/2519-*): the notice and the tick boxes above
 * the sign-up button. Without LEGAL_DIR it draws nothing and reports `ready: true` with no consents,
 * so the form submits as in 0.21.1. With it the form stays off until every required box is ticked,
 * and the version shown goes with the sign-up (the server refuses another one).
 */
export function SignupConsent({ onChange }: { onChange: (state: SignupConsentState) => void }) {
  const t = useT()
  const qc = useQueryClient()
  const mode = useLegalMode()
  const legal = useLegal(!!mode)
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [changed, setChanged] = useState(false)
  const shownVersion = useRef<string | null>(null)
  const report = useRef(onChange)
  report.current = onChange

  // the terms changed while the form was open (the server said CONSENT_REQUIRED): read them again
  useEffect(() => {
    if (!mode) return
    const onRefused = () => void qc.invalidateQueries({ queryKey: ['legal'] })
    window.addEventListener(CONSENT_REQUIRED_EVENT, onRefused)
    return () => window.removeEventListener(CONSENT_REQUIRED_EVENT, onRefused)
  }, [mode, qc])

  // a new version clears the ticks: they were given to other text
  useEffect(() => {
    const v = legal.data?.version
    if (!v) return
    if (shownVersion.current && shownVersion.current !== v) {
      setChecked(new Set())
      setChanged(true)
    }
    shownVersion.current = v
  }, [legal.data?.version])

  const state = useMemo<SignupConsentState>(() => {
    if (!mode) return { ready: true, consents: [] }
    const data = legal.data
    if (!data) return { ready: false, consents: [] }
    const consents = data.items.filter((i) => checked.has(i.id)).map((i) => i.id)
    const ready = data.items.every((i) => !i.required || checked.has(i.id))
    return { ready, consents, legalVersion: data.version }
  }, [mode, legal.data, checked])

  useEffect(() => {
    report.current(state)
  }, [state])

  if (!mode) return null
  if (legal.isLoading) {
    return (
      <div className="flex justify-center py-2">
        <Spinner size={16} />
      </div>
    )
  }
  if (!legal.data) {
    return (
      <p role="alert" className="text-xs text-red-600">
        {t('legal.loadFailed')}
      </p>
    )
  }
  // signup.json without items and without a notice: nothing above the button (the line goes under it)
  if (legal.data.items.length === 0 && !legal.data.notice && !changed) return null
  return (
    <div className="flex flex-col gap-2">
      {changed && (
        <p role="alert" className="text-xs text-red-600">
          {t('legal.versionChanged')}
        </p>
      )}
      <ConsentItems
        legal={legal.data}
        checked={checked}
        onToggle={(id, on) =>
          setChecked((prev) => {
            const next = new Set(prev)
            if (on) next.add(id)
            else next.delete(id)
            return next
          })
        }
        missingText={t('legal.missingSignup')}
      />
    </div>
  )
}


/**
 * The one line under the sign-up button when signup.json has no items to tick but the folder has
 * documents (docs/adr/2553-*): "By continuing, you agree to the Terms of Service and the Privacy
 * Policy.", each document name a link opening in a new tab so the form keeps what was typed. Nothing
 * is recorded for it (no user_consents rows); the sign-up still sends the version shown.
 */
export function SignupAgreementLine() {
  const t = useT()
  const mode = useLegalMode()
  const legal = useLegal(!!mode)
  if (!mode || !legal.data) return null
  const parts = signupAgreementParts(mode.docs, legal.data.items.length)
  if (parts.length === 0) return null
  return (
    <p className="break-keep text-center text-xs leading-relaxed text-sub" data-testid="legal-signup-agreement">
      {parts.map((p, i) =>
        'doc' in p ? (
          <a key={i} href={DOC_PATH[p.doc]} target="_blank" rel="noopener" className="text-ink underline underline-offset-2 hover:text-accent">
            {t(p.doc === 'terms' ? 'legal.terms' : 'legal.privacy')}
          </a>
        ) : (
          <span key={i}>{t(p.key)}</span>
        ),
      )}
    </p>
  )
}

/** The sign-up button's text: "Continue" while SignupAgreementLine shows, otherwise `otherwise`. */
export function useSignupSubmitKey<K extends string>(otherwise: K): K | 'legal.signupContinue' {
  const mode = useLegalMode()
  const legal = useLegal(!!mode)
  if (!mode || !legal.data) return otherwise
  return signupSubmitKey(mode.docs, legal.data.items.length, otherwise)
}
