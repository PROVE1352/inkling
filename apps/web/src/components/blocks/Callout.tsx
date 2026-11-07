import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { useT, type TKey } from '../../i18n'

// Callout custom block (M14) — colored/emoji highlight box + type switching.
// - props: type('note'|'tip'|'warning'|'danger'|'info'). content 'inline' (body is editable).
// - The server's default schema has no callout, so a stateToBlocks round trip drops it just like
//   pageEmbed/mention (no crash — unknown nodes are dropped safely). Lost in server .md/Notion
//   export (v1 limit).
// - toExternalHTML: falls back to a blockquote for client HTML copy/export so the text survives.

export type CalloutType = 'note' | 'tip' | 'warning' | 'danger' | 'info'

export const CALLOUT_TYPES: CalloutType[] = ['note', 'tip', 'warning', 'danger', 'info']

// Emoji, label key and accent color per type (hex saturated enough to color-mix in light and dark).
// Labels are i18n keys, translated at render time.
const CALLOUT_META: Record<CalloutType, { emoji: string; label: TKey; accent: string }> = {
  note: { emoji: '💡', label: 'callout.note', accent: '#3b82f6' },
  tip: { emoji: '✅', label: 'callout.tip', accent: '#22c55e' },
  warning: { emoji: '⚠️', label: 'callout.warning', accent: '#eab308' },
  danger: { emoji: '🛑', label: 'callout.danger', accent: '#ef4444' },
  info: { emoji: 'ℹ️', label: 'callout.info', accent: '#6b7280' },
}

function normalizeType(v: unknown): CalloutType {
  return (CALLOUT_TYPES as string[]).includes(v as string) ? (v as CalloutType) : 'note'
}

const calloutConfig = {
  type: 'callout' as const,
  propSchema: {
    type: { default: 'note' as const, values: CALLOUT_TYPES },
  },
  content: 'inline' as const,
} as const

// Left gutter: emoji button + type dropdown. contentEditable=false, so it is not editable content.
function TypeSwitcher({
  type,
  onPick,
}: {
  type: CalloutType
  onPick: (t: CalloutType) => void
}) {
  const tr = useT()
  const [open, setOpen] = useState(false)
  const meta = CALLOUT_META[type]

  return (
    <span className="relative shrink-0 leading-none" contentEditable={false}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={tr('callout.changeType')}
        title={tr('callout.typeTitle', { type: tr(meta.label) })}
        className="text-base leading-none transition-transform duration-100 hover:scale-110"
      >
        {meta.emoji}
      </button>
      {open && (
        <>
          {/* transparent backdrop so an outside click closes it */}
          <span
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <span className="nd-pop absolute left-0 top-full z-50 mt-1 flex w-32 flex-col overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
            {CALLOUT_TYPES.map((t) => {
              const m = CALLOUT_META[t]
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    onPick(t)
                    setOpen(false)
                  }}
                  className={`flex items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-hover ${
                    t === type ? 'text-ink' : 'text-sub'
                  }`}
                >
                  <span className="text-sm leading-none">{m.emoji}</span>
                  {tr(m.label)}
                </button>
              )
            })}
          </span>
        </>
      )}
    </span>
  )
}

export const calloutSpec = createReactBlockSpec(calloutConfig, {
  render: ({ block, editor, contentRef }) => {
    const type = normalizeType(block.props.type)
    const meta = CALLOUT_META[type]
    return (
      <div
        className="nd-callout"
        data-callout-type={type}
        style={{ '--nd-callout-accent': meta.accent } as React.CSSProperties}
      >
        <TypeSwitcher
          type={type}
          onPick={(t) =>
            editor.updateBlock(block, { type: 'callout', props: { type: t } })
          }
        />
        <div className="nd-callout-body" ref={contentRef} />
      </div>
    )
  },
  // blockquote fallback for HTML/copy outside the editor (inline content is filled via contentRef).
  toExternalHTML: ({ contentRef }) => <blockquote ref={contentRef} />,
})()
