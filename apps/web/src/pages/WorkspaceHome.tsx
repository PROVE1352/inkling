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

// No page selected: empty state + New page button.
export function WorkspaceHome() {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const t = useT()
  const { onToggleSidebar } = useLayout()
  const { create: newPage, isPending } = useNewPage(wsId ?? '')
  const pages = usePages(wsId ?? '')

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

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-sub">
          <FileTextIcon size={40} />
        </div>
        <div>
          <p className="text-base font-medium text-ink">{t('home.emptyTitle')}</p>
          <p className="mt-1 text-sm text-sub">
            {t('home.emptyHint')}
          </p>
        </div>
        <button
          type="button"
          onClick={newPage}
          disabled={isPending}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {isPending ? (
            <Spinner size={16} className="border-white/40 border-t-white" />
          ) : (
            <PlusIcon size={16} />
          )}
          {t('home.newPage')}
        </button>
      </div>
    </div>
  )
}
