import { useState } from 'react'
import { useIcalStatus, useIssueIcal, useRevokeIcal } from '../lib/collectionApi'
import { askConfirm } from '../lib/confirm'
import { fmtDate, fmtDateTime, t } from '../i18n'

// UI strings — getters so each read follows the current language.
const T = {
  get title() { return t('ical.title') },
  get desc() { return t('ical.desc') },
  get create() { return t('ical.create') },
  get regenerate() { return t('ical.regenerate') },
  get revoke() { return t('ical.revoke') },
  get copy() { return t('common.copy') },
  get copied() { return t('common.copied') },
  get shownOnce() { return t('ical.shownOnce') },
  active: (d: string) => t('ical.active', { date: d }),
  lastUsed: (d: string) => t('ical.lastUsed', { date: d }),
  get inactive() { return t('ical.inactive') },
  get confirmRegenerate() { return t('ical.confirmRegenerate') },
}

/** Settings group: issue / regenerate / revoke the personal iCal feed URL. */
export function IcalSettings() {
  const status = useIcalStatus()
  const issue = useIssueIcal()
  const revoke = useRevokeIcal()
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const s = status.data

  const doIssue = async () => {
    if (s?.active && !(await askConfirm(T.confirmRegenerate, T.regenerate))) return
    issue.mutate(undefined, { onSuccess: (r) => setUrl(r.url) })
  }
  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked — the input is selectable
    }
  }
  const btn =
    'rounded-md border border-line px-2.5 py-1 text-sm text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50'

  return (
    <section className="mb-8">
      <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">{T.title}</h2>
      <div className="rounded-lg border border-line px-4 py-3">
        <p className="text-xs leading-relaxed text-sub">{T.desc}</p>
        <p className="mt-2 text-xs text-sub">
          {s?.active && s.createdAt
            ? T.active(fmtDate(s.createdAt)) + (s.lastUsedAt ? T.lastUsed(fmtDateTime(s.lastUsedAt)) : '')
            : T.inactive}
        </p>
        {url && (
          <div className="mt-2 flex flex-col gap-1">
            <div className="flex gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded border border-line bg-side/40 px-2 py-1 font-mono text-xs text-ink"
              />
              <button type="button" onClick={copy} className={btn}>
                {copied ? T.copied : T.copy}
              </button>
            </div>
            <p className="text-[11px] text-sub">{T.shownOnce}</p>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => void doIssue()} disabled={issue.isPending} className={btn}>
            {s?.active ? T.regenerate : T.create}
          </button>
          {s?.active && (
            <button
              type="button"
              onClick={() => revoke.mutate(undefined, { onSuccess: () => setUrl(null) })}
              disabled={revoke.isPending}
              className={`${btn} text-red-600`}
            >
              {T.revoke}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
