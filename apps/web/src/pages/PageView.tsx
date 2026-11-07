import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router'
import { useDroppable } from '@dnd-kit/core'
import type { PageMetaDTO } from '@inkling/shared'
import {
  recordPageView,
  useBookmarks,
  useMe,
  usePages,
  useShareStatus,
  useToggleBookmark,
  useUpdatePage,
} from '../api'
import { setActiveEditor } from '../lib/activeEditor'
import { setLastPage, usePrefs } from '../lib/prefs'
import { appendFilesToEditor, useFileDropZone } from '../lib/fileDrop'
import { InkLayer } from '../components/ink/InkLayer'
import { pageIcon } from '../lib/pageIcon'
import { modKey } from '../lib/platform'
import { EDITOR_DROP_ID } from '../components/dnd/AppDnd'
import { useLayout } from '../components/AppLayout'
import { Breadcrumb } from '../components/Breadcrumb'
import { EmojiPicker } from '../components/EmojiPicker'
import { PageCover } from '../components/PageCover'
import {
  CollabEditor,
  type CollabState,
  type ConnStatus,
  type InklingEditor,
} from '../components/CollabEditor'
import { FolderView } from '../components/FolderView'
import { RightPanel } from '../components/RightPanel'
import { ShareModal } from '../components/ShareModal'
import { CommentBadges } from '../components/comments/CommentBadges'
import { OnlineUsers } from '../components/OnlineUsers'
import { ThemeToggle } from '../components/ThemeToggle'
import { Spinner } from '../components/Spinner'
import { NavButtons } from '../components/NavButtons'
import { WordCount } from '../components/WordCount'
import { LinkPreview } from '../components/LinkPreview'
import { ExportPdfButton, PrinterIcon, exportPdfLabel } from '../components/ExportPdfButton'
import { printElement } from '../lib/printPage'
import {
  GlobeIcon,
  LinkIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PenIcon,
  SunIcon,
} from '../components/Icons'
import { setTheme, useTheme, type Theme } from '../lib/theme'
import { reloadOnceForStaleChunk } from '../lib/pwa'
import { t as tr, useT, type TKey } from '../i18n'


// Database views and the canvas (React Flow + d3) are separate chunks: a plain doc page never
// downloads them (docs/adr/0704-route-and-feature-code-splitting.md).
const CollectionView = lazy(() =>
  import('../components/collection/CollectionView').then((m) => ({ default: m.CollectionView }), reloadOnceForStaleChunk),
)
const CanvasView = lazy(() =>
  import('../components/canvas/CanvasView').then((m) => ({ default: m.CanvasView }), reloadOnceForStaleChunk),
)
const viewFallback = (
  <div className="flex justify-center py-10">
    <Spinner size={22} />
  </div>
)

// Labels are dictionary keys, translated at render.
const STATUS_STYLE: Record<ConnStatus, { dot: string; label: TKey }> = {
  connected: { dot: 'bg-green-500', label: 'page.statusConnected' },
  connecting: { dot: 'bg-yellow-500', label: 'page.statusConnecting' },
  disconnected: { dot: 'bg-red-500', label: 'page.statusDisconnected' },
}

function StatusDot({ status }: { status: ConnStatus }) {
  const t = useT()
  const s = STATUS_STYLE[status]
  const label = t(s.label)
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 rounded-full transition-colors duration-300 ${s.dot}`}
    />
  )
}

const THEME_LABEL: Record<Theme, TKey> = { light: 'page.themeLight', dark: 'page.themeDark', system: 'page.themeSystem' }
const THEME_ORDER: Theme[] = ['light', 'dark', 'system']
const nextTheme = (t: Theme) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]

type HeaderMenuItem = {
  label: string
  icon: ReactNode
  active?: boolean
  onSelect: () => void
  /** Items that can be pressed repeatedly (like cycling the theme) keep the menu open */
  keepOpen?: boolean
}

// Phone top bar ⋯ menu — folds pen/share/panel/theme away to leave room for the title (breadcrumb).
// Body portal + fixed. The whole app is inside a dnd-kit context, so stopPropagation keeps the menu's
// pointerdown from leaking into the tree drag sensor (lesson learned in this codebase).
function PageHeaderMenu({ items, footer }: { items: HeaderMenuItem[]; footer?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (b) setPos({ top: b.bottom + 4, right: Math.max(8, window.innerWidth - b.right) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={tr('common.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr('common.more')}
        className={`shrink-0 rounded-md p-1.5 transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] sm:hidden ${
          open ? 'bg-hover text-ink' : 'text-sub'
        }`}
      >
        <MoreHorizontalIcon size={18} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onPointerDown={(e) => e.stopPropagation()}
            style={{ top: pos.top, right: pos.right }}
            className="nd-pop fixed z-50 w-60 max-w-[calc(100vw-1rem)] origin-top-right overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  it.onSelect()
                  if (!it.keepOpen) setOpen(false)
                }}
                className={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm transition-colors hover:bg-hover ${
                  it.active ? 'text-accent' : 'text-ink'
                }`}
              >
                <span className="flex w-5 shrink-0 justify-center text-sub">{it.icon}</span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
              </button>
            ))}
            {footer}
          </div>,
          document.body,
        )}
    </>
  )
}

// The title input is fully remounted per page via key={page.id}, so no state lingers.
function TitleInput({
  page,
  onCommit,
  onEnter,
}: {
  page: PageMetaDTO
  onCommit: (title: string) => void
  onEnter: () => void
}) {
  const [title, setTitle] = useState(page.title)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    document.title = `${title || tr('common.untitled')} · Inkling`
  }, [title])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const onChange = (value: string) => {
    setTitle(value)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => onCommit(value), 500)
  }

  // Long titles used to be clipped in a single-line input → wrapping textarea. Height is refitted whenever content/width changes.
  // (Width changes: rotation, sidebar toggle, opening the panel → ResizeObserver)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fit = useCallback(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  useLayoutEffect(fit, [title, fit])
  useEffect(() => {
    const el = areaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  return (
    <textarea
      ref={areaRef}
      rows={1}
      value={title}
      // The title is a single-line value — pasted newlines become spaces.
      onChange={(e) => onChange(e.target.value.replace(/\r?\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter()
        }
      }}
      placeholder={tr('common.untitled')}
      data-page-title
      className="mb-2 block w-full resize-none overflow-hidden border-none bg-transparent text-[1.75rem] font-bold leading-tight text-ink placeholder:text-sub/50 focus-visible:outline-none sm:text-4xl sm:leading-tight"
    />
  )
}

// Cover + emoji icon + title, together. Each kind branch renders this instead of TitleInput.
// The outer wrapper remounts via key={page.id}, so state here (the emoji popover) resets too.
function PageHeading({
  wsId,
  page,
  onCommit,
  onEnter,
}: {
  wsId: string
  page: PageMetaDTO
  onCommit: (title: string) => void
  onEnter: () => void
}) {
  const updatePage = useUpdatePage(wsId)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const iconBtnRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <PageCover wsId={wsId} page={page} />
      <button
        ref={iconBtnRef}
        type="button"
        onClick={() => setEmojiOpen((v) => !v)}
        aria-label={tr('page.changeIcon')}
        title={tr('page.changeIcon')}
        className="mb-1 flex h-12 w-12 items-center justify-center rounded-lg text-4xl leading-none transition-colors duration-150 hover:bg-hover"
      >
        {pageIcon(page)}
      </button>
      <TitleInput page={page} onCommit={onCommit} onEnter={onEnter} />
      {emojiOpen && (
        <EmojiPicker
          anchorRef={iconBtnRef}
          hasIcon={!!page.icon}
          onSelect={(icon) => updatePage.mutate({ id: page.id, input: { icon } })}
          onRemove={() => updatePage.mutate({ id: page.id, input: { icon: null } })}
          onClose={() => setEmojiOpen(false)}
        />
      )}
    </>
  )
}

// Doc body wrapper — dropping a sidebar page here makes AppDnd insert a wikilink.
// useDroppable(editor-drop) is registered only while this component is mounted (= the current page is a doc),
// so canvas/folder/collection pages have no editor-drop target.
// fullWidth=true drops the container's max-w (full width) and keeps only generous side padding.
function EditorDropZone({
  fullWidth,
  columnRef,
  children,
}: {
  fullWidth: boolean
  /** The ink layer uses this element as its "paper" to measure position and scale */
  columnRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: EDITOR_DROP_ID })
  return (
    <div
      ref={(el) => {
        setNodeRef(el)
        columnRef.current = el
      }}
      className={`group/page nd-enter mx-auto py-6 sm:py-10 ${
        fullWidth ? 'max-w-none px-4 sm:px-10' : 'max-w-4xl px-4 sm:px-6'
      } ${isOver ? 'rounded-md ring-2 ring-accent/40' : ''}`}
    >
      {children}
    </div>
  )
}

export function PageView() {
  const { wsId, pageId } = useParams()
  const { onToggleSidebar, openSearch } = useLayout()
  const me = useMe()
  const pages = usePages(wsId ?? '')
  const updatePage = useUpdatePage(wsId ?? '')
  const bookmarks = useBookmarks(wsId ?? '')
  const toggleBookmark = useToggleBookmark(wsId ?? '')
  const prefs = usePrefs()
  const { theme } = useTheme()

  const page = pages.data?.find((p) => p.id === pageId)
  // One view per page open → the page's read counter (totals only, docs/adr/0953-*)
  const pageLoaded = !!page
  useEffect(() => {
    if (pageId && pageLoaded) recordPageView(pageId)
  }, [pageId, pageLoaded])
  const isDoc = page?.kind === 'doc'
  const isCanvas = page?.kind === 'canvas'
  const isBookmarked = !!page && (bookmarks.data ?? []).some((b) => b.pageId === page.id)

  // M15 public sharing — doc/collection/folder can be published (lookup skipped for private pages). Drives the 🌐 indicator.
  const canShare = page?.kind === 'doc' || page?.kind === 'collection' || page?.kind === 'folder'
  const shareStatus = useShareStatus(page?.id, !!page && canShare && page.scope !== 'private')
  const isShared = !!shareStatus.data?.shared
  const [shareOpen, setShareOpen] = useState(false)

  const [collab, setCollab] = useState<CollabState>({
    status: 'connecting',
    synced: false,
    users: [],
  })
  const [editor, setEditor] = useState<InklingEditor | null>(null)
  const [rightOpen, setRightOpen] = useState(() => {
    // On phones/narrow tablets (<768px) the panel is an overlay covering the body, so restoring the saved
    // "open" state on every page open would hide the body each time → narrow screens always start closed.
    if (window.matchMedia('(max-width: 767.98px)').matches) return false
    try {
      return localStorage.getItem('inkling:rightPanel') === '1'
    } catch {
      return false
    }
  })

  // For "Page to open on launch: last" — remembered only when an existing page was actually opened.
  useEffect(() => {
    if (wsId && page?.id) setLastPage(wsId, page.id)
  }, [wsId, page?.id])

  // ⌘; (AppLayout global shortcut) → open the right panel at the properties section. RightPanel expands the section.
  useEffect(() => {
    const onProps = () => {
      setRightOpen(true)
      try {
        localStorage.setItem('inkling:rightPanel', '1')
      } catch {
        // ignore
      }
    }
    window.addEventListener('inkling:open-props', onProps)
    return () => window.removeEventListener('inkling:open-props', onProps)
  }, [])

  // Command palette "Open/close right panel"
  useEffect(() => {
    const onToggle = () => toggleRightRef.current()
    window.addEventListener('inkling:toggle-right', onToggle)
    return () => window.removeEventListener('inkling:toggle-right', onToggle)
  }, [])

  const toggleRight = () => {
    setRightOpen((v) => {
      const next = !v
      try {
        localStorage.setItem('inkling:rightPanel', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }

  const toggleRightRef = useRef(toggleRight)
  toggleRightRef.current = toggleRight

  const bodyRef = useRef<HTMLDivElement>(null)
  // Pen mode — when on, the body is locked and a pen layer sits on top (same idea as PDF annotation).
  const inkColumnRef = useRef<HTMLDivElement>(null)
  const [penMode, setPenMode] = useState(false)
  // Turn pen mode off when switching pages — prevents accidental strokes on another page.
  useEffect(() => setPenMode(false), [pageId])
  // Narrow screens: navigating to another page from the panel (backlinks etc.) closes the overlay panel to show the new body.
  useEffect(() => {
    if (window.matchMedia('(max-width: 767.98px)').matches) setRightOpen(false)
  }, [pageId])

  const handleCollab = useCallback((s: CollabState) => setCollab(s), [])
  const handleEditorReady = useCallback((e: InklingEditor | null) => setEditor(e), [])

  // OS file drop — accepts the whole body (title, cover margin and empty space below the text included).
  // Files dropped onto text are caught by BlockNote first and inserted in place, so they never reach here;
  // only files dropped outside it are appended to the end of the document. The cover band is intercepted by PageCover.
  const onDropFiles = useCallback(
    (files: File[]) => {
      if (!editor || !wsId || !pageId) return
      void appendFilesToEditor(editor, wsId, pageId, files)
    },
    [editor, wsId, pageId],
  )
  const dropActive = useFileDropZone(bodyRef, onDropFiles, isDoc && !!editor)

  // Share the active editor via a module store, for AppDnd (app-level DndContext) to use on body drops.
  // AppDnd is a route parent and can't see pageId, so pageId is stored too (for the self-drop no-op).
  useEffect(() => {
    if (isDoc && editor && pageId) {
      setActiveEditor({ editor, pageId })
      return () => setActiveEditor(null)
    }
    return
  }, [isDoc, editor, pageId])

  // Setting "Spell check" — sets the spellcheck attribute directly on the editor's contenteditable.
  // (Applied to the DOM to avoid touching CollabEditor options. ProseMirror only manages attributes it set itself.)
  useEffect(() => {
    const el = editor?.domElement
    if (!el) return
    el.setAttribute('spellcheck', prefs.spellcheck ? 'true' : 'false')
  }, [editor, prefs.spellcheck, penMode])

  const focusEditor = () => {
    const el = bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')
    el?.focus()
  }

  // Comment badge click → open the right panel (comments section) and scroll to that block.
  const openComments = useCallback((blockId: string) => {
    setRightOpen(true)
    try {
      localStorage.setItem('inkling:rightPanel', '1')
    } catch {
      // ignore
    }
    const el = bodyRef.current?.querySelector(`[data-id="${blockId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-14 sm:gap-2 sm:pl-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={tr('page.toggleSidebar')}
          title={tr('page.toggleSidebarHint', { shortcut: modKey('\\') })}
          className="rounded-md p-1.5 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        {page && wsId ? (
          <Breadcrumb wsId={wsId} page={page} pages={pages.data ?? []} />
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {page && (
          <button
            type="button"
            onClick={() => toggleBookmark.mutate(page)}
            aria-pressed={isBookmarked}
            aria-label={isBookmarked ? tr('page.unbookmark') : tr('page.bookmark')}
            title={isBookmarked ? tr('page.unbookmark') : tr('page.bookmark')}
            className={`rounded-md p-1.5 text-lg leading-none transition duration-150 hover:bg-hover active:scale-[.98] ${
              isBookmarked ? 'text-amber-500' : 'text-sub hover:text-ink'
            }`}
          >
            {isBookmarked ? '★' : '☆'}
          </button>
        )}
        {/* Secondary actions — on phones (<640px) they fold into the ⋯ menu (PageHeaderMenu) to leave room for the title. */}
        <div className="hidden sm:contents">
          {isDoc && (
            <button
              type="button"
              onClick={() => setPenMode((v) => !v)}
              aria-pressed={penMode}
              aria-label={tr('page.penMode')}
              title={penMode ? tr('page.penModeOffHint') : tr('page.penModeHint')}
              className={`rounded-md p-1.5 transition duration-150 hover:bg-hover active:scale-[.98] ${
                penMode ? 'bg-accent-soft text-accent' : 'text-sub hover:text-ink'
              }`}
            >
              <PenIcon size={18} />
            </button>
          )}
          {page && canShare && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label={tr('page.shareToWeb')}
              title={isShared ? tr('page.sharedToWeb') : tr('page.shareToWeb')}
              className={`rounded-md p-1.5 leading-none transition duration-150 hover:bg-hover active:scale-[.98] ${
                isShared ? 'text-accent' : 'text-sub hover:text-ink'
              }`}
            >
              {/* Same globe whether shared or not — accent color + small dot while shared */}
              <span className="relative block">
                <GlobeIcon size={18} />
                {isShared && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                )}
              </span>
            </button>
          )}
          {(isDoc || isCanvas) && <OnlineUsers users={collab.users} />}
          {(isDoc || isCanvas) && <StatusDot status={collab.status} />}
          {page && page.kind !== 'canvas' && page.kind !== 'folder' && (
            <ExportPdfButton onClick={() => printElement(bodyRef.current, page.title)} />
          )}
          <ThemeToggle />
          <button
            type="button"
            onClick={toggleRight}
            aria-label={tr('page.togglePanel')}
            title={tr('page.rightPanel')}
            className={`rounded-md p-1.5 transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] ${
              rightOpen ? 'text-accent' : 'text-sub'
            }`}
          >
            <PanelRightIcon size={18} />
          </button>
        </div>
        {(isDoc || isCanvas) && (
          <span className="flex shrink-0 sm:hidden">
            <StatusDot status={collab.status} />
          </span>
        )}
        <PageHeaderMenu
          items={[
            ...(isDoc
              ? [
                  {
                    label: penMode ? tr('page.penModeOff') : tr('page.penMode'),
                    icon: <PenIcon size={16} />,
                    active: penMode,
                    onSelect: () => setPenMode((v) => !v),
                  },
                ]
              : []),
            ...(page && canShare
              ? [
                  {
                    label: isShared ? tr('page.sharedToWeb') : tr('page.shareToWeb'),
                    icon: isShared ? <GlobeIcon size={16} className="text-accent" /> : <GlobeIcon size={16} />,
                    active: isShared,
                    onSelect: () => setShareOpen(true),
                  },
                ]
              : []),
            ...(page && page.kind !== 'canvas' && page.kind !== 'folder'
              ? [
                  {
                    label: exportPdfLabel(),
                    icon: <PrinterIcon size={16} />,
                    onSelect: () => printElement(bodyRef.current, page.title),
                  },
                ]
              : []),
            {
              label: rightOpen ? tr('page.closeRightPanel') : tr('page.openRightPanel'),
              icon: <PanelRightIcon size={16} />,
              active: rightOpen,
              onSelect: toggleRight,
            },
            {
              label: tr('page.themeCycle', { current: tr(THEME_LABEL[theme]), next: tr(THEME_LABEL[nextTheme(theme)]) }),
              icon: theme === 'light' ? <SunIcon size={16} /> : theme === 'dark' ? <MoonIcon size={16} /> : <MonitorIcon size={16} />,
              onSelect: () => setTheme(nextTheme(theme)),
              keepOpen: true,
            },
          ]}
          footer={
            (isDoc || isCanvas) && collab.users.length > 0 ? (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-sub">
                <OnlineUsers users={collab.users} />
                <span>{tr('page.onlineCount', { count: collab.users.length })}</span>
              </div>
            ) : null
          }
        />
      </header>

      {/* Body + right panel */}
      <div className="flex min-h-0 flex-1">
        {/* Non-scrolling wrapper — pins the word-count status line to the body's bottom right */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
        <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-y-auto">
          {dropActive && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-accent/40 bg-app/90 px-3 py-1 text-xs text-accent shadow-sm backdrop-blur">
              {tr('page.dropHint')}
            </div>
          )}
          {!me.data || (!page && pages.isFetching) ? (
            <div className="nd-fade flex justify-center py-16">
              <Spinner size={24} />
            </div>
          ) : !page ? (
            <div className="mx-auto max-w-4xl px-6 py-16 text-center text-sub">
              {tr('page.notFound')}
            </div>
          ) : page.kind === 'folder' ? (
            // Keyed wrapper — nd-enter replays on every page change.
            <div key={page.id} className="nd-enter">
              <div className="group/page mx-auto max-w-4xl px-4 pt-4 sm:px-6">
                <PageCover wsId={wsId ?? ''} page={page} />
              </div>
              <FolderView wsId={wsId ?? ''} page={page} />
            </div>
          ) : page.kind === 'collection' ? (
            // Key only on the wrapper — giving siblings the same key confuses React's keyed diff and
            // leaves old elements in the DOM in production builds (the cause of the stacked-title bug).
            <div key={page.id} className="group/page nd-enter mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
              <PageHeading
                wsId={wsId ?? ''}
                page={page}
                onCommit={(t) => {
                  if (pageId) updatePage.mutate({ id: pageId, input: { title: t } })
                }}
                onEnter={() => {}}
              />
              <Suspense fallback={viewFallback}>
                <CollectionView wsId={wsId ?? ''} pageId={page.id} />
              </Suspense>
            </div>
          ) : page.kind === 'canvas' ? (
            <div key={page.id} className="nd-enter flex h-full flex-col">
              <div className="group/page shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
                <PageHeading
                  wsId={wsId ?? ''}
                  page={page}
                  onCommit={(t) => {
                    if (pageId) updatePage.mutate({ id: pageId, input: { title: t } })
                  }}
                  onEnter={() => {}}
                />
              </div>
              <div className="min-h-0 flex-1">
                <Suspense fallback={viewFallback}>
                  <CanvasView
                    pageId={page.id}
                    wsId={wsId ?? ''}
                    me={me.data}
                    onCollabChange={handleCollab}
                  />
                </Suspense>
              </div>
            </div>
          ) : (
            // Key only on the wrapper (EditorDropZone) — giving siblings the same key confuses React's keyed
            // diff and leaves old elements in the DOM (the cause of the stacked-title bug).
            // The per-page "Full width" wins; otherwise follow the "Readable line length" setting (off = full width).
            <EditorDropZone
              key={page.id}
              fullWidth={page.fullWidth || !prefs.readableLineLength}
              columnRef={inkColumnRef}
            >
              <PageHeading
                wsId={wsId ?? ''}
                page={page}
                onCommit={(t) => {
                  if (pageId) updatePage.mutate({ id: pageId, input: { title: t } })
                }}
                onEnter={focusEditor}
              />
              <CollabEditor
                pageId={page.id}
                wsId={wsId ?? ''}
                me={me.data}
                onCollabChange={handleCollab}
                onEditorReady={handleEditorReady}
                readOnly={penMode}
              />
            </EditorDropZone>
          )}
        </div>

        {isDoc && editor && prefs.wordCount && <WordCount key={page?.id} editor={editor} />}
        </div>

        {wsId && prefs.linkPreview && <LinkPreview wsId={wsId} containerRef={bodyRef} />}

        {isDoc && page && penMode && (
          <InkLayer
            key={page.id}
            pageId={page.id}
            columnRef={inkColumnRef}
            containerRef={bodyRef}
            onClose={() => setPenMode(false)}
          />
        )}

        {isDoc && page && (
          <CommentBadges
            pageId={page.id}
            editor={editor}
            containerRef={bodyRef}
            onOpen={openComments}
          />
        )}

        {page && rightOpen && (
          <RightPanel
            open={rightOpen}
            onClose={toggleRight}
            wsId={wsId ?? ''}
            page={page}
            editor={isDoc ? editor : null}
            onOpenSearch={openSearch}
          />
        )}
      </div>

      {page && canShare && (
        <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} page={page} />
      )}
    </div>
  )
}
