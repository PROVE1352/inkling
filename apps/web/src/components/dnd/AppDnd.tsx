import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { PageMetaDTO, PageScope, UpdatePageInput } from '@inkling/shared'
import { useMovePages, usePages, useUpdatePage } from '../../api'
import { pageIcon } from '../../lib/pageIcon'
import { toast } from '../../lib/toast'
import { getActiveEditor } from '../../lib/activeEditor'
import { getActiveCanvas } from '../../lib/activeCanvas'
import { requestTreeExpand } from '../../lib/treeExpand'
import { useT } from '../../i18n'

// ---------------------------------------------------------------------------
// Drag state context (each tree row subscribes to draw its own indicator).
// Lifted out of PageTree — the app-level DndContext owns it now; PageTree/PageTreeItem only
// consume it through useTreeDnd.
// ---------------------------------------------------------------------------

export type DropPosition = 'before' | 'after' | 'child'
export type OverState = { id: string; position: DropPosition } | null

// dragIds: every row dragged together (multi-select drag). [activeId] for a single row.
const TreeDndContext = createContext<{
  activeId: string | null
  dragIds: string[]
  over: OverState
}>({
  activeId: null,
  dragIds: [],
  over: null,
})
export const useTreeDnd = () => useContext(TreeDndContext)

// Cross-boundary drop target ids (must match the useDroppable ids in PageView / CanvasView)
export const EDITOR_DROP_ID = 'editor-drop'
export const CANVAS_DROP_ID = 'canvas-drop'

// Section-root drop zone id — the sidebar section header/empty area (PageTree.TreeSection)
// registers useDroppable with it. onDragEnd detects the prefix and moves to that scope's root.
const SECTION_ROOT_PREFIX = 'section-root:'
export function sectionRootDropId(scope: PageScope, variant: 'head' | 'empty') {
  return `${SECTION_ROOT_PREFIX}${scope}:${variant}`
}
function parseSectionRoot(id: string): PageScope | null {
  if (!id.startsWith(SECTION_ROOT_PREFIX)) return null
  return id.slice(SECTION_ROOT_PREFIX.length).startsWith('private') ? 'private' : 'shared'
}

// App-level DndContext: handles sidebar tree reordering and cross-boundary drops into the
// editor/canvas in one context. AppLayout wraps the sidebar (desktop + drawer) and the main Outlet with it.
// Module constants: useSensor memoizes on the options object. Inline literals produced new
// sensors (→ new activators → new dnd-kit context) on every AppDnd render, re-rendering every
// draggable sidebar row on each navigation (docs/adr/0708-*).
const MOUSE_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } }
const TOUCH_SENSOR_OPTIONS = { activationConstraint: { delay: 250, tolerance: 8 } }

export function AppDnd({ wsId, children }: { wsId: string; children: ReactNode }) {
  const t = useT()
  const pagesQuery = usePages(wsId)
  const updatePage = useUpdatePage(wsId)
  const movePages = useMovePages(wsId)
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])

  const byId = useMemo(() => {
    const m = new Map<string, PageMetaDTO>()
    for (const p of pages) m.set(p.id, p)
    return m
  }, [pages])

  const childrenMap = useMemo(() => {
    const m = new Map<string | null, PageMetaDTO[]>()
    for (const p of pages) {
      const arr = m.get(p.parentId) ?? []
      arr.push(p)
      m.set(p.parentId, arr)
    }
    return m
  }, [pages])

  const descendantsOf = useCallback(
    (id: string): Set<string> => {
      const out = new Set<string>()
      const stack = [id]
      while (stack.length) {
        const cur = stack.pop()!
        for (const c of childrenMap.get(cur) ?? []) {
          if (!out.has(c.id)) {
            out.add(c.id)
            stack.push(c.id)
          }
        }
      }
      return out
    },
    [childrenMap],
  )

  // Visible sidebar order (shared roots → private roots, DFS per subtree). Keeps relative order in multi-moves.
  const visualOrder = useMemo(() => {
    const idx = new Map<string, number>()
    const walk = (list: PageMetaDTO[]) => {
      for (const p of list) {
        if (idx.has(p.id)) continue
        idx.set(p.id, idx.size)
        walk(childrenMap.get(p.id) ?? [])
      }
    }
    const roots = pages.filter((p) => !p.parentId || !byId.has(p.parentId))
    walk(roots.filter((p) => p.scope !== 'private'))
    walk(roots.filter((p) => p.scope === 'private'))
    return idx
  }, [pages, byId, childrenMap])

  // Normalize drag targets: drop vanished ids → drop descendants whose ancestor is also selected
  // (top-most only) → sort by visible order.
  const normalizeIds = useCallback(
    (ids: string[]): string[] => {
      const set = new Set(ids.filter((id) => byId.has(id)))
      const top = [...set].filter((id) => {
        const seen = new Set<string>()
        let cur = byId.get(id)?.parentId ?? null
        while (cur && !seen.has(cur)) {
          if (set.has(cur)) return false
          seen.add(cur)
          cur = byId.get(cur)?.parentId ?? null
        }
        return true
      })
      return top.sort(
        (a, b) => (visualOrder.get(a) ?? Infinity) - (visualOrder.get(b) ?? Infinity),
      )
    },
    [byId, visualOrder],
  )

  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragIds, setDragIds] = useState<string[]>([])
  // Also kept in a ref so resolve/onDragEnd read the latest drag group synchronously.
  const dragIdsRef = useRef<string[]>([])
  const [over, setOver] = useState<OverState>(null)

  // Collision detection uses the pointer (not the overlay rect) — consistent with resolve, which
  // computes before/after/child from the pointer Y. Falls back to rect intersection when the
  // pointer is over no drop zone.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const hits = pointerWithin(args)
    return hits.length ? hits : rectIntersection(args)
  }, [])

  // Mouse (and pen) drags after 5px of movement; a finger must long-press (250 ms, staying within 8px).
  // With a single PointerSensor, swiping the tree up/down on touch started a drag after 5px and
  // blocked scrolling (phone drawer). Touch is handled separately by TouchSensor.
  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(TouchSensor, TOUCH_SENSOR_OPTIONS),
  )

  // Hit test over tree rows. When over is editor-drop/canvas-drop there is no data-row-id, so this
  // returns null → no tree indicator is drawn (cross-boundary drop highlighting is each
  // droppable's isOver).
  const resolve = useCallback(
    (e: DragMoveEvent | DragEndEvent): OverState => {
      const aId = String(e.active.id)
      const oId = e.over ? String(e.over.id) : null
      if (!oId || oId === aId) return null
      const moving = dragIdsRef.current.length ? dragIdsRef.current : [aId]
      const el = document.querySelector<HTMLElement>(`[data-row-id="${oId}"]`)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const ev = e.activatorEvent as PointerEvent
      const baseY = typeof ev?.clientY === 'number' ? ev.clientY : rect.top
      const ptrY = baseY + e.delta.y
      const rel = (ptrY - rect.top) / rect.height
      const position: DropPosition = rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'child'
      // Moving items and their descendants cannot be the drop target/new parent (prevents cycles → no-op).
      const bad = new Set<string>(moving)
      for (const id of moving) for (const d of descendantsOf(id)) bad.add(d)
      if (bad.has(oId)) return null
      const parentId = position === 'child' ? oId : byId.get(oId)?.parentId ?? null
      if (parentId && bad.has(parentId)) return null
      return { id: oId, position }
    },
    [byId, descendantsOf],
  )

  const onDragStart = (e: DragStartEvent) => {
    const aId = String(e.active.id)
    // If the row is part of a multi-selection, data.ids carries the whole selection (otherwise just itself).
    const raw = (e.active.data.current?.ids as string[] | undefined) ?? [aId]
    const ids = normalizeIds(raw.includes(aId) ? raw : [aId])
    const next = ids.length ? ids : [aId]
    dragIdsRef.current = next
    setDragIds(next)
    setActiveId(aId)
  }
  const onDragMove = (e: DragMoveEvent) => setOver(resolve(e))

  // ---- Editor drop: insert a wikilink after the block at the drop point ----
  const insertIntoEditor = (page: PageMetaDTO, x: number, y: number) => {
    const active = getActiveEditor()
    if (!active) return
    if (page.id === active.pageId) return // a page dropped into its own body → no-op
    const editor = active.editor
    const el = document.elementFromPoint(x, y)?.closest('[data-id]')
    const blockId = el?.getAttribute('data-id')
    if (blockId) {
      editor.setTextCursorPosition(blockId, 'end')
    } else {
      const last = editor.document.at(-1)
      if (last) editor.setTextCursorPosition(last.id, 'end')
    }
    editor.insertInlineContent([
      { type: 'link', href: `/w/${wsId}/p/${page.id}`, content: page.title || t('common.untitled') },
      ' ',
    ])
    editor.focus()
  }

  // Send the computed moves. One → the single-page hook (optimistic + rollback); several → the
  // batch hook (one invalidation).
  const commitMoves = (moves: { id: string; input: UpdatePageInput }[]) => {
    if (moves.length === 0) return
    if (moves.length === 1) {
      updatePage.mutate(moves[0])
      return
    }
    movePages.mutate(moves, {
      onError: () => toast({ message: t('dnd.moveSomeFailed') }),
    })
  }

  const onDragEnd = (e: DragEndEvent) => {
    const aId = String(e.active.id)
    const overId = e.over ? String(e.over.id) : null
    const res = resolve(e)
    // Skip pages that disappeared (via polling) during the drag.
    const moving = (dragIdsRef.current.length ? dragIdsRef.current : [aId]).filter((id) =>
      byId.has(id),
    )
    dragIdsRef.current = []
    setDragIds([])
    setActiveId(null)
    setOver(null)
    const movingSet = new Set(moving)

    // Cross-boundary drop (editor/canvas): the page meta comes from the drag data. The
    // "dropped onto itself" no-op check happens in each target, which knows its own pageId
    // (editor: activeEditor store, canvas: CanvasInner).
    if (overId === EDITOR_DROP_ID || overId === CANVAS_DROP_ID) {
      const page = e.active.data.current?.page as PageMetaDTO | undefined
      if (!page) return
      const ev = e.activatorEvent as PointerEvent | null
      const x = (ev?.clientX ?? 0) + e.delta.x
      const y = (ev?.clientY ?? 0) + e.delta.y
      if (overId === EDITOR_DROP_ID) insertIntoEditor(page, x, y)
      else getActiveCanvas()?.addPageNodeAt(page.id, { x, y })
      return
    }

    // Section-root drop zone: to the end of the root of another (or the same) section; across
    // sections, scope is sent too. shared→private rule violations (someone else's subpage etc.)
    // → server 400 → useUpdatePage rolls back.
    // A drop across the section boundary inherits the target scope and PATCHes it per item (spec §3).
    // Rule violations (making someone else's page private etc.) → server 400/403 → the hook rolls back.
    const scopeOf = (id: string, targetScope: PageScope | undefined): Partial<UpdatePageInput> => {
      const dragged = byId.get(id)
      return targetScope && dragged && dragged.scope !== targetScope ? { scope: targetScope } : {}
    }
    const n = moving.length

    const rootScope = overId ? parseSectionRoot(overId) : null
    if (rootScope) {
      const roots = pages.filter(
        (p) =>
          p.parentId === null &&
          !movingSet.has(p.id) &&
          (rootScope === 'private' ? p.scope === 'private' : p.scope !== 'private'),
      )
      const maxOrder = roots.length ? Math.max(...roots.map((r) => r.sortOrder)) : 0
      commitMoves(
        moving.map((id, i) => ({
          id,
          input: { parentId: null, sortOrder: maxOrder + 1000 * (i + 1), ...scopeOf(id, rootScope) },
        })),
      )
      return
    }

    // ---- Tree reorder: insert the group (n items) as one block, keeping relative order ----
    if (!res) return
    const { id: oId, position } = res
    if (position === 'child') {
      const kids = pages.filter((p) => p.parentId === oId && !movingSet.has(p.id))
      const maxOrder = kids.length ? Math.max(...kids.map((k) => k.sortOrder)) : 0
      const targetScope = byId.get(oId)?.scope
      commitMoves(
        moving.map((id, i) => ({
          id,
          input: { parentId: oId, sortOrder: maxOrder + 1000 * (i + 1), ...scopeOf(id, targetScope) },
        })),
      )
      requestTreeExpand(oId)
    } else {
      const target = byId.get(oId)
      if (!target) return
      const parentId = target.parentId
      const sibs = pages.filter((p) => p.parentId === parentId && !movingSet.has(p.id))
      const idx = sibs.findIndex((s) => s.id === oId)
      // Spread n items evenly over (lo, hi). If one side is empty, use ±1000 steps. n=1 matches
      // the previous single-item computation.
      const lo = position === 'before' ? sibs[idx - 1]?.sortOrder : target.sortOrder
      const hi = position === 'before' ? target.sortOrder : sibs[idx + 1]?.sortOrder
      const orderAt = (i: number): number => {
        if (lo !== undefined && hi !== undefined) return lo + ((hi - lo) * (i + 1)) / (n + 1)
        if (lo === undefined) return (hi as number) - 1000 * (n - i)
        return lo + 1000 * (i + 1)
      }
      commitMoves(
        moving.map((id, i) => ({
          id,
          input: { parentId, sortOrder: orderAt(i), ...scopeOf(id, target.scope) },
        })),
      )
    }
  }

  const onDragCancel = () => {
    dragIdsRef.current = []
    setDragIds([])
    setActiveId(null)
    setOver(null)
  }

  const activePage = activeId ? byId.get(activeId) : undefined
  // Stable value: every sidebar row consumes this context, so a new object per AppDnd render
  // (e.g. each navigation) re-rendered the whole tree (docs/adr/0708-*).
  const treeDndValue = useMemo(() => ({ activeId, dragIds, over }), [activeId, dragIds, over])

  return (
    <TreeDndContext.Provider value={treeDndValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {children}
        {/* Drag preview: title + a count badge for multi-drag. Drop-back animation is off.
            Drawn about one row below the pointer so it does not cover the target row's highlight. */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {activePage ? (
              <div className="pointer-events-none flex max-w-[240px] translate-x-3 translate-y-7 items-center gap-1.5 rounded-md border border-line bg-app px-2 py-1 text-sm text-ink shadow-lg">
                <span className="shrink-0 text-[15px] leading-none">{pageIcon(activePage, false)}</span>
                <span className="min-w-0 truncate">{activePage.title || t('common.untitled')}</span>
                {dragIds.length > 1 && (
                  <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-[18px] text-white">
                    {t('dnd.count', { count: dragIds.length })}
                  </span>
                )}
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </TreeDndContext.Provider>
  )
}
