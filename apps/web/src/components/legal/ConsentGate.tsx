import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk, type MeDTO } from '../../api'
import { ConsentScreen } from './ConsentScreen'
import { CONSENT_REQUIRED_EVENT, useLegalMode } from './legalApi'

/** Screens that never wait for the consent: signed-out screens, the documents, public links. */
const OPEN_PATHS = /^\/(login|register|signup|setup|reset|verify|terms|privacy)(\/|$)|^\/(s|f)\//

export function isConsentFreePath(pathname: string): boolean {
  return OPEN_PATHS.test(pathname)
}

/**
 * Around every route (App.tsx, docs/adr/2519-*): a signed-in person whose /auth/me says
 * `consentRequired` sees the consent screen instead of the screen they opened, whichever it is (the
 * workspace, the OAuth approval, the clipper, an invite). The server refuses their other requests
 * anyway; this keeps them from a trail of errors.
 *
 * It only watches the /auth/me the screens already load (no request of its own), and a request
 * refused with CONSENT_REQUIRED (the documents changed while the app was open) reloads /auth/me.
 * Without LEGAL_DIR it renders its children and nothing else.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const mode = useLegalMode()
  const qc = useQueryClient()
  const location = useLocation()
  // a passive view of the cached /auth/me (useMe fetches it; this never does)
  const me = useQuery<MeDTO>({ queryKey: qk.me, enabled: false })

  useEffect(() => {
    if (!mode) return
    const onRefused = () => {
      const cached = qc.getQueryData<MeDTO>(qk.me)
      if (cached && !cached.consentRequired) void qc.invalidateQueries({ queryKey: qk.me })
    }
    window.addEventListener(CONSENT_REQUIRED_EVENT, onRefused)
    return () => window.removeEventListener(CONSENT_REQUIRED_EVENT, onRefused)
  }, [mode, qc])

  if (mode && me.data?.consentRequired && !isConsentFreePath(location.pathname)) return <ConsentScreen />
  return <>{children}</>
}
