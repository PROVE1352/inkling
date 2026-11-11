import { useId } from 'react'
import { useT } from '../../i18n'
import { Markdown } from './LegalMarkdown'
import { DOC_PATH, type Legal } from './legalApi'

/**
 * The notice and the tick boxes of LEGAL_DIR's signup.json, shared by the sign-up form and the
 * consent screen (docs/adr/2519-*). Nothing is ticked in advance and there is no "agree to all":
 * each item is agreed to on its own. Every box has its own label; required ones say so in words, and
 * a missing required item is named in text (not only by colour).
 */
export function ConsentItems({
  legal,
  checked,
  onToggle,
  missingText,
}: {
  legal: Legal
  checked: ReadonlySet<string>
  onToggle: (id: string, on: boolean) => void
  /** Shown under the list while a required item is not ticked. */
  missingText: string
}) {
  const t = useT()
  const base = useId()
  const missing = legal.items.filter((i) => i.required && !checked.has(i.id))
  return (
    <div className="flex flex-col gap-3 break-keep" data-testid="legal-consent">
      {legal.notice && (
        <p role="note" className="rounded-md border border-accent bg-accent-soft px-3 py-2 text-sm font-semibold leading-relaxed text-ink">
          {legal.notice}
        </p>
      )}
      <fieldset className="flex min-w-0 flex-col gap-2.5">
        <legend className="mb-1 text-xs font-medium text-sub">{t('legal.itemsLegend')}</legend>
        {legal.items.map((item) => {
          const id = `${base}-${item.id}`
          const descId = item.details ? `${id}-details` : undefined
          return (
            <div key={item.id} className="flex min-w-0 flex-col gap-1">
              <div className="flex items-start gap-2">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked.has(item.id)}
                  onChange={(e) => onToggle(item.id, e.target.checked)}
                  aria-required={item.required || undefined}
                  aria-describedby={descId}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  data-consent-item={item.id}
                />
                <label htmlFor={id} className="min-w-0 text-xs leading-relaxed text-ink">
                  <span className={`mr-1 font-semibold ${item.required ? 'text-accent' : 'text-sub'}`}>
                    [{item.required ? t('legal.required') : t('legal.optional')}]
                  </span>
                  {item.label}
                </label>
              </div>
              {(item.doc || item.details) && (
                <div className="ml-6 flex min-w-0 flex-col gap-1">
                  {item.doc && (
                    <a href={DOC_PATH[item.doc]} target="_blank" rel="noopener" className="self-start text-xs text-accent hover:underline">
                      {t('legal.readFull', { doc: t(item.doc === 'terms' ? 'legal.terms' : 'legal.privacy') })}
                    </a>
                  )}
                  {item.details && (
                    <details id={descId} className="min-w-0 text-xs">
                      <summary className="cursor-pointer select-none text-sub hover:text-ink">{t('legal.details')}</summary>
                      <div className="mt-2">
                        <Markdown source={item.details} compact />
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </fieldset>
      {missing.length > 0 && (
        <p className="text-xs text-sub" aria-live="polite" data-testid="legal-missing">
          {missingText}
        </p>
      )}
    </div>
  )
}
