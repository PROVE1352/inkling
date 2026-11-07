import { useMemo } from 'react'
import type { DiffOpDTO } from '@inkling/shared'
import { diffIsEmpty, diffRows } from '../lib/diff'
import { useT } from '../i18n'

// Unified diff renderer shared by the activity screen and the history modal (docs/adr/1004-*).
// '-' rows are struck through on a red tint, '+' rows sit on a green tint, '=' rows are muted
// context; long unchanged runs fold into "… N" rows. With no edit script (too large), the
// before/after texts are shown side by side, or just a "large change" note.
export function DiffView({
  ops,
  large,
  before,
  after,
}: {
  ops: DiffOpDTO[] | null
  large?: boolean
  before?: string | null
  after?: string | null
}) {
  const t = useT()
  const rows = useMemo(() => (ops ? diffRows(ops) : null), [ops])

  if (!ops || !rows) {
    const hasTexts = (before ?? null) !== null || (after ?? null) !== null
    return (
      <div className="flex flex-col gap-3">
        {large !== false && <p className="text-xs text-sub">{t('diff.large')}</p>}
        {hasTexts && (
          <div className="grid gap-3 md:grid-cols-2">
            <SideText label={t('diff.before')} text={before ?? null} tone="del" />
            <SideText label={t('diff.after')} text={after ?? null} tone="add" />
          </div>
        )}
      </div>
    )
  }

  if (diffIsEmpty(ops)) return <p className="text-xs text-sub">{t('diff.same')}</p>

  return (
    <div
      className="overflow-x-auto rounded-md border border-line font-mono text-xs leading-relaxed"
      data-testid="diff-view"
    >
      {rows.map((r, i) =>
        r.t === 'skip' ? (
          <div key={i} className="select-none border-y border-line/60 bg-hover/40 px-3 py-0.5 text-[11px] text-sub">
            … {r.count}
          </div>
        ) : (
          <div
            key={i}
            className={`flex gap-2 px-2 ${
              r.t === '-'
                ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                : r.t === '+'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'text-sub'
            }`}
          >
            <span
              aria-label={r.t === '-' ? t('diff.removedLine') : r.t === '+' ? t('diff.addedLine') : undefined}
              className="w-3 shrink-0 select-none text-center opacity-70"
            >
              {r.t === '=' ? ' ' : r.t}
            </span>
            <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${r.t === '-' ? 'line-through' : ''}`}>
              {r.s || ' '}
            </span>
          </div>
        ),
      )}
    </div>
  )
}

function SideText({ label, text, tone }: { label: string; text: string | null; tone: 'del' | 'add' }) {
  const t = useT()
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{label}</div>
      <pre
        className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line px-3 py-2 text-xs leading-relaxed ${
          tone === 'del' ? 'bg-red-500/5' : 'bg-emerald-500/5'
        } text-ink`}
      >
        {text || t('diff.empty')}
      </pre>
    </div>
  )
}
