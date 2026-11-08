import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { SIDEBAR_MENU_IDS, type PageScope, type SidebarMenuId } from '@inkling/shared'
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
import { modKey } from '../lib/platform'
import { useT } from '../i18n'
import { useSaveSidebarPrefs, useSidebarPrefs } from '../sidebarApi'
import { resolveSidebarMenu, setEntryHidden, toSidebarPrefs, visibleSidebarMenu } from '../lib/sidebarMenu'
import { toast } from '../lib/toast'
import { SIDEBAR_MENU_META, isSidebarMenuId } from './sidebarMenus'
import { SidebarMenuPopup, useMenuContextTrigger, type MenuCtx } from './SidebarMenuContext'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { PageTree } from './PageTree'
import { TrashModal } from './TrashModal'
import { Spinner } from './Spinner'
import {
  AlarmIcon,
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
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
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

  const doLogout = () => {
    logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) })
  }

  // Top menus (docs/adr/1020-*): saved order/visibility from the server, merged with this build's menus.
  const sidebarPrefs = useSidebarPrefs()
  const saveSidebar = useSaveSidebarPrefs()
  const visibleMenus = visibleSidebarMenu(sidebarPrefs, SIDEBAR_MENU_IDS) as SidebarMenuId[]
  const [menuCtx, setMenuCtx] = useState<MenuCtx | null>(null)
  const closeMenuCtx = useCallback(() => setMenuCtx(null), [])
  const menuTrigger = useMenuContextTrigger(setMenuCtx)
  const hideMenu = (id: SidebarMenuId) => {
    const prev = sidebarPrefs
    const next = toSidebarPrefs(
      setEntryHidden(resolveSidebarMenu(prev, SIDEBAR_MENU_IDS), id, true),
      SIDEBAR_MENU_IDS,
      prev,
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
        <span className="ml-auto text-xs text-sub/70">{modKey('K')}</span>
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
    <aside className="flex h-full flex-col bg-side transition-colors duration-200">
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
        <div className="px-2" data-testid="sidebar-menus">
          {visibleMenus.map((id) => menuButtons[id])}
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
          title={`${t('sidebar.newPage')} (${modKey('N')})`}
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
          <div className="nd-pop absolute right-2 top-full z-40 mt-1 w-44 origin-top-right overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
            <button
              type="button"
              onClick={() => {
                setNewMenuOpen(false)
                newPage()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
            >
              <FileTextIcon size={15} /> {t('palette.newDoc')}
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

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
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
          <span className="ml-auto text-xs text-sub/70">?</span>
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
          <span className="ml-auto text-xs text-sub/70">{modKey(',')}</span>
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

      {!guest && <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} wsId={wsId} />}
    </aside>
  )
}
