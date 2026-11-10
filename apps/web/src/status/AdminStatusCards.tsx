import { ApiError } from '../api'
import { RefreshIcon } from '../components/Icons'
import { Spinner } from '../components/Spinner'
import { fmtDateTime, fmtNumber, fmtRelative, useT } from '../i18n'
import { useAdminStatus, useRecheckStatus, type AdminStatusDTO, type AgentUsage, type StatusGroup, type StatusItem, type StatusLevel } from './api'
import { fmtBytes, groupTitle, itemLabel, itemValue, problemText } from './text'

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

const compact = (n: number) => fmtNumber(n, { notation: 'compact', maximumFractionDigits: 1 })

/**
 * Optional semantic search (docs/adr/1744-*): shown only while the server has an embedding endpoint
 * configured. Counts, the model and the endpoint host; the API key never reaches the client.
 */
function SemanticSection({ s }: { s: NonNullable<AdminStatusDTO['semantic']> }) {
  const tr = useT()
  if (!('model' in s)) {
    return (
      <div className="mt-4 rounded-lg border border-line p-3" data-testid="status-semantic">
        <h3 className="text-sm font-semibold text-ink">{tr('adminStatus.semantic.title')}</h3>
        <p className="mt-1 text-xs text-sub">{tr('adminStatus.semantic.unavailable', { message: s.error })}</p>
      </div>
    )
  }
  return (
    <div className="mt-4 rounded-lg border border-line p-3" data-testid="status-semantic">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-semibold text-ink">{tr('adminStatus.semantic.title')}</h3>
        <span className="break-all text-xs text-sub">{tr('adminStatus.semantic.model', { model: s.model, endpoint: s.endpoint })}</span>
      </div>
      <p className="mt-1 text-xs text-sub">
        {tr('adminStatus.semantic.sections', { indexed: fmtNumber(s.sections.indexed), pending: fmtNumber(s.sections.pending) })}
        {s.chunks.rejected > 0 && ` · ${tr('adminStatus.semantic.rejected', { count: fmtNumber(s.chunks.rejected) })}`}
        {s.backoffUntil && ` · ${tr('adminStatus.semantic.backoff', { when: fmtDateTime(s.backoffUntil) })}`}
      </p>
      {s.lastError && (
        <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-400">
          {tr('adminStatus.semantic.error', { when: fmtRelative(Date.parse(s.lastError.at)), message: s.lastError.message })}
        </p>
      )}
    </div>
  )
}

/**
 * Agent connections and API tokens since the server started (docs/adr/1550-* .. 1552-*): totals,
 * the find_context cache, waiting changes_since calls and one row per connection. Numbers only.
 */
function AgentUsageSection({ a }: { a: AgentUsage }) {
  const tr = useT()
  const total = a.cache.hits + a.cache.misses
  const th = 'px-2 py-1 text-left font-medium text-sub'
  const td = 'px-2 py-1 tabular-nums'
  return (
    <div className="mt-4 rounded-lg border border-line p-3" data-testid="status-agents">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-semibold text-ink">{tr('adminStatus.agents.title')}</h3>
        <span className="text-xs text-sub">{tr('adminStatus.agents.since', { when: fmtDateTime(a.since) })}</span>
      </div>
      <p className="mt-1 text-xs text-sub">
        {[
          tr('adminStatus.agents.calls', { count: a.totals.calls }),
          tr('adminStatus.agents.tokens', { tokens: compact(a.totals.tokens) }),
          tr('adminStatus.agents.errors', { count: a.totals.errors }),
        ].join(' · ')}
        {' · '}
        {tr('adminStatus.agents.cache', { hits: fmtNumber(a.cache.hits), total: fmtNumber(total), entries: fmtNumber(a.cache.entries), size: fmtBytes(a.cache.bytes) })}
        {a.waiting > 0 && ` · ${tr('adminStatus.agents.waiting', { count: a.waiting })}`}
      </p>
      {a.connections.length === 0 ? (
        <p className="mt-2 text-xs text-sub">{tr('adminStatus.agents.empty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-t border-line text-xs sm:min-w-[560px]">
            <thead>
              <tr>
                <th className={th}>{tr('adminStatus.agents.col.name')}</th>
                <th className={`${th} text-right`}>{tr('adminStatus.agents.col.calls')}</th>
                <th className={`${th} text-right`}>{tr('adminStatus.agents.col.tokens')}</th>
                <th className={`${th} hidden text-right sm:table-cell`}>{tr('adminStatus.agents.col.errors')}</th>
                <th className={`${th} hidden text-right sm:table-cell`}>{tr('adminStatus.agents.col.cache')}</th>
                <th className={`${th} hidden text-right sm:table-cell`}>{tr('adminStatus.agents.col.latency')}</th>
                <th className={th}>{tr('adminStatus.agents.col.last')}</th>
              </tr>
            </thead>
            <tbody>
              {a.connections.map((c) => (
                <tr key={`${c.kind}:${c.id}`} className="border-t border-line">
                  <td className="max-w-[220px] px-2 py-1">
                    <div className="truncate text-ink">{c.name ?? tr('adminStatus.agents.revoked')}</div>
                    <div className="truncate text-sub">
                      {tr(`adminStatus.agents.kind.${c.kind}`)}
                      {c.user ? ` · ${c.user.name}` : ''}
                      {/* phones: the hidden columns' one number that needs attention */}
                      {c.errors > 0 && <span className="text-amber-700 sm:hidden dark:text-amber-400"> · {tr('adminStatus.agents.errors', { count: c.errors })}</span>}
                    </div>
                  </td>
                  <td className={`${td} text-right text-ink`}>{fmtNumber(c.calls)}</td>
                  <td className={`${td} text-right text-ink`}>{compact(c.tokens)}</td>
                  <td className={`${td} hidden text-right sm:table-cell ${c.errors ? 'text-amber-700 dark:text-amber-400' : 'text-sub'}`}>{fmtNumber(c.errors)}</td>
                  <td className={`${td} hidden text-right text-sub sm:table-cell`}>{fmtNumber(c.cacheHits)}</td>
                  <td className={`${td} hidden text-right text-sub sm:table-cell`}>
                    {c.avgMs} / {c.p95Ms} ms
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-sub" title={fmtDateTime(c.lastUsedAt)}>
                    {fmtRelative(c.lastUsedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.more > 0 && <p className="mt-1 text-[11px] text-sub">{tr('adminStatus.agents.more', { count: a.more })}</p>}
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
          {d.agents && <AgentUsageSection a={d.agents} />}
          {d.semantic && <SemanticSection s={d.semantic} />}
        </>
      )}
    </section>
  )
}
