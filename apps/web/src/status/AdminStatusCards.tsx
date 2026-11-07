import { ApiError } from '../api'
import { RefreshIcon } from '../components/Icons'
import { Spinner } from '../components/Spinner'
import { fmtRelative, useT } from '../i18n'
import { useAdminStatus, useRecheckStatus, type StatusGroup, type StatusItem, type StatusLevel } from './api'
import { groupTitle, itemLabel, itemValue, problemText } from './text'

// Admin page, top: one card per area (backups, storage, app, security settings, updates) with its
// worst level, a one-line summary and the rows behind it (docs/adr/1230-*). Quiet when all is well:
// a small green dot and "All good"; grey rows are switched off and never raise the banner.

const dot: Record<StatusLevel, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  off: 'bg-sub/40',
}
const border: Record<StatusLevel, string> = {
  ok: 'border-line',
  warn: 'border-amber-500/40',
  error: 'border-red-500/50',
  off: 'border-line',
}
const valueCls: Record<StatusLevel, string> = {
  ok: 'text-ink',
  warn: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  off: 'text-sub',
}

function Row({ it }: { it: StatusItem }) {
  const tr = useT()
  const url = it.key === 'update.check' && typeof it.data.url === 'string' && it.data.available ? it.data.url : null
  return (
    <li className="flex items-start gap-2 py-0.5 text-xs" data-level={it.level}>
      <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${dot[it.level]}`} aria-hidden />
      <span className="w-28 shrink-0 text-sub">{itemLabel(it)}</span>
      <span className={`min-w-0 flex-1 break-words ${valueCls[it.level]}`}>
        {itemValue(it)}
        {url && (
          <>
            {' '}
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
              {tr('adminStatus.update.notes')}
            </a>
          </>
        )}
      </span>
    </li>
  )
}

function Card({ g }: { g: StatusGroup }) {
  const tr = useT()
  const summaryItem = g.summary ? g.items.find((i) => i.key === g.summary) : null
  const summary = summaryItem
    ? problemText(summaryItem)
    : g.level === 'off'
      ? tr('adminStatus.notChecked')
      : tr('adminStatus.allGood')
  return (
    <div className={`rounded-lg border ${border[g.level]} p-3`} data-testid={`status-card-${g.id}`} data-level={g.level}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot[g.level]}`} aria-hidden />
        <h3 className="text-sm font-semibold text-ink">{groupTitle(g.id)}</h3>
        <span className="sr-only">{tr(`adminStatus.level.${g.level}`)}</span>
      </div>
      <p className={`mt-1 text-xs ${g.level === 'ok' || g.level === 'off' ? 'text-sub' : valueCls[g.level]}`}>{summary}</p>
      <ul className="mt-2 border-t border-line pt-2">
        {g.items.map((it) => (
          <Row key={it.key} it={it} />
        ))}
      </ul>
    </div>
  )
}

export function AdminStatusCards() {
  const tr = useT()
  const q = useAdminStatus(true)
  const recheck = useRecheckStatus()
  const d = q.data
  return (
    <section className="mb-10" data-testid="admin-status">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {d && <span className={`h-2 w-2 rounded-full ${dot[d.level]}`} aria-hidden />}
          {tr('adminStatus.title')}
        </h2>
        {d && (
          <span className="text-xs text-sub">
            {d.level === 'ok' ? `${tr('adminStatus.allGood')} · ` : ''}
            {tr('adminStatus.checkedAt', { time: fmtRelative(Date.parse(d.generatedAt) - d.cache.ageSec * 1000) })}
          </span>
        )}
        <button
          type="button"
          onClick={() => void recheck.run().catch(() => {})}
          disabled={recheck.pending || q.isFetching}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50"
        >
          {recheck.pending ? <Spinner size={12} /> : <RefreshIcon size={12} />}
          {tr('adminStatus.recheck')}
        </button>
      </div>
      {q.isLoading && <Spinner />}
      {q.error && (
        <p className="text-xs text-red-600">{q.error instanceof ApiError ? q.error.message : tr('adminStatus.loadError')}</p>
      )}
      {d && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {d.groups.map((g) => (
              <Card key={g.id} g={g} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-sub">{tr('adminStatus.offHint')}</p>
        </>
      )}
    </section>
  )
}
