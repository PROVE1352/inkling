import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT, type TKey } from '../../i18n'

// Ink toolbar — fixed at the bottom of the screen (within reach on a tablet).
// It floats over the body, so it is portaled to body to avoid being clipped by the scroll
// container's overflow.

// Build marker shown so you can see on a tablet whether the PWA service worker is still serving
// an old bundle. Bump it with every ink-related deploy.
const INK_BUILD = 'v1109a'

export type InkToolChoice = 'pen' | 'highlighter' | 'eraser'

export interface InkSettings {
  tool: InkToolChoice
  color: string
  /** Pen width (px, in INK_CANVAS_WIDTH coordinates). The highlighter draws at 5× this value. */
  size: number
}

const COLORS = ['#ef4444', '#2563eb', '#111827', '#16a34a', '#eab308']
// `label` values are i18n keys, translated at render time.
const SIZES: { label: TKey; value: number }[] = [
  { label: 'ink.sizeThin', value: 2 },
  { label: 'ink.sizeMedium', value: 3.5 },
  { label: 'ink.sizeThick', value: 6 },
]

const TOOLS: { key: InkToolChoice; label: TKey; icon: string }[] = [
  { key: 'pen', label: 'ink.pen', icon: '✏️' },
  { key: 'highlighter', label: 'ink.highlighter', icon: '🖍' },
  { key: 'eraser', label: 'ink.eraser', icon: '🧽' },
]

export function InkToolbar({
  settings,
  onChange,
  onUndo,
  onClear,
  onClose,
  saving,
  strokeCount,
}: {
  settings: InkSettings
  onChange: (next: InkSettings) => void
  onUndo: () => void
  onClear: () => void
  onClose: () => void
  saving: boolean
  strokeCount: number
}) {
  const tr = useT()
  // "Clear" takes two presses (docs/adr/1340-*): the first arms it for a few seconds, the second clears.
  const [clearArmed, setClearArmed] = useState(false)
  useEffect(() => {
    if (!clearArmed) return
    const id = window.setTimeout(() => setClearArmed(false), 3000)
    return () => window.clearTimeout(id)
  }, [clearArmed])
  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1.5 text-sm transition duration-150 active:scale-[.98] ${
      active ? 'bg-accent text-white' : 'text-sub hover:bg-hover hover:text-ink'
    }`

  return createPortal(
    <div
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-app/95 px-2 py-1.5 shadow-lg backdrop-blur"
      // Keep pen input from leaking into the body while a tool is pressed.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange({ ...settings, tool: t.key })}
          aria-pressed={settings.tool === t.key}
          title={tr(t.label)}
          className={chip(settings.tool === t.key)}
        >
          <span aria-hidden>{t.icon}</span>
          <span className="sr-only">{tr(t.label)}</span>
        </button>
      ))}

      <span className="mx-1 h-5 w-px bg-line" />

      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange({ ...settings, color: c })}
          aria-label={tr('ink.color', { color: c })}
          aria-pressed={settings.color === c}
          className={`h-6 w-6 rounded-full border transition duration-150 active:scale-95 ${
            settings.color === c ? 'border-ink ring-2 ring-accent/50' : 'border-line'
          }`}
          style={{ background: c }}
        />
      ))}

      <span className="mx-1 h-5 w-px bg-line" />

      {SIZES.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange({ ...settings, size: s.value })}
          aria-pressed={settings.size === s.value}
          title={tr(s.label)}
          className={chip(settings.size === s.value)}
        >
          <span
            aria-hidden
            className="block rounded-full bg-current"
            style={{ width: 4 + s.value * 1.6, height: 4 + s.value * 1.6 }}
          />
          <span className="sr-only">{tr(s.label)}</span>
        </button>
      ))}

      <span className="mx-1 h-5 w-px bg-line" />

      <button type="button" onClick={onUndo} title={tr('ink.undo')} className={chip(false)}>
        ↩
      </button>
      <button
        type="button"
        onClick={() => {
          if (!clearArmed) {
            setClearArmed(true)
            return
          }
          setClearArmed(false)
          onClear()
        }}
        title={tr('ink.clearTitle')}
        disabled={strokeCount === 0}
        aria-pressed={clearArmed}
        className={`${clearArmed ? 'rounded-md bg-red-500 px-2.5 py-1.5 text-sm text-white transition duration-150 active:scale-[.98]' : chip(false)} disabled:opacity-40`}
      >
        {clearArmed ? tr('ink.clearConfirm') : tr('ink.clear')}
      </button>

      <span className="mx-1 h-5 w-px bg-line" />

      <span className="px-1 text-xs text-sub tabular-nums" aria-live="polite">
        {saving ? tr('common.saving') : tr('ink.strokes', { count: strokeCount })}
      </span>
      <span className="px-0.5 text-[10px] text-sub/60" title={tr('ink.build')}>
        {INK_BUILD}
      </span>
      <button
        type="button"
        onClick={onClose}
        title={tr('ink.exitTitle')}
        className={chip(false)}
      >
        {tr('common.done')}
      </button>
    </div>,
    document.body,
  )
}
