import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { InklingEditor } from './CollabEditor'
import {
  FOLDS_EVENT,
  foldCss,
  foldLayout,
  foldsToOpen,
  loadFolds,
  saveFolds,
  setFoldRevealer,
  type FoldLayout,
  type FoldNode,
  type FoldPos,
} from '../lib/headingFolds'
import { t as tr } from '../i18n'

// Heading folds (docs/adr/1221-*): a ▸ to the left of a top-level heading on hover folds the section
// under it. State per device and page (lib/headingFolds.ts); the document is never edited. Hidden blocks
// are hidden by a generated stylesheet, not by touching the editor's DOM. A folded heading keeps its
// arrow visible. Arrows are overlays in the scroll container's content coordinates (like CommentBadges),
// so scrolling moves them without any work.

type PMState = {
  doc: FoldNode & { resolve: (pos: number) => FoldPos }
  selection: { from: number; to: number }
}

const EMPTY_LAYOUT: FoldLayout = { active: [], hiddenBy: new Map(), withChildren: [] }
/** Top-level blocks: direct children of the editor's root block group. */
const TOP = '.bn-editor > .bn-block-group > .bn-block-outer'

function rootGroupOf(doc: FoldNode): FoldNode | null {
  for (let i = 0; i < doc.childCount; i++) if (doc.child(i).type.name === 'blockGroup') return doc.child(i)
  return null
}

type Arrow = { id: string; top: number; left: number; size: number }

export function HeadingFolds({
  editor,
  pageId,
  containerRef,
  disabled,
}: {
  editor: InklingEditor
  pageId: string
  /** The page's scroll container (PageView bodyRef) */
  containerRef: RefObject<HTMLDivElement | null>
  /** Pen mode: show everything (ink is drawn over the full layout) without forgetting the folds */
  disabled: boolean
}) {
  const [folded, setFolded] = useState<string[]>(() => loadFolds(pageId))
  const foldedRef = useRef(folded)
  foldedRef.current = folded
  const layoutRef = useRef<FoldLayout>(EMPTY_LAYOUT)
  const styleRef = useRef<HTMLStyleElement | null>(null)
  const cssRef = useRef('')
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  // bumps after every layout change so the folded arrows re-measure
  const [tick, setTick] = useState(0)

  const update = useCallback((next: string[]) => {
    foldedRef.current = next
    setFolded(next)
    saveFolds(pageId, next)
  }, [pageId])

  // Recompute what is hidden, open folds the selection reached into, then write the stylesheet.
  // Runs synchronously inside the editor's change/selection events, so a block that the selection
  // enters is visible again before the next key is handled.
  const sync = useCallback(() => {
    const state = editor.prosemirrorState as unknown as PMState
    let ids = foldedRef.current
    let layout = foldLayout(state.doc, new Set(ids))
    if (layout.active.length) {
      const { from, to } = state.selection
      const size = state.doc.nodeSize - 2
      const open = foldsToOpen(
        layout,
        state.doc.resolve(Math.min(from, size)),
        state.doc.resolve(Math.min(to, size)),
        rootGroupOf(state.doc),
      )
      if (open.size) {
        ids = ids.filter((id) => !open.has(id))
        update(ids)
        layout = foldLayout(state.doc, new Set(ids))
      }
    }
    layoutRef.current = layout
    const css = disabledRef.current ? '' : foldCss(layout)
    if (css !== cssRef.current) {
      cssRef.current = css
      if (styleRef.current) styleRef.current.textContent = css
      window.dispatchEvent(new Event(FOLDS_EVENT))
      setTick((v) => v + 1)
    }
  }, [editor, update])

  useLayoutEffect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-heading-folds', pageId)
    document.head.appendChild(el)
    styleRef.current = el
    cssRef.current = ''
    return () => {
      el.remove()
      styleRef.current = null
      cssRef.current = ''
    }
  }, [pageId])

  // apply on mount, after a toggle, and when pen mode changes
  useLayoutEffect(sync, [sync, folded, disabled])

  useEffect(() => {
    const offChange = editor.onChange(() => {
      if (foldedRef.current.length) sync()
    })
    const offSel = editor.onSelectionChange(() => {
      if (layoutRef.current.active.length) sync()
    })
    return () => {
      offChange?.()
      offSel?.()
    }
  }, [editor, sync])

  // Jumps into the page (?block=, outline, comments, mini outline) open the fold hiding the target.
  useEffect(() => {
    setFoldRevealer((blockId) => {
      const el = containerRef.current?.querySelector(`[data-id="${CSS.escape(blockId)}"]`)
      const top = el?.closest(TOP) as HTMLElement | null
      const topId = top?.getAttribute('data-id')
      if (!topId) return false
      const layout = layoutRef.current
      const owner = layout.hiddenBy.get(topId) ?? (top !== el && layout.withChildren.includes(topId) ? topId : null)
      if (!owner) return false
      update(foldedRef.current.filter((id) => id !== owner))
      // apply now so the caller can measure and scroll right away
      sync()
      return true
    })
    return () => setFoldRevealer(null)
  }, [containerRef, update, sync])

  // Browser find (⌘F / Ctrl+F) cannot see hidden text: open every fold of the page first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && foldedRef.current.length)
        update([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [update])

  const toggle = useCallback(
    (id: string) => {
      const cur = foldedRef.current
      update(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
    },
    [update],
  )

  // --- arrows ---------------------------------------------------------------------------------
  const [hover, setHover] = useState<Arrow | null>(null)
  const [pinned, setPinned] = useState<Arrow[]>([])
  const canHover = useHoverPointer()

  const measure = useCallback((outer: Element): Arrow | null => {
    const container = containerRef.current
    const content = outer.querySelector(':scope > .bn-block > .bn-block-content[data-content-type="heading"]')
    const line = content?.querySelector('.bn-inline-content') as HTMLElement | null
    if (!container || !content || !line) return null
    const id = outer.getAttribute('data-id')
    if (!id) return null
    const c = container.getBoundingClientRect()
    const r = line.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const lh = parseFloat(getComputedStyle(line).lineHeight) || r.height
    const size = 20
    return {
      id,
      size,
      top: r.top - c.top + container.scrollTop + Math.min(lh, r.height) / 2 - size / 2,
      left: r.left - c.left + container.scrollLeft - size - 2,
    }
  }, [containerRef])

  // folded headings keep their arrow
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || disabled) {
      setPinned([])
      return
    }
    const next: Arrow[] = []
    for (const id of layoutRef.current.active) {
      const outer = container.querySelector(`${TOP}[data-id="${CSS.escape(id)}"]`)
      const a = outer && measure(outer)
      if (a) next.push(a)
    }
    setPinned(next)
  }, [tick, folded, disabled, containerRef, measure])

  // positions move when text above changes or the column resizes
  useEffect(() => {
    let timer: number | undefined
    const later = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((v) => v + 1), 200)
    }
    const off = editor.onChange(() => {
      if (foldedRef.current.length) later()
    })
    window.addEventListener('resize', later)
    return () => {
      window.clearTimeout(timer)
      off?.()
      window.removeEventListener('resize', later)
    }
  }, [editor])

  // hover: one probe per frame at the text column's left edge while the pointer moves
  useEffect(() => {
    const container = containerRef.current
    if (!container || !canHover || disabled) {
      setHover(null)
      return
    }
    let frame = 0
    let lastY = 0
    let lastX = 0
    const probe = () => {
      frame = 0
      const editorEl = container.querySelector('.bn-editor > .bn-block-group') as HTMLElement | null
      if (!editorEl) return
      const g = editorEl.getBoundingClientRect()
      // the arrow lives left of the text; keep it while the pointer is over the arrow or the gutter
      if (lastX < g.left - 90 || lastX > g.right + 8) {
        setHover(null)
        return
      }
      const hit = document.elementFromPoint(g.left + 4, lastY)
      const outer = hit?.closest(TOP)
      const isHeading = !!outer?.querySelector(':scope > .bn-block > .bn-block-content[data-content-type="heading"]')
      if (!outer || !isHeading) {
        setHover(null)
        return
      }
      const a = measure(outer)
      setHover((prev) => (prev && a && prev.id === a.id && prev.top === a.top && prev.left === a.left ? prev : a))
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      lastX = e.clientX
      lastY = e.clientY
      if (!frame) frame = requestAnimationFrame(probe)
    }
    const onLeave = () => setHover(null)
    container.addEventListener('pointermove', onMove, { passive: true })
    container.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerleave', onLeave)
    }
  }, [containerRef, canHover, disabled, measure])

  const container = containerRef.current
  if (!container || disabled) return null
  const shown = new Map<string, Arrow>()
  for (const a of pinned) shown.set(a.id, a)
  if (hover && !shown.has(hover.id)) shown.set(hover.id, hover)
  if (!shown.size) return null

  return createPortal(
    <>
      {[...shown.values()].map((a) => {
        const isFolded = folded.includes(a.id)
        return (
          <button
            key={a.id}
            type="button"
            data-fold-arrow={a.id}
            aria-expanded={!isFolded}
            aria-label={isFolded ? tr('fold.unfold') : tr('fold.fold')}
            title={isFolded ? tr('fold.unfold') : tr('fold.fold')}
            // keep the caret and focus in the editor
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggle(a.id)}
            style={{ position: 'absolute', top: a.top, left: a.left, width: a.size, height: a.size }}
            className={`z-10 flex items-center justify-center rounded text-sub transition-colors duration-100 hover:bg-hover hover:text-ink print:hidden ${
              isFolded ? 'opacity-100' : 'opacity-70'
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden
              className="transition-transform duration-150 ease-out"
              style={{ transform: isFolded ? 'none' : 'rotate(90deg)' }}
            >
              <path d="M6 3.5 11 8l-5 4.5z" fill="currentColor" />
            </svg>
          </button>
        )
      })}
    </>,
    container,
  )
}

function useHoverPointer(): boolean {
  const query = '(hover: hover) and (pointer: fine)'
  const [ok, setOk] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setOk(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return ok
}
