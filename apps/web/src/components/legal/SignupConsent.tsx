import { useEffect } from 'react'

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
 * Sign-up consent (restricted mode, LEGAL_DIR, docs/adr/2500-*): the notice and the tick boxes above
 * the sign-up button. Placeholder until the terms and consent work fills it in: it draws nothing and
 * reports `ready: true` with no consents, so the form submits as before.
 */
export function SignupConsent({ onChange }: { onChange: (state: SignupConsentState) => void }) {
  useEffect(() => {
    onChange({ ready: true, consents: [] })
  }, [])
  return null
}
