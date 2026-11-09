import { useLocation, useNavigate, useNavigationType } from 'react-router'
import { isStandalone } from '../lib/platform'
import { useShortcutKeys, withShortcut } from '../lib/shortcuts'
import { useT } from '../i18n'
import { ArrowLeftIcon, ArrowRightIcon } from './Icons'

// Position in the in-app history — react-router stores it in history.state.idx, starting at 0.
// The browser does not tell us whether "forward" is possible, so the module remembers the highest idx seen
// (PUSH truncates the forward entries, so its idx becomes the max; REPLACE/POP keep them).
let maxIdx = 0

function currentIdx(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0
}

// Called during render — idempotent, so calling it from several places (AppLayout, buttons) is safe.
export function useHistoryNav() {
  useLocation() // subscribe so this recomputes on every location change
  const navType = useNavigationType()
  const navigate = useNavigate()
  const idx = currentIdx()
  if (navType === 'PUSH') maxIdx = idx
  else maxIdx = Math.max(maxIdx, idx)
  const canBack = idx > 0
  const canForward = idx < maxIdx
  return {
    canBack,
    canForward,
    // Going back from the app's first screen would leave the app (login/blank tab), so block it.
    back: () => {
      if (currentIdx() > 0) navigate(-1)
    },
    forward: () => navigate(1),
  }
}

// Top bar ← → — an installed PWA (standalone) has no browser back/forward buttons, so the app draws its own.
// Hidden in a regular browser tab, where they would duplicate the browser's buttons.
export function NavButtons() {
  const { canBack, canForward, back, forward } = useHistoryNav()
  const t = useT()
  useShortcutKeys()
  if (!isStandalone()) return null
  const btn =
    'rounded-md p-1.5 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] disabled:pointer-events-none disabled:opacity-35'
  return (
    <div className="flex shrink-0 items-center" data-nav-buttons>
      <button
        type="button"
        onClick={back}
        disabled={!canBack}
        aria-label={t('common.back')}
        title={withShortcut(t('common.back'), 'nav.back')}
        className={btn}
      >
        <ArrowLeftIcon size={17} />
      </button>
      <button
        type="button"
        onClick={forward}
        disabled={!canForward}
        aria-label={t('nav.forward')}
        title={withShortcut(t('nav.forward'), 'nav.forward')}
        // The phone top bar is narrow — forward is rarely used, so hide it and keep only back (Android also has system back).
        className={`${btn} max-sm:hidden`}
      >
        <ArrowRightIcon size={17} />
      </button>
    </div>
  )
}
