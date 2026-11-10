import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { usePages } from '../api'
import { useLayout } from '../components/AppLayout'
import { NavButtons } from '../components/NavButtons'
import { consumeAppEntry, getLastPage, getPrefs } from '../lib/prefs'
import { useNewPage } from '../lib/newPage'
import { ThemeToggle } from '../components/ThemeToggle'
import { Spinner } from '../components/Spinner'
import { FileTextIcon, MenuIcon, PlusIcon } from '../components/Icons'
import { useT } from '../i18n'
import { useIsGuest } from '../lib/useGuest'
import { useOnboarding } from '../onboarding/api'
import { Checklist } from '../onboarding/Checklist'

// No page selected: empty state + New page button.
export function WorkspaceHome() {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const t = useT()
  const { onToggleSidebar } = useLayout()
  const { create: newPage, isPending } = useNewPage(wsId ?? '')
  const pages = usePages(wsId ?? '')
  // A guest has no top-level pages to make (docs/adr/1252-*): only the pages shared with them.
  const guest = useIsGuest(wsId)
  // Getting started card for new accounts (docs/adr/2380-*)
  const onboarding = useOnboarding()

  // Setting "Page to open on launch: last" — jump to the last page only on first app entry (consumed once during render).
  // When Home is clicked again in the sidebar the entry is already consumed, so we stay on Home.
  const [isEntry] = useState(() => consumeAppEntry())
  const triedRef = useRef(false)
  useEffect(() => {
    if (!isEntry || triedRef.current || !wsId || !pages.data) return
    triedRef.current = true
    if (getPrefs().launchPage !== 'last') return
    const last = getLastPage(wsId)
    if (last && pages.data.some((p) => p.id === last && !p.deletedAt)) {
      navigate(`/w/${wsId}/p/${last}`, { replace: true })
    }
  }, [isEntry, wsId, pages.data, navigate])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('home.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <span className="flex-1" />
        <ThemeToggle />
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-4 overflow-y-auto px-6 py-6 text-center">
        <div className="text-sub">
          <FileTextIcon size={40} />
        </div>
        <div>
          <p className="text-base font-medium text-ink">{t('home.emptyTitle')}</p>
          <p className="mt-1 text-sm text-sub">
            {t('home.emptyHint')}
          </p>
        </div>
        {guest ? (
          <p className="text-sm text-sub">{t('guest.homeHint')}</p>
        ) : (
        <button
          type="button"
          onClick={newPage}
          disabled={isPending}
          data-onboarding="new-page"
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {isPending ? (
            <Spinner size={16} className="border-white/40 border-t-white" />
          ) : (
            <PlusIcon size={16} />
          )}
          {t('home.newPage')}
        </button>
        )}
        {!guest && wsId && onboarding?.checklist.show && (
          <div className="mt-4 flex w-full justify-center">
            <Checklist wsId={wsId} dto={onboarding} variant="home" />
          </div>
        )}
      </div>
    </div>
  )
}
