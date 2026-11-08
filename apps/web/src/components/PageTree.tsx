import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useNavigate, useParams } from 'react-router'
import { useDndMonitor, useDroppable } from '@dnd-kit/core'
import type { PageMetaDTO, PageScope } from '@inkling/shared'
import { useDeletePage, useDeletePages, useRestorePage, useRestorePages } from '../api'
import { confirmTrash } from '../lib/confirm'
import { setTreeExpandHandler } from '../lib/treeExpand'
import { isMod, isTypingElement } from '../lib/platform'
import { toast } from '../lib/toast'
import { t } from '../i18n'
import {
  ChevronRightIcon,
  CollapseAllIcon,
  LockIcon,
  PlusIcon,
  UsersIcon,
} from './Icons'
import { PageTreeItem } from './PageTreeItem'
import { sectionRootDropId, useTreeDnd } from './dnd/AppDnd'

export type TreeNode = { page: PageMetaDTO; children: TreeNode[] }

// Per-row tree state (docs/adr/0708-page-tree-row-subscriptions.md).
// Expanded / open page / keyboard selection / multi-selection / renaming live in a small store
// that each row subscribes to for *its own* flags. Before, they were props/context values, so
// any navigation or selection re-rendered every visible row (2 335 expanded rows: ~400 ms of
// long tasks per navigation).
type RowSnap = {
  expanded: Set<string>
  activeId: string | undefined
  selectedId: string | null
  multiIds: Set<string>
  renamingId: string | null
}

export type TreeRowStore = {
  snap: RowSnap
  subscribe: (listener: () => void) => () => void
  emit: () => void
}

function createRowStore(): TreeRowStore {
  const listeners = new Set<() => void>()
  return {
    snap: {
      expanded: new Set(),
      activeId: undefined,
      selectedId: null,
      multiIds: new Set(),
      renamingId: null,
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    emit: () => {
      for (const l of listeners) l()
    },
  }
}

// Tree keyboard selection/rename/delete actions, consumed by the recursive PageTreeItem (useTreeDnd pattern).
// The value is stable for the life of the tree: actions forward to the latest closures.
// selectedId (keyboard selection) is separate from activePageId (the open page) — they are highlighted differently.
// multiIds: ⌘/Shift+click multi-selection (non-empty only with 2+ items). The unit for dragging and bulk delete.
export type TreeNavCtx = {
  store: TreeRowStore
  select: (id: string) => void
  toggleSelect: (id: string) => void
  selectRange: (id: string) => void
  deleteSelected: () => void
  setRenamingId: (id: string | null) => void
  deleteNode: (node: TreeNode) => void
  /** Stable navigate: react-router's useNavigate() re-renders its caller on every location
   *  change (BrowserRouter), which re-rendered every row on each navigation. */
  navigate: (to: string) => void
}

const noop = () => {}
const EMPTY_SET: Set<string> = new Set()
const TreeNavContext = createContext<TreeNavCtx>({
  store: createRowStore(),
  select: noop,
  toggleSelect: noop,
  selectRange: noop,
  deleteSelected: noop,
  setRenamingId: noop,
  deleteNode: noop,
  navigate: noop,
})

/** A row's own flags; re-renders only when one of them changes. */
export function useTreeRow(store: TreeRowStore, id: string) {
  const sub = store.subscribe
  const isOpen = useSyncExternalStore(sub, () => store.snap.expanded.has(id))
  const isActive = useSyncExternalStore(sub, () => store.snap.activeId === id)
  const isSelected = useSyncExternalStore(sub, () => store.snap.selectedId === id)
  const renaming = useSyncExternalStore(sub, () => store.snap.renamingId === id)
  // The multi-selection set itself when this row is part of it (2+), else null — rows in the
  // selection re-render when it changes (their drag payload carries the whole set).
  const multi = useSyncExternalStore(sub, () => {
    const m = store.snap.multiIds
    return m.size > 1 && m.has(id) ? m : null
  })
  return { isOpen, isActive, isSelected, renaming, multi }
}

export const useTreeNav = () => useContext(TreeNavContext)

// Ids of the node and all its descendants (scope of a delete / whether the active page disappears).
export function collectIds(node: TreeNode, acc: string[] = []): string[] {
  acc.push(node.page.id)
  for (const c of node.children) collectIds(c, acc)
  return acc
}

// Visible rows flattened by expand state — used for ↑↓←→ navigation.
type FlatRow = {
  id: string
  node: TreeNode
  depth: number
  parentId: string | null
  hasChildren: boolean
  expanded: boolean
}

function flattenInto(
  roots: TreeNode[],
  expanded: Set<string>,
  out: FlatRow[],
  depth: number,
): void {
  for (const node of roots) {
    const hasChildren = node.children.length > 0
    const isExp = expanded.has(node.page.id)
    out.push({
      id: node.page.id,
      node,
      depth,
      parentId: node.page.parentId,
      hasChildren,
      expanded: isExp,
    })
    if (hasChildren && isExp) flattenInto(node.children, expanded, out, depth + 1)
  }
}

// Flat array → tree by parentId. Input is already sorted by sortOrder asc (server contract).
export function buildTree(pages: PageMetaDTO[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const p of pages) byId.set(p.id, { page: p, children: [] })
  const roots: TreeNode[] = []
  for (const p of pages) {
    const node = byId.get(p.id)!
    const parent = p.parentId ? byId.get(p.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * buildTree with structural sharing: a node whose page object and child nodes are unchanged is
 * reused from the previous build, so memoized rows skip re-rendering (docs/adr/0708-*).
 * O(n). Pages whose parent is missing become roots (same as buildTree).
 */
export function buildTreeShared(
  pages: PageMetaDTO[],
  prev: Map<string, TreeNode>,
): { roots: TreeNode[]; byId: Map<string, TreeNode> } {
  const present = new Set<string>()
  for (const p of pages) present.add(p.id)
  const kids = new Map<string | null, PageMetaDTO[]>()
  for (const p of pages) {
    const key = p.parentId && present.has(p.parentId) ? p.parentId : null
    const list = kids.get(key)
    if (list) list.push(p)
    else kids.set(key, [p])
  }
  const byId = new Map<string, TreeNode>()
  const make = (p: PageMetaDTO): TreeNode => {
    const children = (kids.get(p.id) ?? []).map(make)
    const old = prev.get(p.id)
    const same =
      old !== undefined &&
      old.page === p &&
      old.children.length === children.length &&
      old.children.every((c, i) => c === children[i])
    const node = same ? old : { page: p, children }
    byId.set(p.id, node)
    return node
  }
  const roots = (kids.get(null) ?? []).map(make)
  return { roots, byId }
}

// ---------------------------------------------------------------------------
// Expand state (localStorage)
// ---------------------------------------------------------------------------

function useExpanded(wsId: string) {
  const key = `inkling:expanded:${wsId}`
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      // on parse failure, start empty
    }
    return new Set()
  })

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // ignore storage failures
      }
    },
    [key],
  )

  const toggle = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        persist(next)
        return next
      })
    },
    [persist],
  )

  const expand = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        persist(next)
        return next
      })
    },
    [persist],
  )

  const expandMany = useCallback(
    (ids: string[]) => {
      setExpanded((prev) => {
        if (ids.every((id) => prev.has(id))) return prev
        const next = new Set(prev)
        for (const id of ids) next.add(id)
        persist(next)
        return next
      })
    },
    [persist],
  )

  const collapseAll = useCallback(() => {
    setExpanded(() => {
      const next = new Set<string>()
      persist(next)
      return next
    })
  }, [persist])

  return { expanded, toggle, expand, expandMany, collapseAll }
}

// ---------------------------------------------------------------------------
// Section (shared/private) collapse state (localStorage) — separate from tree node expansion.
// ---------------------------------------------------------------------------

type SectionCollapse = { shared: boolean; private: boolean }

function useSectionCollapse(wsId: string) {
  const key = `inkling:section:${wsId}`
  const [collapsed, setCollapsed] = useState<SectionCollapse>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw)
        return { shared: false, private: false, ...(JSON.parse(raw) as Partial<SectionCollapse>) }
    } catch {
      // on parse failure, use defaults
    }
    return { shared: false, private: false }
  })

  const toggleSection = useCallback(
    (s: keyof SectionCollapse) => {
      setCollapsed((prev) => {
        const next = { ...prev, [s]: !prev[s] }
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          // ignore storage failures
        }
        return next
      })
    },
    [key],
  )

  return { collapsed, toggleSection }
}

// ---------------------------------------------------------------------------
// One section (shared/private): header (label + collapse + collapse all + new page) + list of roots.
// The header and the empty area are root drop zones (drag from the other section to move to this scope's root).
// ---------------------------------------------------------------------------

function TreeSection({
  scope,
  label,
  locked,
  roots,
  collapsed,
  onToggleCollapsed,
  onNewPage,
  emptyText,
  onCollapseAllNodes,
  wsId,
  toggle,
  expand,
  dragActive,
}: {
  scope: PageScope
  label: string
  locked: boolean
  roots: TreeNode[]
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Absent for guests (no top-level pages, docs/adr/1252-*): the section has no [+]. */
  onNewPage?: (scope: PageScope) => void
  /** Text for an empty section instead of the default. */
  emptyText?: string
  onCollapseAllNodes: () => void
  wsId: string
  toggle: (id: string) => void
  expand: (id: string) => void
  dragActive: boolean
}) {
  const headDrop = useDroppable({ id: sectionRootDropId(scope, 'head') })
  const emptyDrop = useDroppable({ id: sectionRootDropId(scope, 'empty') })
  const isEmpty = roots.length === 0

  return (
    <div className="flex flex-col">
      <div
        ref={headDrop.setNodeRef}
        className={`group/sec flex items-center gap-1 rounded px-1 pb-0.5 pt-2 transition-colors duration-150 ${
          dragActive && headDrop.isOver ? 'bg-accent-soft ring-1 ring-inset ring-accent' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t('tree.expandSection') : t('tree.collapseSection')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
        >
          <span
            className={`inline-flex transition-transform duration-200 ease-out ${
              collapsed ? '' : 'rotate-90'
            }`}
          >
            <ChevronRightIcon size={12} />
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-sub hover:text-ink"
        >
          {locked ? <LockIcon size={11} /> : <UsersIcon size={11} />}
          <span className="truncate">{label}</span>
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/sec:opacity-100">
          <button
            type="button"
            onClick={onCollapseAllNodes}
            aria-label={t('tree.collapseAll')}
            title={t('tree.collapseAll')}
            className="flex h-5 w-5 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
          >
            <CollapseAllIcon size={13} />
          </button>
          {onNewPage && (
            <button
              type="button"
              onClick={() => onNewPage(scope)}
              aria-label={t('tree.newPageIn', { section: label })}
              title={t('tree.newPageIn', { section: label })}
              className="flex h-5 w-5 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="nd-enter">
          {isEmpty ? (
            <div
              ref={emptyDrop.setNodeRef}
              className={`mx-1 mt-0.5 rounded px-2 py-2 text-xs text-sub transition-colors duration-150 ${
                dragActive ? 'border border-dashed border-line' : ''
              } ${
                dragActive && emptyDrop.isOver
                  ? 'bg-accent-soft ring-1 ring-inset ring-accent'
                  : ''
              }`}
            >
              {emptyText ?? (locked ? t('tree.emptyPrivate') : t('tree.emptyShared'))}
            </div>
          ) : (
            roots.map((node) => (
              <PageTreeItem
                key={node.page.id}
                node={node}
                depth={0}
                wsId={wsId}
                toggleExpanded={toggle}
                expand={expand}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function PageTree({
  wsId,
  pages,
  onNewPage,
  guest = false,
}: {
  wsId: string
  pages: PageMetaDTO[]
  onNewPage: (scope: PageScope) => void
  /**
   * Guest of the workspace (docs/adr/1252-*): the server sends only the shared subtrees (their tops
   * with parentId null, so they are roots here); no private section, no top-level [+], no delete.
   */
  guest?: boolean
}) {
  const { pageId } = useParams()
  const navigate = useNavigate()
  const { expanded, toggle, expand, expandMany, collapseAll } = useExpanded(wsId)
  const { collapsed, toggleSection } = useSectionCollapse(wsId)
  const { activeId } = useTreeDnd()
  const deletePage = useDeletePage(wsId)
  const restorePage = useRestorePage(wsId)
  const deletePages = useDeletePages(wsId)
  const restorePages = useRestorePages(wsId)

  // Keyboard selection (separate from the open page) + inline rename target.
  const [selectedId, setSelectedId] = useState<string | null>(pageId ?? null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Multi-selection + the anchor for Shift ranges.
  const [multiIds, setMultiIds] = useState<Set<string>>(EMPTY_SET)
  const [anchorId, setAnchorId] = useState<string | null>(pageId ?? null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Single selection (plain click/arrows) — clears the multi-selection.
  const selectOne = useCallback((id: string) => {
    setSelectedId(id)
    setAnchorId(id)
    setMultiIds(EMPTY_SET)
  }, [])
  const clearMulti = useCallback(() => setMultiIds(EMPTY_SET), [])

  // Sync the selection on route change (select the open page).
  useEffect(() => {
    if (pageId) selectOne(pageId)
  }, [pageId, selectOne])

  // Hide a collection's child (row) pages from the tree — they appear only in the collection's table/board.
  const treePages = useMemo(() => {
    const kindById = new Map(pages.map((p) => [p.id, p.kind]))
    return pages.filter((p) => !(p.parentId && kindById.get(p.parentId) === 'collection'))
  }, [pages])
  const prevTreeRef = useRef<Map<string, TreeNode>>(new Map())
  const tree = useMemo(() => {
    const built = buildTreeShared(treePages, prevTreeRef.current)
    prevTreeRef.current = built.byId
    return built.roots
  }, [treePages])

  // Split roots by scope. Children inherit the parent's scope, so filtering roots is enough.
  const sharedRoots = useMemo(() => tree.filter((n) => n.page.scope !== 'private'), [tree])
  const privateRoots = useMemo(() => tree.filter((n) => n.page.scope === 'private'), [tree])

  const byId = useMemo(() => {
    const m = new Map<string, PageMetaDTO>()
    for (const p of pages) m.set(p.id, p)
    return m
  }, [pages])

  // Auto-reveal the current page: expand its ancestor chain
  useEffect(() => {
    if (!pageId) return
    const anc: string[] = []
    const seen = new Set<string>()
    let cur = byId.get(pageId)?.parentId ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      anc.push(cur)
      cur = byId.get(cur)?.parentId ?? null
    }
    if (anc.length) expandMany(anc)
  }, [pageId, byId, expandMany])

  // Register expand on the bridge so the app-level DndContext (AppDnd) can ask to expand
  // the target folder right after a move-into (child-drop).
  useEffect(() => {
    setTreeExpandHandler(expand)
    return () => setTreeExpandHandler(null)
  }, [expand])

  // Flatten visible rows (shared → private, honoring section collapse). The reference order for ↑↓←→.
  const flat = useMemo(() => {
    const out: FlatRow[] = []
    if (!collapsed.shared) flattenInto(sharedRoots, expanded, out, 0)
    if (!collapsed.private) flattenInto(privateRoots, expanded, out, 0)
    return out
  }, [sharedRoots, privateRoots, expanded, collapsed])

  // Prune pages that vanished on a poll (20s) refetch from the multi-selection (keep the rest).
  useEffect(() => {
    setMultiIds((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(treePages.map((p) => p.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      if (next.size === prev.size) return prev
      return next.size > 1 ? next : EMPTY_SET
    })
  }, [treePages])

  // ⌘/Ctrl+click: toggle in the current selection (the cursor row if there is no multi-selection). Does not navigate.
  const toggleSelect = useCallback(
    (id: string) => {
      const base = multiIds.size > 0 ? multiIds : new Set(selectedId ? [selectedId] : [])
      const next = new Set(base)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setAnchorId(id)
      if (next.size > 1) {
        setMultiIds(next)
        setSelectedId(id)
      } else {
        setMultiIds(EMPTY_SET)
        setSelectedId(next.size === 1 ? [...next][0] : id)
      }
    },
    [multiIds, selectedId],
  )

  // Shift+click: every visible row between anchor and id (by expand state).
  const selectRange = useCallback(
    (id: string) => {
      const from = anchorId ?? selectedId
      const a = from ? flat.findIndex((r) => r.id === from) : -1
      const b = flat.findIndex((r) => r.id === id)
      if (a < 0 || b < 0) {
        selectOne(id)
        return
      }
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const next = new Set(flat.slice(lo, hi + 1).map((r) => r.id))
      setSelectedId(id)
      setMultiIds(next.size > 1 ? next : EMPTY_SET)
    },
    [anchorId, selectedId, flat, selectOne],
  )

  // Starting to drag a row outside the selection drags that row alone → reset the selection to it.
  useDndMonitor({
    onDragStart: (e) => {
      const id = String(e.active.id)
      if (multiIds.size > 0 && !multiIds.has(id)) selectOne(id)
    },
  })

  // With a multi-selection, Esc (anywhere, except while typing) clears it.
  useEffect(() => {
    if (multiIds.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTypingElement(e.target)) clearMulti()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [multiIds, clearMulti])

  // Scroll the selected row into view.
  useEffect(() => {
    if (!selectedId) return
    document
      .querySelector<HTMLElement>(`[data-row-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, flat])

  // Delete → straight to trash + undo toast (restorable, so no confirmation by default). Shared by keyboard and context menu.
  // With the "Confirm before deleting" setting on, confirmTrash asks first.
  const deleteNode = useCallback(
    async (node: TreeNode) => {
      const affected = collectIds(node)
      const title = node.page.title || t('common.untitled')
      if (!(await confirmTrash(t('tree.trashConfirm', { title })))) return
      deletePage.mutate(node.page.id, {
        onSuccess: () => {
          if (pageId && affected.includes(pageId)) navigate(`/w/${wsId}`)
          toast({
            message: t('tree.deleted', { title }),
            actionLabel: t('toast.undo'),
            onAction: () => restorePage.mutate(node.page.id),
          })
        },
      })
    },
    [deletePage, restorePage, navigate, pageId, wsId],
  )

  // Bulk delete → delete only the top-level items (descendants go to trash with them) + one toast undoes everything.
  const deleteSelected = useCallback(async () => {
    if (multiIds.size === 0) return
    if (!(await confirmTrash(t('tree.trashSelectedConfirm', { count: multiIds.size })))) return
    const parentOf = new Map(treePages.map((p) => [p.id, p.parentId]))
    const top = [...multiIds].filter((id) => {
      const seen = new Set<string>()
      let cur = parentOf.get(id) ?? null
      while (cur && !seen.has(cur)) {
        if (multiIds.has(cur)) return false
        seen.add(cur)
        cur = parentOf.get(cur) ?? null
      }
      return true
    })
    if (top.length === 0) return
    // If the open page is in the deleted range (including descendants of selected items), go to the workspace home.
    let opensDeleted = false
    if (pageId) {
      const seen = new Set<string>()
      let cur: string | null = pageId
      while (cur && !seen.has(cur)) {
        if (multiIds.has(cur)) opensDeleted = true
        seen.add(cur)
        cur = parentOf.get(cur) ?? null
      }
    }
    const count = top.length
    deletePages.mutate(top, {
      onSettled: (_d, err) => {
        if (opensDeleted) navigate(`/w/${wsId}`)
        toast({
          message: err ? t('tree.deletePartialFailed', { count }) : t('tree.deletedCount', { count }),
          actionLabel: t('toast.undo'),
          onAction: () => restorePages.mutate(top),
        })
      },
    })
    setMultiIds(EMPTY_SET)
    setSelectedId(null)
  }, [multiIds, treePages, pageId, deletePages, restorePages, navigate, wsId])

  // Row to select after a delete: next sibling → else the previous visible row → else the parent.
  const nextAfterDelete = useCallback((rows: FlatRow[], idx: number, cur: FlatRow) => {
    let end = idx + 1
    while (end < rows.length && rows[end].depth > cur.depth) end++
    const after = rows[end]
    if (after && after.parentId === cur.parentId) return after.id
    const before = rows[idx - 1]
    if (before) return before.id
    return cur.parentId
  }, [])

  // Key handling while the tree has focus. Ignored while typing/renaming.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTypingElement(e.target) || renamingId) return
    const rows = flat
    if (rows.length === 0) return
    const idx = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1
    const cur = idx >= 0 ? rows[idx] : null
    const onContainer = e.target === e.currentTarget
    const focusTree = () => treeRef.current?.focus()

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        selectOne(rows[idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)].id)
        focusTree()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        selectOne(rows[idx < 0 ? rows.length - 1 : Math.max(idx - 1, 0)].id)
        focusTree()
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (!cur) {
          selectOne(rows[0].id)
        } else if (cur.hasChildren && !cur.expanded) {
          expand(cur.id)
        } else if (cur.hasChildren && cur.expanded) {
          const child = rows[idx + 1]
          if (child && child.parentId === cur.id) selectOne(child.id)
        }
        focusTree()
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (!cur) break
        if (cur.hasChildren && cur.expanded) toggle(cur.id)
        else if (cur.parentId) selectOne(cur.parentId)
        focusTree()
        break
      }
      case 'Enter':
      case ' ': {
        // If focus is on a real button (section collapse/hover action), leave it to that button's default click.
        if (!onContainer || !cur) break
        e.preventDefault()
        if (cur.node.page.kind === 'folder') toggle(cur.id)
        else navigate(`/w/${wsId}/p/${cur.id}`)
        break
      }
      case 'F2': {
        if (!cur) break
        e.preventDefault()
        setRenamingId(cur.id)
        break
      }
      default: {
        const mod = isMod(e)
        const isDelete =
          (mod && (e.key === 'Backspace' || e.key === 'Delete')) ||
          (!mod && e.key === 'Delete')
        if (isDelete && guest) break
        if (isDelete && multiIds.size > 1) {
          e.preventDefault()
          deleteSelected()
          focusTree()
        } else if (isDelete && cur) {
          e.preventDefault()
          const nextSel = nextAfterDelete(rows, idx, cur)
          deleteNode(cur.node)
          setSelectedId(nextSel)
          focusTree()
        }
      }
    }
  }

  // Row store: written during render (rows rendering in this pass read fresh values), listeners
  // notified after commit so memoized rows that were skipped pick up their new flags.
  const [rowStore] = useState(createRowStore)
  rowStore.snap = { expanded, activeId: pageId, selectedId, multiIds, renamingId }
  useLayoutEffect(() => {
    rowStore.emit()
  }, [rowStore, expanded, pageId, selectedId, multiIds, renamingId])

  const actionsRef = useRef({ selectOne, toggleSelect, selectRange, deleteSelected, deleteNode, navigate })
  actionsRef.current = { selectOne, toggleSelect, selectRange, deleteSelected, deleteNode, navigate }
  const navCtx = useMemo<TreeNavCtx>(
    () => ({
      store: rowStore,
      select: (id) => actionsRef.current.selectOne(id),
      toggleSelect: (id) => actionsRef.current.toggleSelect(id),
      selectRange: (id) => actionsRef.current.selectRange(id),
      deleteSelected: () => actionsRef.current.deleteSelected(),
      setRenamingId,
      deleteNode: (node) => actionsRef.current.deleteNode(node),
      navigate: (to) => actionsRef.current.navigate(to),
    }),
    [rowStore],
  )

  const dragActive = activeId != null

  return (
    <TreeNavContext.Provider value={navCtx}>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('tree.label')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex flex-col focus-visible:outline-none"
      >
      <TreeSection
        scope="shared"
        label={t('tree.sectionShared')}
        locked={false}
        roots={sharedRoots}
        collapsed={collapsed.shared}
        onToggleCollapsed={() => toggleSection('shared')}
        onNewPage={guest ? undefined : onNewPage}
        emptyText={guest ? t('guest.noPages') : undefined}
        onCollapseAllNodes={collapseAll}
        wsId={wsId}
        toggle={toggle}
        expand={expand}
        dragActive={dragActive}
      />
      {!guest && (
      <TreeSection
        scope="private"
        label={t('tree.sectionPrivate')}
        locked
        roots={privateRoots}
        collapsed={collapsed.private}
        onToggleCollapsed={() => toggleSection('private')}
        onNewPage={onNewPage}
        onCollapseAllNodes={collapseAll}
        wsId={wsId}
        toggle={toggle}
        expand={expand}
        dragActive={dragActive}
      />
      )}
      </div>
    </TreeNavContext.Provider>
  )
}
