import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { SIDEBAR_MENU_DEFAULT_HIDDEN, SIDEBAR_MENU_IDS, type PageScope, type SidebarMenuId } from '@inkling/shared'
import {
  useBookmarks,
  useCreatePage,
  useDue,
  useLogout,
  useMe,
  usePages,
  useWorkspaces,
  useSharedList,
} from '../api'
import { copyText, inviteLink } from '../lib/clipboard'
import { useDailyNote } from '../lib/dailyNote'
import { useNewPage } from '../lib/newPage'
import { PageIconGlyph } from './PageIconGlyph'
import { useShortcutKeys, withShortcut } from '../lib/shortcuts'
import { MenuShortcut } from './MenuShortcut'
import { useT } from '../i18n'
import { useSaveSidebarPrefs, useSidebarPrefs } from '../sidebarApi'
import {
  compactSidebarFooter,
  resolveSidebarMenu,
  rowsOutOfView,
  setEntryHidden,
  sidebarLayout,
  sidebarTreeMinHeight,
  type SidebarCardSize,
  toSidebarPrefs,
  visibleSidebarMenu,
} from '../lib/sidebarMenu'
import { toast } from '../lib/toast'
import { SIDEBAR_MENU_META, isSidebarMenuId } from './sidebarMenus'
import { SidebarMenuPopup, useMenuContextTrigger, type MenuCtx } from './SidebarMenuContext'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { PageTree } from './PageTree'
import { TrashModal } from './TrashModal'
import { Spinner } from './Spinner'
import { useLaterList, useThreads } from '../laterApi'
import { askConfirm } from '../lib/confirm'
import { offlineStatus } from '../lib/offline/runtime'
import { OnboardingSidebarEntry } from '../onboarding/SidebarEntry'
import {
  AlarmIcon,
  ClockIcon,
  MessageIcon,
  HistoryIcon,
  CalendarDayIcon,
  CalendarIcon,
  CanvasIcon,
  DatabaseIcon,
  GraphIcon,
  KeyIcon,
  KeyboardIcon,
  TagIcon,
  GlobeIcon,
  TemplateIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  FolderPlusIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  UserIcon,
} from './Icons'

export function Sidebar({
  wsId,
  onOpenSearch,
  onOpenHelp,
  onOpenTemplates,
}: {
  wsId: string
  onOpenSearch: () => void
  onOpenHelp: () => void
  onOpenTemplates: () => void
}) {
  // tooltips and menu items carry the keys; re-render when the user changes one
  useShortcutKeys()
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const graphActive = location.pathname === `/w/${wsId}/graph`
  const tagsActive = location.pathname.startsWith(`/w/${wsId}/tags`)
  const sharedActive = location.pathname === `/w/${wsId}/shared`
  const sharedList = useSharedList(wsId)
  const sharedCount = sharedList.data?.items.length ?? 0
  const dueActive = location.pathname === `/w/${wsId}/due`
  // Due badge (overdue + today) — reuses the Due view's query (staleTime), so no extra request.
  const due = useDue(wsId)
  const dueOverdue = due.data?.counts.overdue ?? 0
  const dueBadge = dueOverdue + (due.data?.counts.today ?? 0)
  const calendarActive = location.pathname === `/w/${wsId}/calendar`
  const activityActive = location.pathname === `/w/${wsId}/activity`
  // Later list and followed threads (docs/adr/1410-*, 1412-*): badges = reminders due / threads with new replies.
  const laterActive = location.pathname === `/w/${wsId}/later`
  const threadsActive = location.pathname === `/w/${wsId}/threads`
  const laterList = useLaterList(wsId, 'open')
  const laterDue = laterList.data?.due ?? 0
  const threadList = useThreads(wsId)
  const threadsUnread = threadList.data?.unread ?? 0
  const settingsActive = location.pathname === `/w/${wsId}/settings`
  const me = useMe()
  const workspaces = useWorkspaces()
  const pages = usePages(wsId)
  const bookmarks = useBookmarks(wsId)
  const createPage = useCreatePage(wsId)
  const logout = useLogout()
  // Open/create the daily note (extracted into a hook shared with the global calendar — M18).
  const { openDaily, busy: dailyBusy } = useDailyNote(wsId)

  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [favCollapsed, setFavCollapsed] = useState(() => {
    try {
      return localStorage.getItem('inkling:favCollapsed') === '1'
    } catch {
      return false
    }
  })

  const toggleFav = () => {
    setFavCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('inkling:favCollapsed', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }
  const newMenuRef = useRef<HTMLDivElement>(null)
  const current = workspaces.data?.find((w) => w.id === wsId)
  // Guest (docs/adr/1252-*): only the pages shared with them. Workspace-wide menus, top-level pages,
  // trash and the invite link are member features the server refuses, so they are not shown.
  const guest = current?.role === 'guest'

  useEffect(() => {
    if (!newMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node))
        setNewMenuOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [newMenuOpen])

  // "New page" — follows the new-page location setting (top level / under current / same folder); shared with ⌘N.
  const { create: newPage, isPending: newPagePending } = useNewPage(wsId)

  // Per-section [＋]: creates a root page in that scope (shared/private). The split button at the top defaults to shared.
  const newPageInScope = (scope: PageScope) => {
    createPage.mutate(
      { workspaceId: wsId, scope },
      { onSuccess: (page) => navigate(`/w/${wsId}/p/${page.id}`) },
    )
  }

  const newFolder = () => {
    setNewMenuOpen(false)
    createPage.mutate({ workspaceId: wsId, kind: 'folder' })
  }

  const newDatabase = () => {
    setNewMenuOpen(false)
    createPage.mutate(
      { workspaceId: wsId, kind: 'collection' },
      { onSuccess: (page) => navigate(`/w/${wsId}/p/${page.id}`) },
    )
  }

  const newCanvas = () => {
    setNewMenuOpen(false)
    createPage.mutate(
      { workspaceId: wsId, kind: 'canvas' },
      { onSuccess: (page) => navigate(`/w/${wsId}/p/${page.id}`) },
    )
  }

  const copyLink = async () => {
    if (!current) return
    const ok = await copyText(inviteLink(current.inviteCode))
    setCopied(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), 1500)
  }

  const doLogout = async () => {
    // logging out deletes this device's offline copies, unsent edits included (docs/adr/2203-*)
    const pending = offlineStatus().pendingPages
    if (pending > 0 && !(await askConfirm(t('offline.logoutPending', { count: pending }), t('sidebar.logout')))) return
    logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })
  }

  // Top menus (docs/adr/1020-*): saved order/visibility from the server, merged with this build's menus.
  const sidebarPrefs = useSidebarPrefs()
  const saveSidebar = useSaveSidebarPrefs()
  const visibleMenus = visibleSidebarMenu(sidebarPrefs, SIDEBAR_MENU_IDS, SIDEBAR_MENU_DEFAULT_HIDDEN) as SidebarMenuId[]
  const [menuCtx, setMenuCtx] = useState<MenuCtx | null>(null)
  const closeMenuCtx = useCallback(() => setMenuCtx(null), [])
  const menuTrigger = useMenuContextTrigger(setMenuCtx)
  const hideMenu = (id: SidebarMenuId) => {
    const prev = sidebarPrefs
    const next = toSidebarPrefs(
      setEntryHidden(resolveSidebarMenu(prev, SIDEBAR_MENU_IDS, SIDEBAR_MENU_DEFAULT_HIDDEN), id, true),
      SIDEBAR_MENU_IDS,
      prev,
      SIDEBAR_MENU_DEFAULT_HIDDEN,
    )
    saveSidebar.mutate(next, {
      onSuccess: () =>
        toast({
          message: t('sidebar.hidden', { name: t(SIDEBAR_MENU_META[id].label) }),
          actionLabel: t('toast.undo'),
          onAction: () => saveSidebar.mutate(prev),
        }),
    })
  }

  // Menus that do not fit above the page tree fold under "More (k)" (docs/adr/1640-*, opened: 1643-*): the tree keeps
  // sidebarTreeMinHeight() of the sidebar whatever menus are on, and below COMPACT_FOOTER_BELOW the footer
  // (trash, shortcuts, settings, account) becomes one row of icons. Heights are measured on the sidebar
  // itself, so the phone drawer and the desktop column follow the same rule.
  const asideRef = useRef<HTMLElement>(null)
  const menusRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const [asideH, setAsideH] = useState(0)
  // bumped on every size change: a width change alone (the footer wrapping at 200 px) must re-measure too
  const [, setResizeTick] = useState(0)
  const [fit, setFit] = useState<{ free: number; rowHeight: number } | null>(null)
  // the "Getting started" card's own sizes (docs/adr/2384-*), reported by the card; null while it is not drawn
  const [cardSize, setCardSize] = useState<SidebarCardSize | null>(null)
  const [menusExpanded, setMenusExpanded] = useState(() => {
    try {
      return localStorage.getItem('inkling:sidebarMenusExpanded') === '1'
    } catch {
      return false
    }
  })
  const toggleMenusExpanded = () => {
    setMenusExpanded((v) => {
      const next = !v
      try {
        localStorage.setItem('inkling:sidebarMenusExpanded', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }
  // Layout effect: the first paint already has the folded menus, not a frame of the unfolded ones.
  useLayoutEffect(() => {
    const el = asideRef.current
    if (!el) return
    const measure = () => {
      setAsideH(el.clientHeight)
      setResizeTick((n) => n + 1)
    }
    setAsideH(el.clientHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const compactFooter = compactSidebarFooter(asideH)
  const treeMin = asideH ? sidebarTreeMinHeight(asideH) : 0
  // Every render: what is left for the menus, the tree and the card once the other rows are placed. The
  // menus, the tree and the card are not counted, so the result does not depend on how they are drawn
  // (the card reports its sizes itself, margins included).
  useLayoutEffect(() => {
    const aside = asideRef.current
    if (!aside || !asideH) return
    let fixed = 0
    for (const el of Array.from(aside.children) as HTMLElement[]) {
      if (el === menusRef.current || el === navRef.current || el.hasAttribute('data-sidebar-card')) continue
      const pos = getComputedStyle(el).position
      if (pos === 'fixed' || pos === 'absolute') continue
      fixed += el.getBoundingClientRect().height
    }
    const rowHeight = menusRef.current?.querySelector<HTMLElement>('[data-sidebar-menu]')?.offsetHeight || 32
    const free = Math.floor(asideH - fixed)
    setFit((prev) => (prev && prev.free === free && prev.rowHeight === rowHeight ? prev : { free, rowHeight }))
  })
  const menuActive: Partial<Record<SidebarMenuId, boolean>> = {
    later: laterActive,
    threads: threadsActive,
    graph: graphActive,
    tags: tagsActive,
    shared: sharedActive,
    due: dueActive,
    calendar: calendarActive,
    activity: activityActive,
  }
  const menuBadge: Partial<Record<SidebarMenuId, boolean>> = { later: laterDue > 0, threads: threadsUnread > 0, due: dueBadge > 0 }
  // "More" open (docs/adr/1643-*): every menu shows and the tree gives way down to a smaller minimum.
  // Whether the menus fold stays decided by the folded budget, so "Show less" stays put. Only when even
  // that leaves too little room does the list scroll, in whole rows, above a "k more below" row.
  // The "Getting started" card is in the same budget (docs/adr/2384-*): it is drawn open only in what the
  // tree floor and the menus leave, scrolls inside when its items need more, and is drawn folded when
  // not even two items fit. Below COMPACT_FOOTER_BELOW it is not drawn at all.
  const card = compactFooter ? null : cardSize
  const layout = fit
    ? sidebarLayout({
        free: fit.free,
        count: visibleMenus.length,
        rowHeight: fit.rowHeight,
        treeMin,
        expanded: menusExpanded,
        card,
      })
    : null
  const shownMenus = layout ? layout.shown : visibleMenus.length
  const folding = shownMenus < visibleMenus.length
  const foldedMenus = folding ? visibleMenus.slice(shownMenus) : []
  const menusOpen = folding && menusExpanded
  const openLayout = menusOpen ? (layout?.open ?? null) : null
  const navMin = layout ? layout.navMin : treeMin
  const openScrolls = openLayout?.maxHeight != null
  const menusBoxRef = useRef<HTMLDivElement>(null)
  const [outOfView, setOutOfView] = useState({ above: 0, below: 0 })
  const updateOutOfView = useCallback(() => {
    const box = menusBoxRef.current
    const next = box
      ? rowsOutOfView({
          count: box.childElementCount,
          rowHeight: fit?.rowHeight ?? 32,
          scrollTop: box.scrollTop,
          clientHeight: box.clientHeight,
        })
      : { above: 0, below: 0 }
    setOutOfView((prev) => (prev.above === next.above && prev.below === next.below ? prev : next))
  }, [fit?.rowHeight])
  useLayoutEffect(updateOutOfView, [updateOutOfView, openScrolls, openLayout?.maxHeight, visibleMenus.length])
  const hiddenOpenMenus = openScrolls
    ? [...visibleMenus.slice(0, outOfView.above), ...visibleMenus.slice(visibleMenus.length - outOfView.below)]
    : []
  const scrollOpenMenus = () => {
    const box = menusBoxRef.current
    if (!box) return
    const rowH = fit?.rowHeight ?? 32
    if (outOfView.below > 0) box.scrollBy({ top: Math.max(rowH, Math.floor(box.clientHeight / rowH) * rowH), behavior: 'smooth' })
    else box.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // "New page ▾" menu: below the button when it fits, else above it, else as tall as fits with a scroll.
  const newMenuPopRef = useRef<HTMLDivElement>(null)
  const [newMenuPlace, setNewMenuPlace] = useState<{ up: boolean; maxHeight?: number } | null>(null)
  useLayoutEffect(() => {
    if (!newMenuOpen) {
      setNewMenuPlace(null)
      return
    }
    const anchor = newMenuRef.current
    const pop = newMenuPopRef.current
    if (!anchor || !pop) return
    const r = anchor.getBoundingClientRect()
    const h = pop.scrollHeight
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    if (h <= below) setNewMenuPlace({ up: false })
    else if (above > below) setNewMenuPlace({ up: true, maxHeight: h > above ? above : undefined })
    else setNewMenuPlace({ up: false, maxHeight: below })
  }, [newMenuOpen])

  const footerIcon =
    'flex items-center justify-center rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:p-2'

  const menuButtons: Record<SidebarMenuId, ReactNode> = {
    search: (
      <button
        key="search"
        data-sidebar-menu="search"
        {...menuTrigger('search')}
        type="button"
        onClick={onOpenSearch}
        className="flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <SearchIcon size={16} />
        {t('common.search')}
        <MenuShortcut id="app.search" className="text-sub/70" />
      </button>
    ),
    later: (
      <button
        key="later"
        data-sidebar-menu="later"
        {...menuTrigger('later')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/later`)}
        aria-current={laterActive ? 'page' : undefined}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          laterActive ? 'bg-active font-medium text-ink' : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <ClockIcon size={16} />
        <span className="flex-1 text-left">{t('sidebar.later')}</span>
        {laterDue > 0 && (
          <span data-testid="later-badge" className="min-w-5 rounded-full bg-red-500/15 px-1.5 text-center text-[11px] font-medium text-red-500">
            {laterDue}
          </span>
        )}
      </button>
    ),
    threads: (
      <button
        key="threads"
        data-sidebar-menu="threads"
        {...menuTrigger('threads')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/threads`)}
        aria-current={threadsActive ? 'page' : undefined}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          threadsActive ? 'bg-active font-medium text-ink' : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <MessageIcon size={16} />
        <span className={`flex-1 text-left ${threadsUnread > 0 ? 'font-medium text-ink' : ''}`}>{t('sidebar.threads')}</span>
        {threadsUnread > 0 && (
          <span data-testid="threads-badge" className="min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-medium text-white">
            {threadsUnread}
          </span>
        )}
      </button>
    ),
    graph: (
      <button
        key="graph"
        data-sidebar-menu="graph"
        {...menuTrigger('graph')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/graph`)}
        aria-current={graphActive ? 'page' : undefined}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          graphActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <GraphIcon size={16} />
        {t('sidebar.graph')}
        <MenuShortcut id="app.graph" className="text-sub/70" />
      </button>
    ),
    tags: (
      <button
        key="tags"
        data-sidebar-menu="tags"
        {...menuTrigger('tags')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/tags`)}
        aria-current={tagsActive ? 'page' : undefined}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          tagsActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <TagIcon size={16} />
        {t('sidebar.tags')}
      </button>
    ),
    shared: (
      <button
        key="shared"
        data-sidebar-menu="shared"
        {...menuTrigger('shared')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/shared`)}
        aria-current={sharedActive ? 'page' : undefined}
        title={t('sidebar.webSharesTitle')}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          sharedActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <GlobeIcon size={16} />
        <span className="flex-1 text-left">{t('sidebar.webShares')}</span>
        {sharedCount > 0 && <span className="text-xs text-sub">{sharedCount}</span>}
      </button>
    ),
    due: (
      <button
        key="due"
        data-sidebar-menu="due"
        {...menuTrigger('due')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/due`)}
        aria-current={dueActive ? 'page' : undefined}
        title={t('sidebar.dueTitle')}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          dueActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <AlarmIcon size={16} />
        <span className="flex-1 text-left">{t('sidebar.due')}</span>
        {dueBadge > 0 && (
          <span
            data-testid="due-badge"
            title={
              dueOverdue > 0
                ? t('sidebar.dueBadgeOverdue', { overdue: dueOverdue, today: dueBadge - dueOverdue })
                : t('sidebar.dueBadgeToday', { today: dueBadge })
            }
            className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-medium ${
              dueOverdue > 0 ? 'bg-red-500/15 text-red-500' : 'bg-hover text-sub'
            }`}
          >
            {dueBadge}
          </span>
        )}
      </button>
    ),
    calendar: (
      <button
        key="calendar"
        data-sidebar-menu="calendar"
        {...menuTrigger('calendar')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/calendar`)}
        aria-current={calendarActive ? 'page' : undefined}
        title={t('sidebar.calendarTitle')}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          calendarActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <CalendarIcon size={16} />
        {t('sidebar.calendar')}
      </button>
    ),
    activity: (
      <button
        key="activity"
        data-sidebar-menu="activity"
        {...menuTrigger('activity')}
        type="button"
        onClick={() => navigate(`/w/${wsId}/activity`)}
        aria-current={activityActive ? 'page' : undefined}
        title={t('activity.sidebarTitle')}
        className={`flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
          activityActive
            ? 'bg-active font-medium text-ink'
            : 'text-sub hover:bg-hover hover:text-ink'
        }`}
      >
        <HistoryIcon size={16} />
        {t('activity.title')}
      </button>
    ),
    today: (
      <button
        key="today"
        data-sidebar-menu="today"
        {...menuTrigger('today')}
        type="button"
        onClick={() => openDaily()}
        disabled={dailyBusy}
        title={t('sidebar.todayTitle')}
        className="flex w-full items-center gap-2 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
      >
        <CalendarDayIcon size={16} />
        {t('common.today')}
      </button>
    ),
  }

  return (
    <aside ref={asideRef} className="flex h-full flex-col bg-side transition-colors duration-200">
      <div className="p-2">
        {workspaces.data && <WorkspaceSwitcher wsId={wsId} workspaces={workspaces.data} />}
      </div>

      {/* Top menus: order and visibility follow the person's saved choice (docs/adr/1020-*). Right-click
          or long-press a menu to hide it; Settings → Sidebar brings it back. */}
      {guest && (
        <p className="mx-3 mb-1 rounded-md border border-line px-2 py-1.5 text-xs text-sub" data-testid="guest-note">
          {t('guest.workspaceNote')}
        </p>
      )}
      {!guest && visibleMenus.length > 0 && (
        <div ref={menusRef} className="px-2" data-testid="sidebar-menus">
          {menusOpen ? (
            <>
              <div
                ref={menusBoxRef}
                data-testid="sidebar-menus-open"
                onScroll={openScrolls ? updateOutOfView : undefined}
                className={openScrolls ? 'overflow-y-auto overscroll-contain' : undefined}
                style={openScrolls ? { maxHeight: openLayout!.maxHeight! } : undefined}
              >
                {visibleMenus.map((id) => menuButtons[id])}
              </div>
              {openScrolls && (
                // Height = MENUS_MORE_BELOW_ROW (h-6), which expandedMenusLayout keeps free for it.
                <button
                  type="button"
                  data-testid="sidebar-menus-below"
                  onClick={scrollOpenMenus}
                  className={`flex h-6 w-full items-center gap-1 rounded-md border-t border-line/60 px-2 text-xs transition-colors duration-150 hover:bg-hover hover:text-ink ${
                    hiddenOpenMenus.some((id) => menuActive[id]) ? 'font-medium text-ink' : 'text-sub'
                  }`}
                >
                  <ChevronDownIcon size={12} className={outOfView.below > 0 ? undefined : 'rotate-180'} />
                  <span className="flex-1 text-left">
                    {outOfView.below > 0
                      ? t('sidebar.menusBelow', { count: outOfView.below })
                      : t('sidebar.menusAbove', { count: outOfView.above })}
                  </span>
                  {hiddenOpenMenus.some((id) => menuBadge[id]) && <span className="h-2 w-2 rounded-full bg-red-500" />}
                </button>
              )}
            </>
          ) : (
            visibleMenus.slice(0, shownMenus).map((id) => menuButtons[id])
          )}
          {folding && (
            <button
              type="button"
              data-testid="sidebar-menus-more"
              aria-expanded={menusExpanded}
              onClick={toggleMenusExpanded}
              title={t('sidebar.moreMenusTitle')}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-hover hover:text-ink ${
                !menusExpanded && foldedMenus.some((id) => menuActive[id]) ? 'font-medium text-ink' : 'text-sub'
              }`}
            >
              <MoreHorizontalIcon size={16} />
              <span className="flex-1 text-left">
                {menusExpanded ? t('sidebar.lessMenus') : t('sidebar.moreMenus', { count: foldedMenus.length })}
              </span>
              {!menusExpanded && foldedMenus.some((id) => menuBadge[id]) && (
                <span data-testid="sidebar-menus-more-badge" className="h-2 w-2 rounded-full bg-red-500" />
              )}
            </button>
          )}
        </div>
      )}
      {menuCtx && isSidebarMenuId(menuCtx.id) && (
        <SidebarMenuPopup
          ctx={menuCtx}
          label={t(SIDEBAR_MENU_META[menuCtx.id].label)}
          onHide={() => hideMenu(menuCtx.id as SidebarMenuId)}
          onCustomize={() => navigate(`/w/${wsId}/settings#sidebar`)}
          onClose={closeMenuCtx}
        />
      )}

      {!guest && (
      <div ref={newMenuRef} className="relative flex gap-0.5 px-2 pb-1 pt-1">
        <button
          type="button"
          onClick={newPage}
          disabled={createPage.isPending || newPagePending}
          title={withShortcut(t('sidebar.newPage'), 'app.newPage')}
          className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          {createPage.isPending || newPagePending ? <Spinner size={16} /> : <PlusIcon size={16} />}
          {t('sidebar.newPage')}
        </button>
        <button
          type="button"
          onClick={() => setNewMenuOpen((v) => !v)}
          disabled={createPage.isPending}
          aria-label={t('sidebar.newItemKind')}
          title={t('sidebar.newItemKind')}
          className="flex items-center justify-center rounded-md px-1.5 py-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          <ChevronDownIcon size={16} />
        </button>
        {newMenuOpen && (
          <div
            ref={newMenuPopRef}
            data-testid="sidebar-new-menu"
            style={{ maxHeight: newMenuPlace?.maxHeight, visibility: newMenuPlace ? 'visible' : 'hidden' }}
            className={`nd-pop absolute right-2 z-40 w-44 overflow-y-auto rounded-md border border-line bg-app py-1 shadow-xl ${
              newMenuPlace?.up ? 'bottom-full mb-1 origin-bottom-right' : 'top-full mt-1 origin-top-right'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                setNewMenuOpen(false)
                newPage()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <FileTextIcon size={15} /> {t('palette.newDoc')}
              <MenuShortcut id="app.newPage" />
            </button>
            <button
              type="button"
              onClick={newFolder}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <FolderPlusIcon size={15} /> {t('palette.newFolder')}
            </button>
            <button
              type="button"
              onClick={newDatabase}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <DatabaseIcon size={15} /> {t('palette.newDatabase')}
            </button>
            <button
              type="button"
              onClick={newCanvas}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <CanvasIcon size={15} /> {t('palette.newCanvas')}
            </button>
            <div className="my-1 border-t border-line" />
            <button
              type="button"
              onClick={() => {
                setNewMenuOpen(false)
                onOpenTemplates()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <TemplateIcon size={15} /> {t('sidebar.fromTemplate')}
            </button>
          </div>
        )}
      </div>
      )}

      <nav ref={navRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1" style={{ minHeight: navMin || undefined }} data-testid="sidebar-tree">
        {/* ⭐ Favorites — above the Shared/Private sections. Hidden when empty. */}
        {(bookmarks.data?.length ?? 0) > 0 && (
          <div className="mb-1 flex flex-col">
            <button
              type="button"
              onClick={toggleFav}
              className="flex items-center gap-1 rounded px-1 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-sub hover:text-ink"
            >
              <span
                className={`inline-flex transition-transform duration-200 ease-out ${
                  favCollapsed ? '' : 'rotate-90'
                }`}
              >
                <ChevronRightIcon size={12} />
              </span>
              <span className="leading-none">⭐</span>
              <span className="truncate">{t('sidebar.favorites')}</span>
            </button>
            {!favCollapsed && (
              <div className="nd-enter">
                {bookmarks.data!.map((b) => {
                  const active = location.pathname === `/w/${wsId}/p/${b.pageId}`
                  return (
                    <button
                      key={b.pageId}
                      type="button"
                      onClick={() => navigate(`/w/${wsId}/p/${b.pageId}`)}
                      title={b.title || t('common.untitled')}
                      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors pointer-coarse:min-h-10 duration-150 ${
                        active
                          ? 'bg-active text-ink'
                          : 'text-sub hover:bg-hover hover:text-ink'
                      }`}
                    >
                      <span className="shrink-0 text-[15px] leading-none">
                        <PageIconGlyph page={b} size={15} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">
                        {b.title || t('common.untitled')}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {pages.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner size={18} />
          </div>
        ) : (
          <PageTree wsId={wsId} pages={pages.data ?? []} onNewPage={newPageInScope} guest={guest} />
        )}
      </nav>

      {!compactFooter && <OnboardingSidebarEntry wsId={wsId} fit={layout?.card ?? null} onSize={setCardSize} />}
      {compactFooter ? (
        // Short sidebar (a tablet in landscape with the browser's bars, an in-app browser): the footer is
        // one row of icons so the page tree keeps its room (docs/adr/1640-*).
        <div className="flex flex-wrap items-center justify-between gap-0.5 border-t border-line px-2 py-1" data-testid="sidebar-footer-compact">
          {!guest && (
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              title={t('sidebar.trash')}
              aria-label={t('sidebar.trash')}
              className={footerIcon}
            >
              <TrashIcon size={16} />
            </button>
          )}
          {me.data?.isAdmin && (
            <button
              type="button"
              onClick={() => navigate(`/w/${wsId}/admin`)}
              title={t('sidebar.admin')}
              aria-label={t('sidebar.admin')}
              className={`relative ${footerIcon}`}
            >
              <KeyIcon size={16} />
              {!!me.data?.pendingResetRequests && (
                <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500" title={t('sidebar.pendingResets')} />
              )}
            </button>
          )}
          <button type="button" onClick={onOpenHelp} title={withShortcut(t('sidebar.shortcuts'), 'app.help')} aria-label={t('sidebar.shortcuts')} className={footerIcon}>
            <KeyboardIcon size={16} />
          </button>
          <button
            type="button"
            onClick={() => navigate(`/w/${wsId}/settings`)}
            aria-current={settingsActive ? 'page' : undefined}
            title={withShortcut(t('common.settings'), 'app.settings')}
            aria-label={t('common.settings')}
            className={`${footerIcon} ${settingsActive ? 'bg-active text-ink' : ''}`}
          >
            <SettingsIcon size={16} />
          </button>
          {!guest && (
            <button
              type="button"
              onClick={copyLink}
              title={copied === 'ok' ? t('members.copied') : copied === 'fail' ? t('members.copyFailed') : t('members.copyInvite')}
              aria-label={t('members.copyInvite')}
              className={footerIcon}
            >
              <CopyIcon size={15} />
            </button>
          )}
          <span
            role="img"
            title={[me.data?.name, me.data?.email].filter(Boolean).join('\n') || t('sidebar.account')}
            aria-label={`${t('sidebar.account')}: ${me.data?.name ?? t('sidebar.userFallback')}`}
            className="flex items-center justify-center p-1.5 text-sub pointer-coarse:p-2"
          >
            <UserIcon size={16} />
          </span>
          <button type="button" onClick={doLogout} title={t('sidebar.logout')} aria-label={t('sidebar.logout')} className={footerIcon}>
            <LogOutIcon size={16} />
          </button>
        </div>
      ) : (
        <>
        <div className="px-2 pb-1">
          {!guest && (
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <TrashIcon size={16} />
              {t('sidebar.trash')}
            </button>
          )}
          {me.data?.isAdmin && (
            <button
              type="button"
              onClick={() => navigate(`/w/${wsId}/admin`)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <KeyIcon size={16} />
              {t('sidebar.admin')}
              {!!me.data?.pendingResetRequests && (
                <span
                  className="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                  title={t('sidebar.pendingResets')}
                >
                  {me.data.pendingResetRequests}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onOpenHelp}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <KeyboardIcon size={16} />
            {t('sidebar.shortcuts')}
            <MenuShortcut id="app.help" className="text-sub/70" />
          </button>
          <button
            type="button"
            onClick={() => navigate(`/w/${wsId}/settings`)}
            aria-current={settingsActive ? 'page' : undefined}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
              settingsActive
                ? 'bg-active font-medium text-ink'
                : 'text-sub hover:bg-hover hover:text-ink'
            }`}
          >
            <SettingsIcon size={16} />
            {t('common.settings')}
            <MenuShortcut id="app.settings" className="text-sub/70" />
          </button>
        </div>

        <div className="border-t border-line p-2">
          <div className="mb-2 px-1">
            <div className="truncate text-sm font-medium text-ink">
              {me.data?.name ?? t('sidebar.userFallback')}
            </div>
            <div className="truncate text-xs text-sub">{me.data?.email}</div>
          </div>
          <div className="flex items-center gap-1">
            {guest ? (
              <span className="flex-1" />
            ) : (
            <button
              type="button"
              onClick={copyLink}
              className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
              title={t('members.copyInvite')}
            >
              <CopyIcon size={15} />
              <span key={copied ?? 'idle'} className="nd-fade">
                {copied === 'ok' ? t('members.copied') : copied === 'fail' ? t('members.copyFailed') : t('members.copyInvite')}
              </span>
            </button>
            )}
            <button
              type="button"
              onClick={doLogout}
              className="flex items-center justify-center rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
              title={t('sidebar.logout')}
              aria-label={t('sidebar.logout')}
            >
              <LogOutIcon size={16} />
            </button>
          </div>
        </div>
        </>
      )}

      {!guest && <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} wsId={wsId} />}
    </aside>
  )
}
