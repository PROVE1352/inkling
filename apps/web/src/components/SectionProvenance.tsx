import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SectionProvenanceDTO } from '@inkling/shared'
import { fmtRelative, tMaybe, useT } from '../i18n'
import { markLabel, revertBlocker } from '../lib/sectionProvenance'
import { AgentIcon } from './Icons'

// Section marks (docs/adr/1627-*): who changed a section last, as a small sign at the start of the
// heading's marker line (SectionMarkers), and a small popover with what changed and "Revert this
// change". Plain sub-coloured text: an agent sign + client name, or a person's initials in a faint
// circle; no border, no accent colour, nothing drawn along the section.

export function ProvenanceMark({ item, onOpen }: { item: SectionProvenanceDTO; onOpen: (anchor: HTMLElement) => void }) {
  const t = useT()
  const l = markLabel(item)
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      title={l.title}
      aria-label={`${t('sectionMark.label')}: ${l.title}`}
      aria-haspopup="dialog"
      data-testid="section-provenance"
      data-kind={l.kind}
      // shrinks first on a narrow line (the suggestion badge keeps its size)
      className="flex min-w-0 shrink-[3] items-center gap-0.5 rounded px-0.5 py-0.5 text-[11px] leading-none text-sub transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {l.kind === 'agent' ? (
        <>
          <AgentIcon size={12} className="shrink-0" />
          <span className="min-w-0 max-w-[7rem] truncate">{l.short}</span>
        </>
      ) : (
        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-hover px-1 text-[9px] font-medium opacity-80">{l.short}</span>
      )}
    </button>
  )
}

const POP_W = 272

export function ProvenancePopover({
  item,
  anchorRect,
  canRevert,
  onRevert,
  onClose,
}: {
  item: SectionProvenanceDTO
  anchorRect: DOMRect
  /** The page is editable here (a read-only view shows what changed, no revert button). */
  canRevert: boolean
  onRevert: () => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Fixed to the viewport next to the mark, kept inside it (phones: never widens the page).
  useLayoutEffect(() => {
    const el = ref.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(POP_W, vw - 16)
    const h = el?.offsetHeight ?? 120
    const left = Math.max(8, Math.min(anchorRect.left, vw - w - 8))
    const below = anchorRect.bottom + 6
    const top = below + h > vh - 8 && anchorRect.top - 6 - h >= 8 ? anchorRect.top - 6 - h : below
    setPos({ top, left })
  }, [anchorRect])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // the popover is placed once: scrolling or resizing closes it instead of leaving it behind
    const onMove = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    // next tick, so the click that opened it does not close it
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      window.addEventListener('scroll', onMove, true)
      window.addEventListener('resize', onMove)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [onClose])

  const name = item.actor?.name ?? t('activity.someone')
  const when = fmtRelative(item.changedAt)
  const blocker = revertBlocker(item)
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t('sectionMark.label')}
      data-testid="section-provenance-popover"
      style={{ position: 'fixed', top: pos?.top ?? anchorRect.bottom + 6, left: pos?.left ?? 8, width: Math.min(POP_W, window.innerWidth - 16), visibility: pos ? 'visible' : 'hidden' }}
      className="nd-pop z-50 rounded-lg border border-line bg-app p-3 text-left text-xs shadow-xl"
    >
      <p className="leading-relaxed text-ink">
        {item.via ? t('sectionMark.lastVia', { when, name, client: item.via }) : t('sectionMark.last', { when, name })}
      </p>
      <p className="mt-1 flex min-w-0 items-baseline gap-1 text-[11px] text-sub">
        {item.headingPath && <span className="min-w-0 truncate">{item.headingPath}</span>}
        <span className="shrink-0">
          {item.headingPath ? '· ' : ''}
          {tMaybe(`activity.kind.${item.kind}`) ?? item.kind}
        </span>
        {item.isRevert && <span className="shrink-0">· {t('revert.badgeRevert')}</span>}
      </p>
      {blocker === 'reverted' && item.revertedBy ? (
        <p className="mt-2 text-[11px] text-sub">{t('sectionMark.revertedBy', { name: item.revertedBy.name, when: fmtRelative(item.revertedBy.at) })}</p>
      ) : blocker === 'moved' ? (
        <p className="mt-2 text-[11px] text-sub">{t('revert.reason.moved')}</p>
      ) : blocker === 'tooLarge' ? (
        <p className="mt-2 text-[11px] text-sub">{t('sectionMark.tooLarge')}</p>
      ) : canRevert ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onRevert}
            data-testid="section-provenance-revert"
            className="rounded-md px-2.5 py-1 text-xs text-accent transition duration-150 hover:bg-hover active:scale-[.98]"
          >
            {t('sectionMark.revert')}
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
