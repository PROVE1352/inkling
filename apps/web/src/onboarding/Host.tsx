import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useLocation } from 'react-router'
import { useWorkspaces } from '../api'
import { isStandalone } from '../lib/platform'
import { isOfflineEnabled } from '../lib/offline/runtime'
import { INTRO_EVENT, noteOnboarding, useOnboarding, useUpdateOnboarding } from './api'

// Mounted once in the app layout (docs/adr/2380-*, 2382-*): plays the intro for a new account the
// first time, or when asked (Settings, the card), and records the few things only the browser sees.
//
// The intro is its own chunk under assets/lazy/ (not precached). It is fetched with a plain
// import(): when that fails (offline before it was ever cached) the intro is skipped quietly and
// stays "not seen", instead of the stale-chunk reload the route chunks do.

type IntroProps = { onClose: (finished: boolean) => void }
let introModule: Promise<ComponentType<IntroProps> | null> | null = null
const loadIntro = () =>
  (introModule ??= import('./intro/IntroOverlay').then(
    (m) => m.IntroOverlay as ComponentType<IntroProps>,
    () => {
      introModule = null
      return null
    },
  ))

/** The focus is in the editor or a text field: the person is writing. */
function typingSomewhere(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export function OnboardingHost({ wsId }: { wsId: string }) {
  const dto = useOnboarding()
  const update = useUpdateOnboarding()
  const workspaces = useWorkspaces()
  const { pathname } = useLocation()
  const [Intro, setIntro] = useState<ComponentType<IntroProps> | null>(null)
  const autoTried = useRef(false)
  const [recheck, setRecheck] = useState(0)
  const auto = useRef(false)

  const open = useCallback((isAuto: boolean) => {
    auto.current = isAuto
    void loadIntro().then((C) => {
      if (C) setIntro(() => C)
    })
  }, [])

  // Play it by itself once per page load when the server says so (a new account, or an existing one
  // on a server with ONBOARDING_EXISTING_USERS=once). Never over someone typing: while a text field
  // or the editor has the focus it waits for the next screen change (or the window regaining focus).
  useEffect(() => {
    if (!dto?.intro || autoTried.current) return
    if (typingSomewhere()) return
    autoTried.current = true
    open(true)
  }, [dto?.intro, open, pathname, recheck])

  // While it waits: look again when the window comes back to the front.
  useEffect(() => {
    if (!dto?.intro || autoTried.current) return
    const again = () => setRecheck((n) => n + 1)
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [dto?.intro])

  useEffect(() => {
    const onAsk = () => open(false)
    window.addEventListener(INTRO_EVENT, onAsk)
    return () => window.removeEventListener(INTRO_EVENT, onAsk)
  }, [open])

  // "Look around the team workspace": a page opened in a workspace the person does not own.
  useEffect(() => {
    if (!dto || !/\/p\/[^/]+$/.test(pathname)) return
    const role = workspaces.data?.find((w) => w.id === wsId)?.role
    if (role && role !== 'owner' && role !== 'guest') noteOnboarding('explore')
  }, [dto, pathname, wsId, workspaces.data])

  // "Install the app or turn on offline": running as the installed app, or offline copies on.
  useEffect(() => {
    if (dto && (isStandalone() || isOfflineEnabled())) noteOnboarding('install')
  }, [dto, pathname])

  if (!Intro) return null
  return (
    <Intro
      onClose={() => {
        setIntro(null)
        // closing it (skipped or watched) counts as seen on every device
        if (dto?.intro || auto.current) update.mutate({ introSeen: true })
      }}
    />
  )
}
