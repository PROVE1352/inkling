import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isMod, MOD, shortcut } from '../lib/platform'
import { CalendarDayIcon, CheckSquareIcon, FileTextIcon, XIcon } from './Icons'
import { Spinner } from './Spinner'
import { fmtDate, parseYmd, useT } from '../i18n'

// Global calendar popover for an empty day — add task (default) · new page on this date · open/create daily note.
// Keyboard: type then Enter = add task, ⌘/Ctrl+Enter = new page, Esc = close.
// On phones (below sm) it opens as a bottom sheet (a popover next to a narrow cell is hard to use with a finger).

/** e.g. "Mon, Sep 30" (current locale) */
function dateTitle(ymd: string): string {
  const d = parseYmd(ymd)
  return d ? fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }) : ymd
}

export function DayPopover({
  date,
  anchor,
  sheet,
  hasDaily,
  busy,
  onClose,
  onQuickTask,
  onNewPage,
  onOpenDaily,
}: {
  date: string
  /** Position of the anchor element (desktop popover) */
  anchor: DOMRect | null
  /** Show as a bottom sheet (phone) */
  sheet: boolean
  hasDaily: boolean
  busy: boolean
  onClose: () => void
  onQuickTask: (title: string) => Promise<void>
  onNewPage: (title: string) => void
  onOpenDaily: () => void
}) {
  const tr = useT()
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Return focus to where it was on close (so keyboard users don't get lost).
  const returnFocus = useRef<Element | null>(
    typeof document !== 'undefined' ? document.activeElement : null,
  )

  useEffect(() => {
    const el = returnFocus.current
    inputRef.current?.focus()
    return () => {
      if (el instanceof HTMLElement) el.focus({ preventScroll: true })
    }
  }, [])

  // Desktop: below the anchor cell (above if there's no room), kept inside the viewport.
  useLayoutEffect(() => {
    if (sheet || !anchor || !boxRef.current) return
    const w = boxRef.current.offsetWidth
    const h = boxRef.current.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchor.left
    if (left + w > vw - 8) left = vw - 8 - w
    left = Math.max(8, left)
    let top = anchor.bottom + 4
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4)
    setPos({ left, top })
  }, [anchor, sheet])

  // Close on outside click / Esc. Registered on the next tick so the opening click doesn't close it right away.
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('touchstart', onDown)
    }, 0)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const addTask = async () => {
    const t = title.trim()
    if (!t || pending) {
      inputRef.current?.focus()
      return
    }
    setPending(true)
    try {
      await onQuickTask(t)
      setTitle('')
      onClose()
    } catch {
      // The caller shows the failure toast — keep the input
    } finally {
      setPending(false)
    }
  }

  const newPage = () => {
    if (pending || busy) return
    onNewPage(title.trim())
  }

  const body = (
    <div
      ref={boxRef}
      role="dialog"
      aria-label={tr('day.dialogLabel', { date: dateTitle(date) })}
      data-testid="day-popover"
      className={
        sheet
          ? 'nd-sheet fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-app px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl'
          : 'nd-pop fixed z-50 w-72 rounded-lg border border-line bg-app p-3 shadow-xl'
      }
      style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {sheet && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" aria-hidden />}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{dateTitle(date)}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={tr('common.close')}
          className="flex h-7 w-7 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void addTask()
        }}
      >
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isMod(e)) {
              e.preventDefault()
              newPage()
            }
          }}
          placeholder={tr('day.placeholder')}
          aria-label={tr('day.titleLabel')}
          maxLength={300}
          className="w-full rounded-md border border-line bg-app px-2.5 py-2 text-sm text-ink outline-none placeholder:text-sub/70 focus-visible:border-accent max-sm:text-base"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {pending ? <Spinner size={14} /> : <CheckSquareIcon size={15} />}
            {tr('day.addTask')}
          </button>
          <button
            type="button"
            onClick={newPage}
            disabled={pending || busy}
            title={tr('day.newPageTitle', { shortcut: shortcut(MOD, 'Enter') })}
            className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-sm text-ink transition hover:bg-hover disabled:opacity-60"
          >
            <FileTextIcon size={15} />
            {tr('day.newPage')}
          </button>
        </div>
      </form>
      <p className="mt-1.5 text-[11px] leading-snug text-sub max-sm:hidden">
        {tr('day.keyHint', { shortcut: shortcut(MOD, 'Enter') })}
      </p>

      <div className="mt-2 border-t border-line pt-2">
        <button
          type="button"
          onClick={onOpenDaily}
          disabled={busy}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink hover:bg-hover disabled:opacity-60"
        >
          <CalendarDayIcon size={15} className="text-sub" />
          {hasDaily ? tr('day.openDaily') : tr('day.createDaily')}
        </button>
      </div>
    </div>
  )

  return createPortal(
    sheet ? (
      <>
        <div className="fixed inset-0 z-40 bg-black/30" aria-hidden />
        {body}
      </>
    ) : (
      body
    ),
    document.body,
  )
}
