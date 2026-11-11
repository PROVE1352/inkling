import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '../../i18n'
import { Spinner } from '../Spinner'
import { ConsentItems } from './ConsentItems'
import { CONSENT_REQUIRED_EVENT, useLegal, useLegalMode } from './legalApi'

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

