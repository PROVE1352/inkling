import { useState } from 'react'
import { usePageSuspicious } from '../api'
import { tMaybe, useT } from '../i18n'
import { ChevronDownIcon, ChevronRightIcon } from './Icons'

// Warning for doc pages whose text matched a prompt-injection heuristic (GET /pages/:id/suspicious).
// Warning only: nothing is blocked, agents get the text marked as data, and it may be a false positive.
// Instruction pages (locked + designated) get the same warning.
export function SuspiciousNotice({ pageId }: { pageId: string }) {
  const t = useT()
  const q = usePageSuspicious(pageId)
  const [open, setOpen] = useState(false)
  const sections = q.data?.sections ?? []
  if (sections.length === 0) return null

  const scrollTo = (anchor: string) => {
    if (!anchor) return
    const el = document.querySelector(`[data-id="${CSS.escape(anchor)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-400">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t('suspicious.hint')}
        className="flex w-full items-center gap-1.5 text-left font-medium"
      >
        <span aria-hidden="true">⚠</span>
        <span className="min-w-0 flex-1">
          {t('suspicious.badge')} ({sections.length})
        </span>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 pb-1">
          <p className="text-sub">{t('suspicious.hint')}</p>
          <ul className="flex flex-col gap-0.5">
            {sections.map((s, i) => (
              <li key={`${s.anchor}-${i}`}>
                <button
                  type="button"
                  onClick={() => scrollTo(s.anchor)}
                  className="w-full rounded px-1 py-0.5 text-left hover:bg-amber-500/10"
                >
                  <span className="font-medium text-ink">{s.headingPath || t('suspicious.top')}</span>
                  <span className="text-sub">
                    {' · '}
                    {s.rules.map((r) => tMaybe(`suspicious.rule.${r}`) ?? r).join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
