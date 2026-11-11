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
import { useParams, useSearchParams } from 'react-router'
import { useDroppable } from '@dnd-kit/core'
import { useQueryClient } from '@tanstack/react-query'
import type { PageAccessLevel, PageLockDTO, PageMetaDTO } from '@inkling/shared'
import {
  qkAdmin,
  recordPageView,
  useBookmarks,
  useMe,
  useMembers,
  usePageLock,
  usePages,
  useShareStatus,
  useToggleBookmark,
  useUpdatePage,
} from '../api'
import { useUnsavedAtRisk, useUnsavedEdits } from '../lib/collabSocket'
import { setActiveEditor } from '../lib/activeEditor'
import { registerPageEditor } from '../lib/activeEditor'
import { LINE_WIDTH_FULL, setLastPage, usePrefs } from '../lib/prefs'
import { appendFilesToEditor, useFileDropZone } from '../lib/fileDrop'
import { InkLayer } from '../components/ink/InkLayer'
import { KindIcon } from '../components/PageIconGlyph'
import { MenuShortcut, ariaKeys } from '../components/MenuShortcut'
import { shortcutLabel, useCommand, useShortcutKeys, withShortcut } from '../lib/shortcuts'
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
import { PageLockModal } from '../components/PageLockModal'
import { SuspiciousNotice } from '../components/SuspiciousNotice'
import { LargePageNotice } from '../components/LargePageNotice'
import { SuggestionsNotice } from '../components/SuggestionsPanel'
import { SectionMarkers } from '../components/SectionMarkers'
import { SplitPageModal } from '../components/SplitPageModal'
import { PageFollowPanel } from '../components/PageFollow'
import { usePageSubscription } from '../notificationsApi'
import { useIsPhone } from '../lib/useMediaQuery'
import { PageProvenanceBadge } from '../components/PageProvenanceBadge'
import { Modal } from '../components/Modal'
import { agentRuleLine, editableByLine, lockRootOf } from '../lib/editLock'
import { useIsGuest } from '../lib/useGuest'
import { levelLabel } from '../lib/pageAccess'
import { GuestBadge } from '../components/GuestBadge'
import { CommentBadges } from '../components/comments/CommentBadges'
import { OnlineUsers } from '../components/OnlineUsers'
import { Spinner } from '../components/Spinner'
import { NavButtons } from '../components/NavButtons'
import { WordCount } from '../components/WordCount'
import { MiniToc } from '../components/MiniToc'
import { HeadingFolds } from '../components/HeadingFolds'
import { revealBlock } from '../lib/headingFolds'
import { LinkPreview } from '../components/LinkPreview'
import { PrinterIcon, exportPdfLabel } from '../components/ExportPdfButton'
import { printElement } from '../lib/printPage'
import { LaterModal } from '../components/LaterPanel'
import { VerifiedIcon, VerifiedListModal, VerifyBadge, VerifyModal } from '../components/PageVerify'
import { PresentIcon, Presentation } from '../components/Presentation'
import { cloneForSlides, topLevelBlocks } from '../lib/present'
import { statusByUser } from '../memberStatusApi'
import {
  BellIcon,
  CheckIcon,
  ClockIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PenIcon,
  SplitIcon,
  SunIcon,
} from '../components/Icons'
import { setTheme, useTheme, type Theme } from '../lib/theme'
import { reloadOnceForStaleChunk } from '../lib/pwa'
import { instructionLengthOf } from '../lib/instructionLength'
import { useInstructionLengths } from '../lib/instructionLengthApi'
import { InstructionLengthWarning } from '../components/InstructionLengthWarning'
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
  // Local edits the server has not acknowledged for a while, on this page or one just left
  // (docs/adr/1926-*): said in words, not only by the dot's colour.
  const unsaved = useUnsavedEdits()
  // On this device's offline copy the edits survive a reload: "not uploaded yet" instead of
  // "not saved yet" (docs/adr/2204-*).
  const atRisk = useUnsavedAtRisk()
  if (unsaved) {
    const label = atRisk ? t('page.statusUnsaved') : t('offline.statusUnsent')
    const hint = `${label} · ${t(STATUS_STYLE[status].label)}. ${atRisk ? t('page.statusUnsavedHint') : t('offline.statusUnsentHint')}`
    return (
      <span role="status" data-testid="page-unsent" data-at-risk={atRisk ? '1' : '0'} title={hint} aria-label={hint} className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
        <span className="whitespace-nowrap">{label}</span>
      </span>
    )
  }
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
  /** A state that is on (lock set, following): accent colour + a check mark at the end */
  checked?: boolean
  onSelect: () => void
  /** Items that can be pressed repeatedly (like cycling the theme) keep the menu open */
  keepOpen?: boolean
  testId?: string
  /** Registry command id: its key is shown at the end of the item (docs/adr/1403-*) */
  shortcut?: string
}

// Top bar ⋯ menu (all widths) — the less frequent page actions (pen mode, edit lock, page
// notifications, print, theme) live here so the bar keeps only bookmark, share, presence, panel and
// the global bell. On phones it also takes share and the panel, to leave room for the breadcrumb.
// `badge` puts a small dot on the button when a folded-away state is on (locked, following).
// Body portal + fixed. The whole app is inside a dnd-kit context, so stopPropagation keeps the menu's
// pointerdown from leaking into the tree drag sensor (lesson learned in this codebase).
function PageHeaderMenu({
  items,
  footer,
  badge = false,
}: {
  items: HeaderMenuItem[]
  footer?: ReactNode
  badge?: boolean
}) {
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
        data-testid="page-more-menu"
        className={`shrink-0 rounded-md p-1.5 transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] ${
          open ? 'bg-hover text-ink' : 'text-sub'
        }`}
      >
        <span className="relative block">
          <MoreHorizontalIcon size={18} />
          {badge && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
        </span>
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
                role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={it.checked}
                data-testid={it.testId}
                aria-keyshortcuts={it.shortcut ? ariaKeys(it.shortcut) : undefined}
                onClick={() => {
                  it.onSelect()
                  if (!it.keepOpen) setOpen(false)
                }}
                className={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm transition-colors hover:bg-hover sm:min-h-9 ${
                  it.active || it.checked ? 'text-accent' : 'text-ink'
                }`}
              >
                <span className={`flex w-5 shrink-0 justify-center ${it.active || it.checked ? 'text-accent' : 'text-sub'}`}>
                  {it.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {/* no keyboard to speak of on a phone, and the label needs the room */}
                {it.shortcut && <MenuShortcut id={it.shortcut} className="max-sm:hidden" />}
                {it.checked && <CheckIcon size={14} className="shrink-0 text-accent" />}
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
  readOnly = false,
}: {
  page: PageMetaDTO
  onCommit: (title: string) => void
  onEnter: () => void
  /** Edit lock: the title is shown but cannot be changed */
  readOnly?: boolean
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
      readOnly={readOnly}
      aria-readonly={readOnly || undefined}
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
  readOnly = false,
  banner,
}: {
  wsId: string
  page: PageMetaDTO
  onCommit: (title: string) => void
  onEnter: () => void
  /** Edit lock: cover, icon and title are shown without editing affordances */
  readOnly?: boolean
  /** Lock banner, shown above the title */
  banner?: ReactNode
}) {
  const updatePage = useUpdatePage(wsId)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const iconBtnRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <PageCover wsId={wsId} page={page} readOnly={readOnly} />
      {page.icon ? (
        <button
          ref={iconBtnRef}
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          disabled={readOnly}
          aria-label={tr('page.changeIcon')}
          title={readOnly ? undefined : tr('page.changeIcon')}
          className="-ml-1.5 mb-1 flex h-12 w-12 items-center justify-center rounded-lg text-4xl leading-none transition-colors duration-150 hover:bg-hover disabled:hover:bg-transparent"
        >
          {page.icon}
        </button>
      ) : readOnly ? null : (
        // No icon chosen: no big default emoji above the title — a quiet "Add icon" that shows on
        // hover / tap in the page (like "Add cover"); the sidebar tree's icon button works too.
        <button
          ref={iconBtnRef}
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          className={`-ml-1.5 mb-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-sub transition-opacity duration-150 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/page:opacity-100 ${
            emojiOpen ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <KindIcon kind={page.kind} size={14} />
          {tr('page.addIcon')}
        </button>
      )}
      {banner}
      <TitleInput page={page} onCommit={onCommit} onEnter={onEnter} readOnly={readOnly} />
      {emojiOpen && !readOnly && (
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

// Edit lock line under the page icon (docs/adr/0970-*): who can edit, the agent rule, and whether
// the viewer can edit. Clicking it opens the lock dialog (details, or management for managers).
function LockBanner({
  wsId,
  pageId,
  lock,
  readOnly,
  onOpen,
}: {
  wsId: string | undefined
  pageId: string | undefined
  lock: PageLockDTO | undefined
  readOnly: boolean
  onOpen: () => void
}) {
  const agentRule = lock ? agentRuleLine(lock) : null
  // "long" badge of an instruction page (docs/adr/2021-*): the server measures, members only
  const lengths = useInstructionLengths(wsId, !!lock?.instructions)
  const inheritedFrom = lock && lock.locked && !lock.own && lock.lockRoot ? lock.lockRoot.title : null
  return (
    <button
      type="button"
      onClick={onOpen}
      title={tr('lock.badgeTitle')}
      className="mb-2 flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-hover/40 px-2.5 py-1 text-left text-xs text-sub transition-colors duration-150 hover:bg-hover"
    >
      <span className="flex items-center gap-1 font-medium text-ink">
        <LockIcon size={12} />
        {tr('lock.badge')}
      </span>
      {lock && <span>{editableByLine(lock)}</span>}
      {agentRule && <span>· {agentRule}</span>}
      {inheritedFrom !== null && <span>· {tr('lock.inheritedFrom', { title: inheritedFrom || tr('common.untitled') })}</span>}
      {readOnly && <span className="text-ink">· {tr('lock.readOnlyHint')}</span>}
      {lock?.instructions && <InstructionLengthWarning length={instructionLengthOf(lengths.data, pageId)} compact />}
      {lock?.canManage && <span className="text-accent">{tr('lock.manage')}</span>}
    </button>
  )
}

/** A guest's level on this page (docs/adr/1251-*), in place of the lock banner. */
function GuestAccessNote({ level }: { level: PageAccessLevel | undefined }) {
  return (
    <div
      data-testid="guest-access-note"
      className="mb-2 flex max-w-full flex-wrap items-center gap-2 rounded-md border border-line bg-hover/40 px-2.5 py-1 text-xs text-sub"
    >
      <GuestBadge />
      {level && <span>{tr('access.yourLevel', { level: levelLabel(level) })}</span>}
    </div>
  )
}

// Doc body wrapper — dropping a sidebar page here makes AppDnd insert a wikilink.
// useDroppable(editor-drop) is registered only while this component is mounted (= the current page is a doc),
// so canvas/folder/collection pages have no editor-drop target.
// fullWidth=true drops the container's max-w (full width) and keeps only generous side padding.
// Otherwise textWidth (the device's "line width" setting) is the width of the body text; the column
// adds the BlockNote side gutters (54px each, room for the block handles, 0 on phones) and its own
// padding, so the text itself — not the column — is that wide.
function EditorDropZone({
  fullWidth,
  textWidth,
  columnRef,
  children,
}: {
  fullWidth: boolean
  textWidth: number
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
      style={fullWidth ? undefined : { maxWidth: `calc(${textWidth}px + 108px + 3rem)` }}
      className={`group/page nd-fade mx-auto py-6 sm:py-10 ${
        fullWidth ? 'max-w-none px-4 sm:px-10' : 'px-4 sm:px-6'
      } ${isOver ? 'rounded-md ring-2 ring-accent/40' : ''}`}
    >
      {children}
    </div>
  )
}

export function PageView() {
  const { wsId, pageId } = useParams()
  // tooltips and the ⋯ menu carry the keys; re-render when the user changes one
  useShortcutKeys()
  const { onToggleSidebar, openSearch } = useLayout()
  const me = useMe()
  const pages = usePages(wsId ?? '')
  const updatePage = useUpdatePage(wsId ?? '')
  const bookmarks = useBookmarks(wsId ?? '')
  const toggleBookmark = useToggleBookmark(wsId ?? '')
  const prefs = usePrefs()
  const { theme } = useTheme()

  const page = pages.data?.find((p) => p.id === pageId)
  // Guest of this workspace (docs/adr/1252-*): only the page itself, its comments and backlinks.
  // Sharing, locks, history, notifications, reviews, favorites and the pen are member features.
  const guest = useIsGuest(wsId)
  // One view per page open → the page's read counter (totals only, docs/adr/0953-*)
  const pageLoaded = !!page
  useEffect(() => {
    if (pageId && pageLoaded && !guest) recordPageView(pageId)
  }, [pageId, pageLoaded, guest])
  const isDoc = page?.kind === 'doc'
  const isCanvas = page?.kind === 'canvas'
  const isBookmarked = !!page && (bookmarks.data ?? []).some((b) => b.pageId === page.id)

  // M15 public sharing — doc/collection/folder can be published (lookup skipped for private pages). Drives the 🌐 indicator.
  const canShare = !guest && (page?.kind === 'doc' || page?.kind === 'collection' || page?.kind === 'folder')
  const shareStatus = useShareStatus(page?.id, !!page && canShare && page.scope !== 'private')
  const isShared = !!shareStatus.data?.shared
  const [shareOpen, setShareOpen] = useState(false)
  const [lockOpen, setLockOpen] = useState(false)
  useEffect(() => setLockOpen(false), [pageId])
  // Page notifications (in the ⋯ menu). `following` puts a check on the item and a dot on ⋯.
  const [followOpen, setFollowOpen] = useState(false)
  useEffect(() => setFollowOpen(false), [pageId])
  // Save for later / reminder (docs/adr/1410-*), in the ⋯ menu.
  const [laterOpen, setLaterOpen] = useState(false)
  useEffect(() => setLaterOpen(false), [pageId])
  // Verification (docs/adr/1840-*) and presentation mode (docs/adr/1843-*), in the ⋯ menu.
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifiedListOpen, setVerifiedListOpen] = useState(false)
  const [slides, setSlides] = useState<Element[] | null>(null)
  useEffect(() => {
    setVerifyOpen(false)
    setVerifiedListOpen(false)
    setSlides(null)
  }, [pageId])
  // Members' status messages for the presence avatars (docs/adr/1846-*); guests have no members list.
  const members = useMembers(guest ? '' : (wsId ?? ''))
  const memberStatuses = statusByUser(members.data)
  // Split into subpages (docs/adr/1140-*); `?split=1` (the "large page" notification) opens it.
  const [splitOpen, setSplitOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => setSplitOpen(false), [pageId])
  useEffect(() => {
    if (searchParams.get('split') !== '1') return
    setSplitOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('split')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  const pageSub = usePageSubscription(page?.id)
  const following = pageSub.data?.effective.level === 'all'
  const isPhone = useIsPhone()

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


  const bodyRef = useRef<HTMLDivElement>(null)
  // Pen mode — when on, the body is locked and a pen layer sits on top (same idea as PDF annotation).
  const inkColumnRef = useRef<HTMLDivElement>(null)
  // Pen mode belongs to the page it was turned on for (docs/adr/1340-*): on a page change it is off
  // in the very first render of the new page, so no ink layer mounts for it in passing.
  const [penPageId, setPenPageId] = useState<string | null>(null)
  const penMode = !!pageId && penPageId === pageId
  // Turn pen mode off when switching pages — prevents accidental strokes on another page.
  useEffect(() => setPenPageId(null), [pageId])
  // Narrow screens: navigating to another page from the panel (backlinks etc.) closes the overlay panel to show the new body.
  useEffect(() => {
    if (window.matchMedia('(max-width: 767.98px)').matches) setRightOpen(false)
  }, [pageId])

  const handleCollab = useCallback((s: CollabState) => setCollab(s), [])

  // Edit lock (docs/adr/0970-*). The page list marks only pages with their own lock, so the
  // effective lock comes from the nearest locked ancestor-or-self. The lock query (canEdit) is the
  // authoritative UI answer; the collab scope the server granted is the fast path (it arrives
  // before the body syncs). A read-only connection's edits are dropped by the server, so either
  // one makes the editor read-only.
  const queryClient = useQueryClient()
  const treeLockRoot = lockRootOf(pages.data, page?.id)
  // read-only because the page needs a newer app (docs/adr/2425-*): CollabEditor says so itself, so
  // it is not shown as a lock
  const schemaReadOnly = isDoc && collab.schemaNeeds !== undefined
  const scopeReadOnly = isDoc && !schemaReadOnly && collab.scope !== undefined && collab.scope !== 'read-write'
  const canLock = !!page && page.scope !== 'private' && !guest
  // A guest's level comes only from the lock answer (level / canEdit), so it is always asked.
  const lockEnabled = guest ? !!page : canLock && (!!treeLockRoot || scopeReadOnly)
  const lockQuery = usePageLock(page?.id, lockEnabled)
  const lockData = lockEnabled ? lockQuery.data : undefined
  const lockReadOnly =
    scopeReadOnly ||
    schemaReadOnly ||
    (lockData ? !lockData.canEdit : (guest || !!treeLockRoot) && lockQuery.isLoading)
  const isLocked = !!lockData?.locked || !!treeLockRoot || scopeReadOnly
  // A lock appeared/disappeared in the tree or the server changed this connection's scope:
  // refresh the lock (canEdit) right away instead of waiting for it to go stale.
  const treeLockRootId = treeLockRoot?.id
  useEffect(() => {
    if (page?.id) queryClient.invalidateQueries({ queryKey: qkAdmin.pageLock(page.id) })
  }, [queryClient, page?.id, treeLockRootId, collab.scope])
  // Ink strokes are page writes too: no pen on a page the viewer cannot edit.
  useEffect(() => {
    if (lockReadOnly) setPenPageId(null)
  }, [lockReadOnly])
  // Page commands of the shortcut registry (docs/adr/1400-*, 1401-*): ⌘⌥\\ panel, ⌘⌥S favorite,
  // ⌘⌥P pen mode. The same conditions as the buttons and menu items that do the same thing.
  const canPen = isDoc && !lockReadOnly && !guest
  const togglePen = () => setPenPageId((v) => (v === pageId ? null : (pageId ?? null)))
  useCommand('page.toggleRightPanel', toggleRight, () => !!page)
  useCommand('page.toggleFavorite', () => page && toggleBookmark.mutate(page), () => !!page && !guest)
  useCommand('page.togglePen', togglePen, () => canPen)
  // the ⋯ menu's "Save for later" (docs/adr/1410-*)
  useCommand('page.saveForLater', () => setLaterOpen(true), () => !!page && !guest)
  const lockBanner = guest ? (
    <GuestAccessNote level={lockData?.level} />
  ) : isLocked ? (
    <LockBanner wsId={wsId} pageId={pageId} lock={lockData} readOnly={lockReadOnly} onOpen={() => setLockOpen(true)} />
  ) : null
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
  const dropActive = useFileDropZone(bodyRef, onDropFiles, isDoc && !!editor && !lockReadOnly)

  // Share the active editor via a module store, for AppDnd (app-level DndContext) to use on body drops.
  // AppDnd is a route parent and can't see pageId, so pageId is stored too (for the self-drop no-op).
  useEffect(() => {
    // A locked (read-only) body takes no sidebar drops: the server would discard the edit.
    if (isDoc && editor && pageId && !lockReadOnly) {
      setActiveEditor({ editor, pageId })
      return () => setActiveEditor(null)
    }
    return
  }, [isDoc, editor, pageId, lockReadOnly])
  // Button blocks run only in an editor whose page is known (docs/adr/2244-*), locked or not.
  useEffect(() => (editor && pageId ? registerPageEditor(editor, pageId) : undefined), [editor, pageId])

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
    revealBlock(blockId)
    const el = bodyRef.current?.querySelector(`[data-id="${blockId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // `?thread=<id>` (Threads view, Later list): open the comments panel at that thread card.
  const threadParam = searchParams.get('thread')
  useEffect(() => {
    if (!threadParam || !page) return
    setRightOpen(true)
    let tries = 0
    let timer = 0
    const find = () => {
      // The panel can be mounted twice (side panel and overlay); take the one on screen.
      const card = [...document.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(threadParam)}"]`)].find(
        (el) => el.offsetParent !== null,
      )
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card.classList.add('nd-block-flash')
        window.setTimeout(() => card.classList.remove('nd-block-flash'), 1600)
        const next = new URLSearchParams(searchParams)
        next.delete('thread')
        setSearchParams(next, { replace: true })
      } else if (++tries < 30) timer = window.setTimeout(find, 100)
    }
    timer = window.setTimeout(find, 50)
    return () => window.clearTimeout(timer)
  }, [threadParam, page, searchParams, setSearchParams])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-14 sm:gap-2 sm:pl-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={tr('page.toggleSidebar')}
          title={tr('page.toggleSidebarHint', { shortcut: shortcutLabel('app.toggleSidebar') ?? '' })}
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
        {page && !guest && (
          <button
            type="button"
            onClick={() => toggleBookmark.mutate(page)}
            aria-pressed={isBookmarked}
            aria-label={isBookmarked ? tr('page.unbookmark') : tr('page.bookmark')}
            aria-keyshortcuts={ariaKeys('page.toggleFavorite')}
            title={withShortcut(isBookmarked ? tr('page.unbookmark') : tr('page.bookmark'), 'page.toggleFavorite')}
            className={`rounded-md p-1.5 text-lg leading-none transition duration-150 hover:bg-hover active:scale-[.98] ${
              isBookmarked ? 'text-amber-500' : 'text-sub hover:text-ink'
            }`}
          >
            {isBookmarked ? '★' : '☆'}
          </button>
        )}
        {/* Kept in the bar: bookmark (above), share, presence, right panel, ⋯ — and the global bell
            (AppLayout, fixed in the pr-14 slot). On phones (<640px) share and the panel fold into ⋯ too. */}
        <div className="hidden sm:contents">
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
          {(isDoc || isCanvas) && <OnlineUsers users={collab.users} statuses={memberStatuses} />}
        </div>
        {(isDoc || isCanvas) && (
          <span className="flex shrink-0 px-1">
            <StatusDot status={collab.status} />
          </span>
        )}
        <button
          type="button"
          onClick={toggleRight}
          aria-label={tr('page.togglePanel')}
          aria-keyshortcuts={ariaKeys('page.toggleRightPanel')}
          title={withShortcut(tr('page.rightPanel'), 'page.toggleRightPanel')}
          className={`hidden rounded-md p-1.5 transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98] sm:block ${
            rightOpen ? 'text-accent' : 'text-sub'
          }`}
        >
          <PanelRightIcon size={18} />
        </button>
        <PageHeaderMenu
          badge={(isLocked && !guest) || following}
          items={[
            ...(isPhone && page && canShare
              ? [
                  {
                    label: isShared ? tr('page.sharedToWeb') : tr('page.shareToWeb'),
                    icon: <GlobeIcon size={16} />,
                    active: isShared,
                    onSelect: () => setShareOpen(true),
                  },
                ]
              : []),
            ...(isPhone
              ? [
                  {
                    label: rightOpen ? tr('page.closeRightPanel') : tr('page.openRightPanel'),
                    icon: <PanelRightIcon size={16} />,
                    active: rightOpen,
                    shortcut: 'page.toggleRightPanel',
                    onSelect: toggleRight,
                  },
                ]
              : []),
            ...(canPen
              ? [
                  {
                    label: tr('page.penMode'),
                    icon: <PenIcon size={16} />,
                    checked: penMode,
                    shortcut: 'page.togglePen',
                    onSelect: togglePen,
                  },
                ]
              : []),
            ...(isDoc && page && !lockReadOnly && !guest
              ? [
                  {
                    label: tr('split.menu'),
                    icon: <SplitIcon size={16} />,
                    onSelect: () => setSplitOpen(true),
                    testId: 'page-split-button',
                  },
                ]
              : []),
            ...(canLock
              ? [
                  {
                    label: tr('lock.menu'),
                    icon: <LockIcon size={16} />,
                    checked: isLocked,
                    onSelect: () => setLockOpen(true),
                  },
                ]
              : []),
            ...(page && !guest
              ? [
                  {
                    label: tr('follow.button'),
                    icon: <BellIcon size={16} />,
                    checked: following,
                    onSelect: () => setFollowOpen(true),
                    testId: 'page-follow-button',
                  },
                  {
                    label: tr('later.save'),
                    icon: <ClockIcon size={16} />,
                    onSelect: () => setLaterOpen(true),
                    testId: 'page-later-button',
                  },
                ]
              : []),
            ...(isDoc && page && editor
              ? [
                  {
                    // read-only slides from the editor's blocks (docs/adr/1843-*)
                    label: tr('present.menu'),
                    icon: <PresentIcon size={16} />,
                    onSelect: () => {
                      if (editor.domElement) setSlides(cloneForSlides(topLevelBlocks(editor.domElement)))
                    },
                    testId: 'page-present-button',
                  },
                ]
              : []),
            ...(page && !guest && page.kind !== 'folder'
              ? [
                  {
                    label: tr('pageVerify.menu'),
                    icon: <VerifiedIcon size={16} />,
                    onSelect: () => setVerifyOpen(true),
                    testId: 'page-verify-button',
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
              label: tr('page.themeCycle', { current: tr(THEME_LABEL[theme]), next: tr(THEME_LABEL[nextTheme(theme)]) }),
              icon: theme === 'light' ? <SunIcon size={16} /> : theme === 'dark' ? <MoonIcon size={16} /> : <MonitorIcon size={16} />,
              onSelect: () => setTheme(nextTheme(theme)),
              keepOpen: true,
            },
          ]}
          footer={
            isPhone && (isDoc || isCanvas) && collab.users.length > 0 ? (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-sub">
                <OnlineUsers users={collab.users} statuses={memberStatuses} />
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
                <PageCover wsId={wsId ?? ''} page={page} readOnly={lockReadOnly} />
                {lockBanner}
              </div>
              <FolderView wsId={wsId ?? ''} page={page} />
            </div>
          ) : page.kind === 'collection' ? (
            // Key only on the wrapper — giving siblings the same key confuses React's keyed diff and
            // leaves old elements in the DOM in production builds (the cause of the stacked-title bug).
            // The wrapper spans the pane and is a size container: wide views (board, table) scroll
            // from the pane's left edge to its right edge while their content starts on the column
            // (nd-coll-page / nd-wide-scroll in index.css, docs/adr/1321-*). Full width (the page's
            // own setting, or the device's "Line width: Full") drops the column's max width, as on docs.
            <div key={page.id} className="nd-enter @container">
              <div
                className={`group/page nd-coll-page mx-auto py-6 sm:py-10 ${
                  page.fullWidth || prefs.lineWidth === LINE_WIDTH_FULL ? 'max-w-none px-4 sm:px-10' : 'max-w-5xl px-4 sm:px-6'
                }`}
              >
                <PageHeading
                  wsId={wsId ?? ''}
                  page={page}
                  onCommit={(t) => {
                    if (pageId) updatePage.mutate({ id: pageId, input: { title: t } })
                  }}
                  onEnter={() => {}}
                  readOnly={lockReadOnly}
                  banner={lockBanner}
                />
                {!guest && <VerifyBadge pageId={page.id} onOpen={() => setVerifyOpen(true)} />}
                <Suspense fallback={viewFallback}>
                  {guest ? (
                    // The collection routes are member-only for now (docs/adr/1252-*).
                    <p className="px-1 py-6 text-sm text-sub">{tr('guest.collectionUnavailable')}</p>
                  ) : (
                    <CollectionView wsId={wsId ?? ''} pageId={page.id} readOnly={lockReadOnly} />
                  )}
                </Suspense>
              </div>
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
                  readOnly={lockReadOnly}
                  banner={lockBanner}
                />
              </div>
              <div className="min-h-0 flex-1">
                <Suspense fallback={viewFallback}>
                  <CanvasView
                    pageId={page.id}
                    wsId={wsId ?? ''}
                    me={me.data}
                    onCollabChange={handleCollab}
                    readOnly={lockReadOnly}
                  />
                </Suspense>
              </div>
            </div>
          ) : (
            // Key only on the wrapper (EditorDropZone) — giving siblings the same key confuses React's keyed
            // diff and leaves old elements in the DOM (the cause of the stacked-title bug).
            // The per-page "Full width" wins; otherwise follow the per-device "Line width" setting (0 = full width).
            <EditorDropZone
              key={page.id}
              fullWidth={page.fullWidth || prefs.lineWidth === LINE_WIDTH_FULL}
              textWidth={prefs.lineWidth}
              columnRef={inkColumnRef}
            >
              {/* nd-doc-head: same side inset as the editor's block-handle gutter, so cover, icon,
                  title and notices start on the body text's line (index.css). */}
              <div className="nd-doc-head">
                <PageHeading
                  wsId={wsId ?? ''}
                  page={page}
                  onCommit={(t) => {
                    if (pageId) updatePage.mutate({ id: pageId, input: { title: t } })
                  }}
                  onEnter={focusEditor}
                  readOnly={lockReadOnly}
                  banner={lockBanner}
                />
                {!guest && <VerifyBadge pageId={page.id} onOpen={() => setVerifyOpen(true)} />}
                <PageProvenanceBadge pageId={page.id} />
                <SuspiciousNotice pageId={page.id} />
                <LargePageNotice pageId={page.id} />
                {!guest && <SuggestionsNotice pageId={page.id} />}
              </div>
              <CollabEditor
                pageId={page.id}
                wsId={wsId ?? ''}
                me={me.data}
                title={page.title}
                onCollabChange={handleCollab}
                onEditorReady={handleEditorReady}
                readOnly={penMode || lockReadOnly}
                penMode={penMode}
              />
            </EditorDropZone>
          )}
        </div>

        {isDoc && editor && prefs.wordCount && <WordCount key={`wc:${page?.id}`} editor={editor} />}
        {isDoc && editor && page && prefs.miniToc && !isPhone && (
          <MiniToc key={`toc:${page.id}`} editor={editor} containerRef={bodyRef} columnRef={inkColumnRef} />
        )}
        </div>

        {wsId && prefs.linkPreview && !guest && <LinkPreview wsId={wsId} containerRef={bodyRef} />}

        {isDoc && page && penMode && (
          // Own key namespace: HeadingFolds below is a sibling keyed by page.id, and two siblings with
          // one key made React lose the old layer on a page change (its SVG and toolbar stayed on
          // screen over the next page, docs/adr/1340-*).
          <InkLayer
            key={`ink:${page.id}`}
            pageId={page.id}
            columnRef={inkColumnRef}
            containerRef={bodyRef}
            onClose={() => setPenPageId(null)}
          />
        )}

        {isDoc && page && editor && (
          <HeadingFolds key={`folds:${page.id}`} editor={editor} pageId={page.id} containerRef={bodyRef} disabled={penMode} />
        )}

        {isDoc && page && !guest && (
          // suggested edits and agent claims next to section headings (docs/adr/1530-*, 1535-*)
          <SectionMarkers key={`marks:${page.id}`} pageId={page.id} editor={editor} containerRef={bodyRef} />
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
            readOnly={lockReadOnly}
            guest={guest}
            canComment={!guest || !!lockData?.canComment}
          />
        )}
      </div>

      {page && canShare && (
        <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} page={page} />
      )}
      {page && wsId && lockOpen && !guest && (
        <PageLockModal open={lockOpen} onClose={() => setLockOpen(false)} wsId={wsId} page={page} />
      )}
      {page && wsId && splitOpen && page.kind === 'doc' && !guest && (
        <SplitPageModal open={splitOpen} onClose={() => setSplitOpen(false)} wsId={wsId} page={page} />
      )}
      {page && laterOpen && !guest && (
        <LaterModal open={laterOpen} onClose={() => setLaterOpen(false)} target={{ kind: 'page', pageId: page.id }} />
      )}
      {page && wsId && verifyOpen && !guest && (
        <VerifyModal
          key={`verify:${page.id}`}
          open={verifyOpen}
          onClose={() => setVerifyOpen(false)}
          pageId={page.id}
          onOpenList={() => {
            setVerifyOpen(false)
            setVerifiedListOpen(true)
          }}
        />
      )}
      {wsId && verifiedListOpen && !guest && (
        <VerifiedListModal key="verified-list" open={verifiedListOpen} onClose={() => setVerifiedListOpen(false)} wsId={wsId} />
      )}
      {page && slides && (
        // own key namespace, like the ink layer (docs/adr/1340-*): slides of one page never outlive it
        <Presentation
          key={`pres:${page.id}`}
          title={page.title}
          icon={page.icon && !page.icon.startsWith('/') ? page.icon : undefined}
          blocks={slides}
          onClose={() => setSlides(null)}
        />
      )}
      {page && followOpen && !guest && (
        <Modal open={followOpen} onClose={() => setFollowOpen(false)} title={tr('follow.button')}>
          <PageFollowPanel pageId={page.id} />
        </Modal>
      )}
    </div>
  )
}
