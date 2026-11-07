import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  triggerDownload,
  useBookmarks,
  useCreatePage,
  useDuplicatePage,
  useExpandToCanvas,
  useToggleBookmark,
  useUpdatePage,
  useSharedList,
} from '../api'
import { toast } from '../lib/toast'
import { t } from '../i18n'
import { pageIcon } from '../lib/pageIcon'
import { type TreeNode, useTreeNav, useTreeRow } from './PageTree'
import { useTreeDnd } from './dnd/AppDnd'
import { EmojiPicker } from './EmojiPicker'
import { MoveModal } from './MoveModal'
import { NotionPublishModal } from './NotionPublishModal'
import { PageRowMenu } from './PageRowMenu'
import { SaveAsTemplateModal } from './SaveAsTemplateModal'
import { ShareModal } from './ShareModal'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
  GlobeIcon,
} from './Icons'
import { isMod } from '../lib/platform'

// Memoized: a row re-renders only when its node (structurally shared — PageTree.buildTreeShared)
// or its own flags (useTreeRow) change (docs/adr/0708-*).
export const PageTreeItem = memo(function PageTreeItem({
  node,
  depth,
  wsId,
  toggleExpanded,
  expand,
}: {
  node: TreeNode
  depth: number
  wsId: string
  toggleExpanded: (id: string) => void
  expand: (id: string) => void
}) {
  const nav = useTreeNav()
  const navigate = nav.navigate
  const page = node.page
  const isFolder = page.kind === 'folder'
  const hasChildren = node.children.length > 0
  const { isOpen, isActive, isSelected, renaming, multi } = useTreeRow(nav.store, page.id)
  // Row included in a multi-selection (2+) — a highlight color distinct from the open page (bg-active).
  const inMulti = multi !== null

  const createPage = useCreatePage(wsId)
  // Web-shared indicator — every row shares one list query (react-query cache).
  const isWebShared = useSharedList(wsId).data?.items.some((it) => it.id === page.id) ?? false
  const updatePage = useUpdatePage(wsId)
  const duplicatePage = useDuplicatePage(wsId)
  const expandCanvas = useExpandToCanvas(wsId)
  const bookmarks = useBookmarks(wsId)
  const toggleBookmark = useToggleBookmark(wsId)
  const isBookmarked = (bookmarks.data ?? []).some((b) => b.pageId === page.id)

  const [menuOpen, setMenuOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [notionOpen, setNotionOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [name, setName] = useState(page.title)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [ctxPos, setCtxPos] = useState<{ left: number; top: number } | null>(null)
  // The ⋯ dropdown is also portaled to body with fixed positioning so the sidebar overflow does not clip it.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const menuPopRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const iconBtnRef = useRef<HTMLButtonElement>(null)

  // dnd
  const { dragIds, over } = useTreeDnd()
  // data.page — AppDnd's cross-boundary drop handler gets the target page meta from it.
  // data.ids — a row in the multi-selection drags the whole selection along (otherwise just itself).
  const { setNodeRef: setDragRef, listeners } = useDraggable({
    id: page.id,
    data: { page, ids: multi ? [...multi] : [page.id] },
    disabled: renaming,
  })
  const { setNodeRef: setDropRef } = useDroppable({ id: page.id })
  const setRowRef = (el: HTMLDivElement | null) => {
    setDragRef(el)
    setDropRef(el)
    rowRef.current = el
  }
  const isDragging = dragIds.includes(page.id)
  const overHere = over?.id === page.id ? over.position : null

  useEffect(() => {
    if (renaming) {
      setName(page.title)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [renaming, page.title])

  // auto-reveal: scroll the active row into view
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isActive])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      // Close only when the click is outside both the button and the popup (portaled to body).
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        menuPopRef.current &&
        !menuPopRef.current.contains(target)
      ) {
        setMenuOpen(false)
      }
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen])

  // Place the dropdown on screen relative to the ⋯ button (right-aligned, corrected before paint).
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null)
      return
    }
    const btn = menuBtnRef.current
    const el = menuPopRef.current
    if (!btn || !el) return
    const r = btn.getBoundingClientRect()
    const w = el.offsetWidth || 192
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
    let top = r.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
    setMenuPos({ left, top })
  }, [menuOpen])

  // Context menu: keep it on screen (position corrected before paint in useLayoutEffect).
  useLayoutEffect(() => {
    if (!ctxMenu) {
      setCtxPos(null)
      return
    }
    const el = ctxRef.current
    const w = el?.offsetWidth ?? 192
    const h = el?.offsetHeight ?? 300
    const left = Math.max(8, Math.min(ctxMenu.x, window.innerWidth - w - 8))
    const top = Math.max(8, Math.min(ctxMenu.y, window.innerHeight - h - 8))
    setCtxPos({ left, top })
  }, [ctxMenu])

  // Context menu: close on outside click/Esc.
  useEffect(() => {
    if (!ctxMenu) return
    const onDown = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const saveRename = () => {
    const trimmed = name.trim()
    nav.setRenamingId(null)
    if (trimmed !== page.title) {
      updatePage.mutate({ id: page.id, input: { title: trimmed } })
    }
  }

  const addChild = (kind: 'doc' | 'folder' | 'collection') => {
    createPage.mutate(
      { workspaceId: wsId, parentId: page.id, kind },
      {
        onSuccess: (created) => {
          expand(page.id)
          if (kind !== 'folder') navigate(`/w/${wsId}/p/${created.id}`)
        },
      },
    )
  }

  const onTitleClick = () => {
    nav.select(page.id)
    if (isFolder) toggleExpanded(page.id)
    else navigate(`/w/${wsId}/p/${page.id}`)
  }

  // Actions shared by the ⋯ dropdown and the right-click context menu.
  const menuActions = {
    page,
    isFolder,
    isBookmarked,
    onToggleBookmark: () => toggleBookmark.mutate(page),
    onRename: () => nav.setRenamingId(page.id),
    onAddChild: addChild,
    onMove: () => setMoveOpen(true),
    onDuplicate: () => {
      if (duplicatePage.isPending) return
      duplicatePage.mutate(page.id, {
        onSuccess: (dup) => {
          const root = dup[0]
          if (!root) return
          if (page.parentId) expand(page.parentId)
          navigate(`/w/${wsId}/p/${root.id}`)
          toast({ message: t('tree.duplicated', { title: page.title || t('common.untitled') }) })
        },
        onError: () => toast({ message: t('tree.duplicateFailed') }),
      })
    },
    onSaveTemplate: () => setSaveTemplateOpen(true),
    onExpandCanvas: () => {
      if (expandCanvas.isPending) return
      expandCanvas.mutate(page.id, {
        onSuccess: (created) => {
          if (page.parentId) expand(page.parentId)
          navigate(`/w/${wsId}/p/${created.id}`)
          toast({ message: t('tree.expandedToCanvas', { title: page.title || t('common.untitled') }) })
        },
        onError: () => toast({ message: t('tree.expandCanvasFailed') }),
      })
    },
    onToggleFullWidth: () =>
      updatePage.mutate({ id: page.id, input: { fullWidth: !page.fullWidth } }),
    onExport: (format: 'md' | 'canvas' | 'zip') =>
      triggerDownload(`/api/pages/${page.id}/export?format=${format}`),
    onNotion: () => setNotionOpen(true),
    onShare: () => setShareOpen(true),
    onDelete: () => nav.deleteNode(node),
  }

  const rowStateClass = overHere === 'child'
    ? 'bg-accent-soft ring-1 ring-inset ring-accent'
    : inMulti
      ? 'bg-accent/15 text-ink'
      : isActive
        ? 'bg-active text-ink'
        : 'text-sub hover:bg-hover'

  return (
    <div>
      <div
        ref={setRowRef}
        data-row-id={page.id}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isOpen : undefined}
        {...(renaming ? {} : listeners)}
        // Prevent the browser's text range selection on Shift+click.
        // ⚠️ listeners contains dnd-kit MouseSensor's onMouseDown — overriding it here means mouse/trackpad
        // drags (including three-finger drag) never start (2026-09-23 regression). Always chain the call.
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault()
          if (!renaming) listeners?.onMouseDown?.(e)
        }}
        onClickCapture={(e) => {
          // ⌘/Ctrl+click = toggle, Shift+click = range. Both only select, without navigating (opening a page/expanding a folder).
          if (isMod(e) || e.shiftKey) {
            e.preventDefault()
            e.stopPropagation()
            if (e.shiftKey) nav.selectRange(page.id)
            else nav.toggleSelect(page.id)
            return
          }
          nav.select(page.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          // Right-clicking a row inside the multi-selection keeps the selection (bulk menu); otherwise select just that row.
          if (!inMulti) nav.select(page.id)
          setMenuOpen(false)
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
        // Touch devices: 40px row height (tap target) + no text selection/callout on long press.
        className={`group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-colors duration-150 pointer-coarse:min-h-10 pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] ${rowStateClass} ${
          isSelected && overHere !== 'child' ? 'ring-2 ring-inset ring-accent/50' : ''
        } ${isDragging ? 'opacity-40' : ''}`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {overHere === 'before' && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-accent transition-all duration-100" />
        )}
        {overHere === 'after' && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-accent transition-all duration-100" />
        )}

        {/* Collapse arrow */}
        <button
          type="button"
          onClick={() => hasChildren && toggleExpanded(page.id)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
            hasChildren ? 'hover:bg-hover' : 'invisible'
          }`}
          aria-label={isOpen ? t('tree.collapse') : t('tree.expand')}
          tabIndex={hasChildren ? 0 : -1}
        >
          {isOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </button>

        <button
          ref={iconBtnRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setEmojiOpen((v) => !v)
          }}
          aria-label={t('tree.changeIcon')}
          title={t('tree.changeIcon')}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[15px] leading-none hover:bg-hover"
        >
          {pageIcon(page, isOpen)}
        </button>

        {renaming ? (
          <input
            ref={inputRef}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                nav.setRenamingId(null)
              }
            }}
            className="my-0.5 min-w-0 flex-1 rounded border border-accent bg-app px-1 py-0.5 text-sm text-ink focus-visible:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onTitleClick}
            className="min-w-0 flex-1 truncate py-1 text-left"
            title={page.title || t('common.untitled')}
          >
            {page.title || t('common.untitled')}
            {isWebShared && (
              <GlobeIcon
                size={11}
                aria-label={t('tree.sharedToWeb')}
                className="ml-1 inline-block align-[-1px] text-accent/80"
              />
            )}
          </button>
        )}

        {/* Hover actions */}
        {!renaming && (
          // Touch has no hover — always show +/⋯ on the current/selected row (other rows: long-press for the menu).
          <div
            className={`flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
              isActive || isSelected ? 'pointer-coarse:opacity-100' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => addChild('doc')}
              aria-label={t('tree.addSubpage')}
              title={t('tree.addSubpage')}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={15} />
            </button>
            <div ref={menuRef} className="relative">
              <button
                ref={menuBtnRef}
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={t('tree.menu')}
                title={t('tree.menu')}
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-hover hover:text-ink"
              >
                <MoreHorizontalIcon size={15} />
              </button>

              {menuOpen &&
                createPortal(
                  <div
                    ref={menuPopRef}
                    // React events from a portal bubble up the component tree and reach the row's dnd-kit
                    // sensor (bug: moving over the menu turned the row translucent as if dragging). Block them.
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                      left: menuPos?.left ?? 0,
                      top: menuPos?.top ?? 0,
                      visibility: menuPos ? 'visible' : 'hidden',
                    }}
                    className="nd-pop fixed z-50 max-h-[min(80dvh,26rem)] w-48 origin-top-right overflow-y-auto rounded-md border border-line bg-app py-1 shadow-xl"
                  >
                    <PageRowMenu {...menuActions} onClose={() => setMenuOpen(false)} />
                  </div>,
                  document.body,
                )}
            </div>
          </div>
        )}
      </div>

      {ctxMenu &&
        createPortal(
          <div
            ref={ctxRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              left: ctxPos?.left ?? ctxMenu.x,
              top: ctxPos?.top ?? ctxMenu.y,
              visibility: ctxPos ? 'visible' : 'hidden',
            }}
            className="nd-pop fixed z-50 w-48 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl"
          >
            {inMulti ? (
              <>
                <div className="px-3 py-1 text-[11px] font-semibold text-sub">
                  {t('tree.selected', { count: multi?.size ?? 0 })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCtxMenu(null)
                    nav.deleteSelected()
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-hover"
                >
                  <TrashIcon size={15} />
                  {t('tree.trashSelected', { count: multi?.size ?? 0 })}
                </button>
              </>
            ) : (
              <PageRowMenu {...menuActions} onClose={() => setCtxMenu(null)} />
            )}
          </div>,
          document.body,
        )}

      {moveOpen && (
        <MoveModal
          open={moveOpen}
          onClose={() => setMoveOpen(false)}
          wsId={wsId}
          pageId={page.id}
        />
      )}

      {notionOpen && (
        <NotionPublishModal
          open={notionOpen}
          onClose={() => setNotionOpen(false)}
          pageId={page.id}
          pageTitle={page.title}
        />
      )}

      {shareOpen && (
        <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} page={page} />
      )}

      {saveTemplateOpen && (
        <SaveAsTemplateModal
          open={saveTemplateOpen}
          onClose={() => setSaveTemplateOpen(false)}
          wsId={wsId}
          page={page}
        />
      )}

      {emojiOpen && (
        <EmojiPicker
          anchorRef={iconBtnRef}
          hasIcon={!!page.icon}
          onSelect={(icon) => updatePage.mutate({ id: page.id, input: { icon } })}
          onRemove={() => updatePage.mutate({ id: page.id, input: { icon: null } })}
          onClose={() => setEmojiOpen(false)}
        />
      )}

      {hasChildren && isOpen && (
        <div className="nd-enter">
          {node.children.map((child) => (
            <PageTreeItem
              key={child.page.id}
              node={child}
              depth={depth + 1}
              wsId={wsId}
              toggleExpanded={toggleExpanded}
              expand={expand}
            />
          ))}
        </div>
      )}
    </div>
  )
})
