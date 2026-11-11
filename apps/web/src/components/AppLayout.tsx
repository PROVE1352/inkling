import { StorageFullNotice } from './quota/StorageFullNotice'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useMe, useWorkspaces } from '../api'
import { useShortcutDispatcher } from '../lib/shortcuts'
import { consumeAppEntry, setPref, usePrefs } from '../lib/prefs'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  dragSidebarWidth,
  sidebarWidthForKey,
} from '../lib/sidebarWidth'
import { useT } from '../i18n'
import { ResizeHandle } from './ResizeHandle'
import { Sidebar } from './Sidebar'
import { NotificationBell } from './NotificationBell'
import { SearchModal, type SearchMode } from './SearchModal'
import { ConfirmDialog } from './ConfirmDialog'
import { OfflineBanner } from '../lib/offline/OfflineBanner'
import { EmailVerifyBanner } from './EmailVerifyBanner'
import { AdminStatusBanner } from '../status/AdminStatusBanner'
import { TwoFactorBanner, TwoFactorGate, useTwoFactorRequiredListener } from './TwoFactorRequired'
import { useAppCommands } from './appCommands'
import { CommandPalette } from './CommandPalette'
import { ShortcutsModal } from './ShortcutsModal'
import { TemplateGalleryModal } from './TemplateGalleryModal'
import { TrashModal } from './TrashModal'
import { ToastContainer } from './Toast'
import { AppDnd } from './dnd/AppDnd'
import { AppErrorBoundary } from './AppErrorBoundary'
import { OnboardingHost } from '../onboarding/Host'
import { InstanceBadge } from './InstanceBadge'
import { AccountExpiry } from './AccountExpiry'

export type LayoutContext = {
  onToggleSidebar: () => void
  openSearch: (q?: string, mode?: SearchMode) => void
}

/** Screens of a workspace a guest cannot use (every call there answers 403, docs/adr/1252-*). */
const GUEST_BLOCKED_SCREENS = /^\/(activity|calendar|due|graph|workspace-settings|shared|tags)(\/|$)/

export function useLayout(): LayoutContext {
  return useOutletContext<LayoutContext>()
}

function isDesktop() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
}

// M16: inbox channel subscriber that applies my notifications immediately (renders nothing).
// When the server sends a stateless {t:'notifications'} on the `inbox:<userId>` document,
// the notification cache is invalidated right away instead of waiting for the 30-second poll.
// Same race-safe lifecycle as CollabEditor: create with connect:false, attach onStateless
// (registered at construction → attached before connect), then connect manually after mount.
// Keyed by me.id so the provider is recreated from scratch when the signed-in user changes.
function InboxRealtime({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  // The inbox channel rides on the tab-wide collab socket (lib/collabSocket.ts,
  // docs/adr/0702-*). Created in the effect (never during render) and released on unmount.
  // yjs + the Hocuspocus provider load on demand so they stay out of the entry chunk
  // (docs/adr/0704-*); the editor chunk needs them anyway.
  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | null = null
    void Promise.all([import('yjs'), import('../lib/collabSocket')]).then(([Y, { openCollab }]) => {
      if (cancelled) return
      const doc = new Y.Doc()
      const handle = openCollab({
        name: `inbox:${userId}`,
        document: doc,
        userKey: userId,
        onStateless: ({ payload }) => {
          try {
            if (JSON.parse(payload)?.t === 'notifications') {
              queryClient.invalidateQueries({ queryKey: qk.notifications })
              // A reply in a followed thread or a Later reminder (docs/adr/1411-*, 1412-*): badges in the sidebar.
              queryClient.invalidateQueries({ queryKey: ['threads'] })
              queryClient.invalidateQueries({ queryKey: ['later'] })
              // It may be a "you were added to a workspace" notification → refresh the switcher list too
              queryClient.invalidateQueries({ queryKey: qk.workspaces })
            }
          } catch {
            // ignore malformed payloads
          }
        },
      })
      cleanup = () => {
        handle.release()
        doc.destroy()
      }
    })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [userId, queryClient])

  return null
}

export function AppLayout() {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const workspaces = useWorkspaces()
  useTwoFactorRequiredListener()
  const twoFactorWs = workspaces.data?.find((w) => w.id === wsId)
  // Guest (docs/adr/1252-*): search, the palette, templates, trash, graph and top-level pages are
  // member features the server refuses, so their shortcuts and dialogs are off.
  const guest = twoFactorWs?.role === 'guest'
  const me = useMe()
  const t = useT()
  // Desktop sidebar width (per device, docs/adr/1350-*). A drag writes --sidebar-w on the shell once per
  // frame and saves the preference once on release, so nothing re-renders while the edge moves.
  const sidebarWidth = usePrefs().sidebarWidth
  const sidebarShellRef = useRef<HTMLDivElement>(null)
  const previewSidebar = (w: number) => sidebarShellRef.current?.style.setProperty('--sidebar-w', `${w}px`)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('inkling:sidebar') === '1'
    } catch {
      return false
    }
  })
  const [search, setSearch] = useState<{ open: boolean; q: string; mode: SearchMode }>({
    open: false,
    q: '',
    mode: 'all',
  })
  const [helpOpen, setHelpOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)

  const setCollapsedPersist = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      localStorage.setItem('inkling:sidebar', next ? '1' : '0')
    } catch {
      // ignore
    }
  }, [])

  // Desktop: toggle sidebar collapse / mobile: toggle the drawer
  const onToggleSidebar = useCallback(() => {
    if (isDesktop()) setCollapsedPersist(!collapsed)
    else setDrawerOpen((o) => !o)
  }, [collapsed, setCollapsedPersist])

  const openSearch = useCallback(
    (q = '', mode: SearchMode = 'all') => setSearch({ open: true, q, mode }),
    [],
  )

  // The "page to open on startup" applies only to the first entry — the workspace home (index) consumes it
  // during render; if the app was entered on another screen, use it up here so pressing Home later does not redirect.
  useEffect(() => {
    consumeAppEntry()
  }, [])

  // External links (http/https on another origin) open in a new window — an installed PWA that navigates
  // away in its app window has no way back. BlockNote already opens editor links with target=_blank and
  // prevents the default, so this only catches the rest (public view HTML, comments, etc.) that are neither
  // defaultPrevented nor target=_blank.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      let url: URL
      try {
        url = new URL(a.href, window.location.href)
      } catch {
        return
      }
      if (!/^https?:$/.test(url.protocol) || url.origin === window.location.origin) return
      e.preventDefault()
      window.open(url.href, '_blank', 'noopener,noreferrer')
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Validate + store lastWs (a wsId not in my list → go home)
  useEffect(() => {
    if (!wsId || !workspaces.data) return
    if (!workspaces.data.some((w) => w.id === wsId)) {
      navigate('/', { replace: true })
      return
    }
    try {
      localStorage.setItem('inkling:lastWs', wsId)
    } catch {
      // ignore storage failures
    }
  }, [wsId, workspaces.data, navigate])

  // Close the mobile drawer on route change
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // Every app shortcut (⌘K, ⌘P, ⌘\\, ?, ⌘⌥←/→, …) is a registry command (lib/shortcuts/registry.ts,
  // docs/adr/1400-*): one window listener matches the keys, these handlers carry them out.
  useShortcutDispatcher()
  useAppCommands({
    wsId: wsId ?? '',
    guest,
    openSearch,
    toggleSidebar: onToggleSidebar,
    togglePalette: () => setPaletteOpen((o) => !o),
    openHelp: () => setHelpOpen(true),
    openTrash: () => setTrashOpen(true),
    openTemplates: () => setTemplatesOpen(true),
  })

  if (!wsId) return <Navigate to="/" replace />
  // "Require two-step verification" (docs/adr/1112-*): once it blocks me, only the setup screen.
  if (twoFactorWs?.twoFactor?.state === 'blocked') return <TwoFactorGate ws={twoFactorWs} />
  // A guest opening a member-only screen by address (graph, tags, activity, …) goes to the workspace home.
  if (guest && GUEST_BLOCKED_SCREENS.test(location.pathname.slice(`/w/${wsId}`.length))) {
    return <Navigate to={`/w/${wsId}`} replace />
  }

  return (
    <AppDnd wsId={wsId}>
    <div className="flex h-full">
      {/* Fixed desktop sidebar — collapses with a width transition.
          Outer: var(--sidebar-w)↔0 (overflow-hidden), inner: fixed var(--sidebar-w) (keeps the content
          from squashing). When collapsed, inert blocks focus and clicks. The width is the device's
          preference (200–480 px, dragged on the edge below, docs/adr/1350-*). */}
      <div
        ref={sidebarShellRef}
        data-sidebar-shell
        className={`nd-sidebar-shell hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out md:block ${
          collapsed ? '' : 'border-r border-line'
        }`}
        style={
          {
            '--sidebar-w': `${sidebarWidth}px`,
            width: collapsed ? 0 : 'var(--sidebar-w)',
          } as React.CSSProperties
        }
      >
        <div className="h-full w-[var(--sidebar-w)]" inert={collapsed}>
          <Sidebar
            wsId={wsId}
            onOpenSearch={() => openSearch()}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenTemplates={() => setTemplatesOpen(true)}
          />
        </div>
      </div>

      {/* Resize handle on the sidebar's right edge: a zero-width flex item, so the 6 px hit area straddles
          the border without being clipped by the sidebar's overflow. Not there when collapsed or on
          phones (the drawer keeps its own width). */}
      {!collapsed && (
        <div className="relative z-30 hidden w-0 shrink-0 md:block">
          <ResizeHandle
            label={t('sidebar.resize')}
            value={sidebarWidth}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            className="absolute inset-y-0 -left-[3px] w-[6px] cursor-col-resize touch-none outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 active:bg-accent/60"
            startWidth={() => sidebarShellRef.current?.getBoundingClientRect().width ?? sidebarWidth}
            clamp={(w) => dragSidebarWidth(w, 0)}
            onPreview={previewSidebar}
            onEnd={() => previewSidebar(sidebarWidth)}
            onCommit={(w) => setPref('sidebarWidth', w)}
            onReset={() => setPref('sidebarWidth', SIDEBAR_DEFAULT)}
            onKey={(key, shift) => sidebarWidthForKey(key, sidebarWidth, shift)}
          />
        </div>
      )}

      {/* Mobile overlay drawer (open motion: backdrop fade + panel slide) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="nd-backdrop absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="nd-drawer-l absolute inset-y-0 left-0 w-[280px] max-w-[85%] border-r border-line bg-side pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-xl">
            <Sidebar
              wsId={wsId}
              onOpenSearch={() => openSearch()}
              onOpenHelp={() => setHelpOpen(true)}
              onOpenTemplates={() => setTemplatesOpen(true)}
            />
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* restricted mode (docs/adr/2500-*): instance label and account expiry, nothing when not set */}
        <InstanceBadge placement="banner" />
        <AccountExpiry placement="banner" />
        <StorageFullNotice wsId={wsId} />
        <AdminStatusBanner />
        <EmailVerifyBanner />
        <TwoFactorBanner wsId={wsId} />
        <OfflineBanner />
        {/* a page that cannot be drawn keeps the sidebar; moving to another page tries again (docs/adr/2324-*) */}
        <AppErrorBoundary inline resetKey={location.pathname}>
          <Outlet
            context={
              { onToggleSidebar, openSearch } satisfies LayoutContext
            }
          />
        </AppErrorBoundary>
      </main>

      {/* Global notification bell — all my notifications regardless of workspace (fixed top-right). */}
      <NotificationBell wsId={wsId} />

      {/* M16: inbox channel subscription — applies notifications immediately (renders nothing). Recreated via key when me changes. */}
      {me.data && <InboxRealtime key={me.data.id} userId={me.data.id} />}

      {!guest && (
      <>
      <SearchModal
        open={search.open}
        onClose={() => setSearch((s) => ({ ...s, open: false }))}
        wsId={wsId}
        initialQuery={search.q}
        mode={search.mode}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} wsId={wsId} />

      <TemplateGalleryModal
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        wsId={wsId}
      />

      <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} wsId={wsId} />
      </>
      )}

      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ConfirmDialog />
      <OnboardingHost wsId={wsId} />
      <ToastContainer />
    </div>
    </AppDnd>
  )
}
