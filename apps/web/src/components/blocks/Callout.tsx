import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { CALLOUT_EMOJI, CALLOUT_TYPES, calloutConfig, type CalloutType } from '@inkling/shared'
import { useT, type TKey } from '../../i18n'

// Callout custom block (M14) — colored/emoji highlight box + type switching.
// - props: type('note'|'tip'|'warning'|'danger'|'info'). content 'inline' (body is editable).
// - The config is shared with the server schema (@inkling/shared, docs/adr/1500-*), so server reads
//   keep callouts and Markdown writes them as `> [!type] text`.
// - toExternalHTML: falls back to a blockquote for client HTML copy/export so the text survives.

export { CALLOUT_TYPES, type CalloutType }

// Label key per type (i18n keys, translated at render time). The emoji is shared with the server's HTML
// (CALLOUT_EMOJI) and the tint comes from index.css by data-callout-type, so the public page's callout,
// rendered on the server, looks the same (docs/adr/2387-*).
const CALLOUT_LABEL: Record<CalloutType, TKey> = {
  note: 'callout.note',
  tip: 'callout.tip',
  warning: 'callout.warning',
  danger: 'callout.danger',
  info: 'callout.info',
}

function normalizeType(v: unknown): CalloutType {
  return (CALLOUT_TYPES as string[]).includes(v as string) ? (v as CalloutType) : 'note'
}

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

  return (
    <span className="nd-callout-icon relative shrink-0 leading-none" contentEditable={false}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={tr('callout.changeType')}
        title={tr('callout.typeTitle', { type: tr(CALLOUT_LABEL[type]) })}
        className="text-base leading-none transition-transform duration-100 hover:scale-110"
      >
        {CALLOUT_EMOJI[type]}
      </button>
      {open && (
        <>
          {/* transparent backdrop so an outside click closes it */}
          <span
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <span className="nd-pop absolute left-0 top-full z-50 mt-1 flex w-32 origin-top-left flex-col overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
            {CALLOUT_TYPES.map((t) => {
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
                  <span className="text-sm leading-none">{CALLOUT_EMOJI[t]}</span>
                  {tr(CALLOUT_LABEL[t])}
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
    return (
      <div className="nd-callout" data-callout-type={type}>
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
