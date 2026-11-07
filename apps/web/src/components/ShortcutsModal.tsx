import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ALT, BACK_KEY, DEL, FORWARD_KEY, MOD, SHIFT, combo, isMac, modKey, shortcut } from '../lib/platform'
import { t, useT } from '../i18n'
import { XIcon } from './Icons'

type Row = { label: string; keys: string[]; hint?: string }
type Group = { title: string; rows: Row[] }

// All key labels come from the platform helpers — ⌘/⌫ on a Mac, Ctrl/Del elsewhere.
// The settings screen (shortcuts section) uses the same list, so editing it here updates both.
export const shortcutGroups = (): Group[] => [
  {
    title: t('shortcuts.groupGlobal'),
    rows: [
      { label: t('common.search'), keys: [modKey('K')] },
      { label: t('shortcuts.quickSwitcher'), keys: [modKey('O')] },
      { label: t('shortcuts.fullTextSearch'), keys: [combo(MOD, SHIFT, 'F')] },
      { label: t('shortcuts.commandPalette'), keys: [modKey('P')] },
      { label: t('shortcuts.newPage'), keys: isMac ? [modKey('N'), combo(MOD, ALT, 'N')] : [combo(MOD, ALT, 'N')] },
      { label: t('shortcuts.backForward'), keys: [BACK_KEY, FORWARD_KEY] },
      { label: t('shortcuts.graph'), keys: [modKey('G')] },
      { label: t('common.settings'), keys: [modKey(',')] },
      { label: t('shortcuts.toggleSidebar'), keys: [modKey('\\')] },
      {
        label: t('shortcuts.deleteToTrash'),
        keys: isMac ? [shortcut(MOD, DEL)] : [shortcut(MOD, DEL), 'Del'],
        hint: t('shortcuts.hintTreeSelection'),
      },
      { label: t('shortcuts.help'), keys: ['?'] },
    ],
  },
  {
    title: t('shortcuts.groupTree'),
    rows: [
      { label: t('shortcuts.moveUpDown'), keys: ['↑', '↓'] },
      { label: t('shortcuts.collapseExpand'), keys: ['←', '→'] },
      { label: t('shortcuts.openToggle'), keys: ['Enter'] },
      { label: t('common.rename'), keys: ['F2'] },
      { label: t('shortcuts.contextMenu'), keys: [t('shortcuts.rightClick')] },
    ],
  },
  {
    title: t('common.page'),
    rows: [
      { label: t('shortcuts.renameTitle'), keys: ['F2'], hint: t('shortcuts.hintOutsideTree') },
      { label: t('shortcuts.openProperties'), keys: [modKey(';')] },
    ],
  },
  {
    title: t('shortcuts.groupEditor'),
    rows: [
      { label: t('shortcuts.blockMenu'), keys: ['/'] },
      { label: t('shortcuts.bold'), keys: [modKey('B')] },
      { label: t('shortcuts.italic'), keys: [modKey('I')] },
      { label: t('shortcuts.toggleCheckbox'), keys: [modKey('L')] },
      { label: t('shortcuts.inlineMath'), keys: [combo(MOD, SHIFT, 'E'), '$…$'] },
      { label: t('shortcuts.deleteBlock'), keys: [modKey('D')] },
      { label: t('shortcuts.undo'), keys: [modKey('Z')] },
    ],
  },
]

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-line bg-side px-1.5 py-0.5 text-xs font-medium text-ink shadow-sm">
      {children}
    </kbd>
  )
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        className="nd-pop max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-app p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">{t('shortcuts.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {shortcutGroups().map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sub">
                {g.title}
              </div>
              <div className="flex flex-col gap-1.5">
                {g.rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink">
                      {r.label}
                      {r.hint && <span className="ml-1 text-xs text-sub">({r.hint})</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
