import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { EyeOffIcon, SettingsIcon } from './Icons'

// Quick actions on a top-of-sidebar menu (docs/adr/1020-*): right-click, the context-menu key /
// Shift+F10, or a long press on touch (iOS Safari fires no `contextmenu` on long press, so a timer
// does it there; on Android both may fire and open the same menu).

export type MenuCtx = { id: string; x: number; y: number; trigger: HTMLElement | null }

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 8

/** Props for a menu button that open the quick-action menu. */
export function useMenuContextTrigger(open: (ctx: MenuCtx) => void) {
  const timer = useRef<number | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])

  return (id: string) => ({
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault()
      clear()
      let { clientX: x, clientY: y } = e
      // Opened from the keyboard: no pointer position, anchor under the button.
      if (x === 0 && y === 0) {
        const r = e.currentTarget.getBoundingClientRect()
        x = r.left + 24
        y = r.bottom
      }
      open({ id, x, y, trigger: e.currentTarget })
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      fired.current = false
      if (e.pointerType !== 'touch') return
      clear()
      start.current = { x: e.clientX, y: e.clientY }
      const el = e.currentTarget
      timer.current = window.setTimeout(() => {
        timer.current = null
        fired.current = true
        const p = start.current ?? { x: 0, y: 0 }
        open({ id, x: p.x, y: p.y, trigger: el })
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = start.current
      if (timer.current !== null && s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_TOLERANCE) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    // The click that ends a long press must not also run the menu.
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  })
}

export function SidebarMenuPopup({
  ctx,
  label,
  onHide,
  onCustomize,
  onClose,
}: {
  ctx: MenuCtx
  label: string
  onHide: () => void
  onCustomize: () => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Keep the panel inside the viewport (phones: a long press near the right edge).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({
      left: Math.max(8, Math.min(ctx.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(ctx.y, window.innerHeight - h - 8)),
    })
  }, [ctx.x, ctx.y])

  // Focus the first item once the panel is placed (a hidden panel cannot take focus).
  const placed = pos !== null
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [placed])

  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        ctx.trigger?.focus()
      }
    }
    // Next tick: the pointerdown that opened the menu must not close it.
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDown), 0)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [ctx.trigger, onClose])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  }

  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none pointer-coarse:min-h-10'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t('sidebar.menuOptions')}
      data-testid="sidebar-menu-popup"
      onKeyDown={onMenuKey}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.left ?? ctx.x, top: pos?.top ?? ctx.y, visibility: pos ? 'visible' : 'hidden' }}
      className="nd-pop fixed z-50 w-56 origin-top-left overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl"
    >
      <div className="truncate px-3 pb-1 pt-0.5 text-[11px] font-semibold text-sub">{label}</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          onHide()
        }}
        className={item}
      >
        <EyeOffIcon size={15} />
        {t('sidebar.hideFromSidebar')}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          onCustomize()
        }}
        className={item}
      >
        <SettingsIcon size={15} />
        {t('sidebar.customize')}
      </button>
    </div>,
    document.body,
  )
}
