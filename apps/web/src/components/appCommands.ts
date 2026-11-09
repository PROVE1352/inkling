// Handlers for the app-wide registry commands (docs/adr/1400-*): what ⌘K, ⌘P, ⌘\ … and the palette's
// "New folder", "Today's daily note" … do. The keys are in lib/shortcuts/registry.ts; the window
// dispatcher and the command palette both run these. Bound by AppLayout for the open workspace.
import { useLocation, useNavigate } from 'react-router'
import { useCreatePage, usePages } from '../api'
import { useDailyNote } from '../lib/dailyNote'
import { useNewPage } from '../lib/newPage'
import { requestPropsFocus } from '../lib/propsFocus'
import { useCommand } from '../lib/shortcuts'
import { getTheme, setTheme, type Theme } from '../lib/theme'
import { toISODate } from '../lib/time'
import { useHistoryNav } from './NavButtons'
import type { SearchMode } from './SearchModal'

const THEME_ORDER: Theme[] = ['light', 'dark', 'system']

export function useAppCommands({
  wsId,
  guest,
  openSearch,
  toggleSidebar,
  togglePalette,
  openHelp,
  openTrash,
  openTemplates,
}: {
  wsId: string
  /** A guest has no search, palette, graph or new pages (docs/adr/1252-*): those keys stay the browser's. */
  guest: boolean
  openSearch: (q?: string, mode?: SearchMode) => void
  toggleSidebar: () => void
  togglePalette: () => void
  openHelp: () => void
  openTrash: () => void
  openTemplates: () => void
}): void {
  const navigate = useNavigate()
  const location = useLocation()
  const histNav = useHistoryNav()
  const { create: newPage } = useNewPage(wsId)
  const createPage = useCreatePage(wsId)
  const pages = usePages(wsId)
  const { openDaily } = useDailyNote(wsId)

  const member = () => !guest && !!wsId
  const go = (path: string) => () => {
    navigate(path)
  }
  const onPage = () => location.pathname.includes('/p/')

  const newInKind = (kind: 'folder' | 'collection' | 'canvas') =>
    createPage.mutate(
      { workspaceId: wsId, kind },
      { onSuccess: (page) => (kind !== 'folder' ? navigate(`/w/${wsId}/p/${page.id}`) : undefined) },
    )
  const openDailyAt = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    openDaily(toISODate(d))
  }

  useCommand('app.search', () => openSearch(), member)
  // Quick switcher instead of the browser's "Open file"
  useCommand('app.quickSwitcher', () => openSearch('', 'title'), member)
  useCommand('app.fullTextSearch', () => openSearch('', 'all'), member)
  // ⌘P is the browser's print otherwise; the dispatcher prevents it
  useCommand('app.palette', togglePalette, member)
  useCommand('app.newPage', () => void newPage(), member)
  useCommand('nav.back', () => void histNav.back())
  useCommand('nav.forward', () => void histNav.forward())
  // Graph instead of the browser's "Find next"
  useCommand('app.graph', go(`/w/${wsId}/graph`), member)
  useCommand('app.settings', go(`/w/${wsId}/settings`))
  useCommand('app.toggleSidebar', toggleSidebar)
  useCommand('app.help', openHelp)

  useCommand('app.newFolder', () => newInKind('folder'), member)
  useCommand('app.newDatabase', () => newInKind('collection'), member)
  useCommand('app.newCanvas', () => newInKind('canvas'), member)
  useCommand('app.fromTemplate', openTemplates, member)
  useCommand('app.dailyToday', () => openDailyAt(0), member)
  useCommand('app.dailyYesterday', () => openDailyAt(-1), member)
  useCommand('app.dailyTomorrow', () => openDailyAt(1), member)
  useCommand(
    'app.randomPage',
    () => {
      // excludes folders and trashed pages
      const list = (pages.data ?? []).filter((p) => !p.deletedAt && p.kind !== 'folder')
      if (list.length === 0) return false
      navigate(`/w/${wsId}/p/${list[Math.floor(Math.random() * list.length)].id}`)
    },
    member,
  )
  useCommand('app.due', go(`/w/${wsId}/due`), member)
  useCommand('app.tags', go(`/w/${wsId}/tags`), member)
  useCommand('app.webShares', go(`/w/${wsId}/shared`), member)
  // Every sidebar menu has a command too, so a menu hidden from the sidebar stays reachable (docs/adr/1020-*).
  useCommand('app.calendar', go(`/w/${wsId}/calendar`), member)
  useCommand('app.activity', go(`/w/${wsId}/activity`), member)
  useCommand('app.later', go(`/w/${wsId}/later`), member)
  useCommand('app.threads', go(`/w/${wsId}/threads`), member)
  useCommand('app.trash', openTrash, member)
  useCommand('app.reload', () => window.location.reload())
  useCommand('app.cycleTheme', () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(getTheme()) + 1) % THEME_ORDER.length]))
  useCommand('app.customizeSidebar', go(`/w/${wsId}/settings#sidebar`))
  useCommand('app.mcp', go('/settings/connections'), member)

  // ⌘; — the right panel opens at the properties section (PageView listens)
  useCommand('page.properties', requestPropsFocus, () => onPage())
  // F2 outside the tree: select the page title. The tree's own F2 (rename the row) runs first.
  useCommand(
    'page.renameTitle',
    () => {
      const title = document.querySelector<HTMLTextAreaElement>('textarea[data-page-title]')
      if (!title) return false
      title.focus()
      title.select()
    },
    onPage,
  )
}
