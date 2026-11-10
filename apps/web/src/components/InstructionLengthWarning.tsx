import { useT } from '../i18n'
import { isInstructionLong, roundTokens, type InstructionLength } from '../lib/instructionLength'

/**
 * "This instruction page is long" (docs/adr/2021-*). Renders nothing unless the server reported a length at or
 * over its threshold. `compact` is the one-line form for lists.
 */
export function InstructionLengthWarning({ length, compact = false }: { length: InstructionLength | null | undefined; compact?: boolean }) {
  const t = useT()
  if (!isInstructionLong(length)) return null
  const tokens = roundTokens(length.tokens).toLocaleString()
  if (compact) {
    return (
      <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400" data-testid="instruction-long-badge">
        {t('instructionLength.badge', { tokens })}
      </span>
    )
  }
  return (
    <div role="note" className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs" data-testid="instruction-long">
      <p className="font-medium text-amber-700 dark:text-amber-400">{t('instructionLength.title', { tokens })}</p>
      <p className="text-sub">{t('instructionLength.body')}</p>
    </div>
  )
}
