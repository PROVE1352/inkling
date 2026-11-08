import { useCallback, useEffect, useState } from 'react'
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
import { isMac, isMod, isTypingElement } from '../lib/platform'
import { getActiveEditor } from '../lib/activeEditor'
import { consumeAppEntry } from '../lib/prefs'
import { useNewPage } from '../lib/newPage'
import { Sidebar } from './Sidebar'
import { NotificationBell } from './NotificationBell'
import { SearchModal, type SearchMode } from './SearchModal'
import { ConfirmDialog } from './ConfirmDialog'
import { EmailVerifyBanner } from './EmailVerifyBanner'
import { AdminStatusBanner } from '../status/AdminStatusBanner'
import { TwoFactorBanner, TwoFactorGate, useTwoFactorRequiredListener } from './TwoFactorRequired'
import { useHistoryNav } from './NavButtons'
import { requestPropsFocus } from '../lib/propsFocus'
import { CommandPalette } from './CommandPalette'
import { ShortcutsModal } from './ShortcutsModal'
import { TemplateGalleryModal } from './TemplateGalleryModal'
import { TrashModal } from './TrashModal'
import { ToastContainer } from './Toast'
import { AppDnd } from './dnd/AppDnd'

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
  const histNav = useHistoryNav()
  const { create: newPage } = useNewPage(wsId ?? '')

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

  // Global shortcuts: ⌘K search, ⌘P command palette, ⌘\ toggle sidebar, ? help
  // + Obsidian-style: ⌘⌥←/→ back/forward, ⌘O quick switcher, ⌘⇧F full-text search, ⌘N (⌘⌥N) new page,
  //   ⌘, settings, ⌘G graph, F2 rename title, ⌘; properties, (inside the editor) ⌘L checkbox, ⌘D delete block.
  // With ⌥ on a Mac, e.key turns into a special character (˜ etc.), so letter keys are matched on e.code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMod(e)
      const code = e.code
      // Back/forward — Mac ⌘⌥←/→, Windows Alt+←/→ (standard) or Ctrl+Alt+←/→.
      const navCombo = isMac
        ? mod && e.altKey
        : e.altKey && !e.metaKey
      if (navCombo && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        if (e.key === 'ArrowLeft') histNav.back()
        else histNav.forward()
        return
      }
      if (guest && mod && !e.altKey && ['KeyO', 'KeyF', 'KeyN', 'KeyG', 'KeyK', 'KeyP'].includes(code)) {
        // Keep the browser's own shortcut where it has one; nothing of ours to open for a guest.
        return
      }
      if (mod && !e.altKey && !e.shiftKey && code === 'KeyO') {
        // Quick switcher instead of the browser's "Open file"
        e.preventDefault()
        openSearch('', 'title')
        return
      }
      if (mod && e.shiftKey && !e.altKey && code === 'KeyF') {
        e.preventDefault()
        openSearch('', 'all')
        return
      }
      if (mod && !e.shiftKey && code === 'KeyN') {
        // In a regular Safari tab the browser may grab ⌘N first → ⌘⌥N does the same (both work in the PWA).
        e.preventDefault()
        newPage()
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault()
        navigate(`/w/${wsId}/settings`)
        return
      }
      if (mod && !e.altKey && !e.shiftKey && code === 'KeyG') {
        // Graph instead of the browser's "Find next"
        e.preventDefault()
        navigate(`/w/${wsId}/graph`)
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.key === ';') {
        if (!location.pathname.includes('/p/')) return
        e.preventDefault()
        requestPropsFocus()
        return
      }
      if (e.key === 'F2' && !mod && !e.defaultPrevented) {
        // Skip if the tree already handled it as a rename of the selected row (defaultPrevented).
        const el = document.activeElement
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
        const title = document.querySelector<HTMLTextAreaElement>('textarea[data-page-title]')
        if (!title) return
        e.preventDefault()
        title.focus()
        title.select()
        return
      }
      if (mod && !e.altKey && !e.shiftKey && (code === 'KeyL' || code === 'KeyD')) {
        // Only while the cursor is inside the document editor — outside, leave it to the browser default (address bar/bookmarks).
        const ed = getActiveEditor()?.editor
        if (!ed || !ed.isEditable || !ed.domElement?.contains(document.activeElement)) return
        e.preventDefault()
        try {
          const pos = ed.getTextCursorPosition()
          const block = pos.block
          if (code === 'KeyL') {
            if (block.type === 'checkListItem') {
              ed.updateBlock(block, { props: { checked: !block.props.checked } })
            } else if (
              block.type === 'paragraph' ||
              block.type === 'bulletListItem' ||
              block.type === 'numberedListItem'
            ) {
              ed.updateBlock(block, { type: 'checkListItem', props: { checked: false } })
            }
          } else {
            const next = pos.nextBlock ?? pos.prevBlock
            ed.removeBlocks([block])
            if (next) ed.setTextCursorPosition(next, pos.nextBlock ? 'start' : 'end')
          }
        } catch {
          // moments when the cursor position cannot be resolved (table cell selection, etc.) — ignore
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openSearch()
      } else if (mod && e.key.toLowerCase() === 'p') {
        // Clashes with the browser's print shortcut, so preventDefault is required.
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        setCollapsedPersist(!collapsed)
      } else if (
        e.key === '?' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !search.open &&
        !isTypingElement(document.activeElement)
      ) {
        // Ignore while typing/editing or when the search modal is open.
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    openSearch,
    collapsed,
    setCollapsedPersist,
    search.open,
    histNav,
    newPage,
    navigate,
    wsId,
    location.pathname,
    guest,
  ])

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
          Outer: w-[260px]↔w-0 (overflow-hidden), inner: fixed 260px (keeps the content from squashing).
          When collapsed, inert blocks focus and clicks. */}
      <div
        className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out md:block ${
          collapsed ? 'w-0' : 'w-[260px] border-r border-line'
        }`}
      >
        <div className="h-full w-[260px]" inert={collapsed}>
          <Sidebar
            wsId={wsId}
            onOpenSearch={() => openSearch()}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenTemplates={() => setTemplatesOpen(true)}
          />
        </div>
      </div>

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
        <AdminStatusBanner />
        <EmailVerifyBanner />
        <TwoFactorBanner wsId={wsId} />
        <Outlet
          context={
            { onToggleSidebar, openSearch } satisfies LayoutContext
          }
        />
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

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        wsId={wsId}
        onOpenSearch={openSearch}
        onToggleSidebar={onToggleSidebar}
        onOpenTrash={() => setTrashOpen(true)}
        onOpenTemplates={() => setTemplatesOpen(true)}
      />

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
      <ToastContainer />
    </div>
    </AppDnd>
  )
}
